// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
// 本机助手（easysub-helper）客户端：探测 → 配对 → 从桌面端取 16 kHz PCM。
//
// 为什么需要它：系统音频在浏览器 API 里基本走不通——Chrome 的 getDisplayMedia 在 macOS/Linux
// 只有标签页音频、且每次开始都要选一次屏幕；Firefox 的 getDisplayMedia **根本不支持音频**；
// tabCapture 是 Chrome 独有。桌面助手用 OS 原生 API 采集（WASAPI loopback / PulseAudio
// monitor / macOS Core Audio tap），再把定长 20ms PCM 帧经 ws://127.0.0.1 推过来。
//
// 交互纪律（产品要求，别改）：
//   ① **先探测**：`probeHelper()` 成功才把「桌面助手」这个音源显示出来；
//   ② **配对后才可用**：助手会把本机音频交给任何连上来的页面，所以首次必须用配对码
//      换取设备令牌（配对码只显示在用户自己启动助手的终端里 = 用户在场的证明）；
//   ③ 令牌存平台 storage（扩展=chrome.storage.local，Web=localStorage），
//      之后每次开始识别直接用，不再打扰用户；
//   ④ **助手窗口有总开关（默认暂停）**：暂停时助手不打开采集设备，只推全零帧保持流不断，
//      页面会收到 error{code:'paused'} —— 这时要提示用户去助手窗口点「启动」，别当成故障。
import { storage } from './platform';
// 坑：i18n 的 getLang() 是异步的，而 WS 的错误回调是同步路径——所以语言由宿主显式传进来
// （面板有 currentLang，offscreen 有 INIT 带来的 lang），这里绝不自己去 await。
import { tSync } from './i18n';

// 与 easysub-helper 的 config.PORT_SCAN_RANGE 对齐：默认端口被占时助手会自动顺延
export const HELPER_DEFAULT_PORT = 8790;
export const HELPER_PORT_SCAN = 20;
//: 面板打开时只探前几个端口：助手默认就在 8790，不必为"漂移"在控制台刷 20 条失败请求
//: （用户实测吐槽过）。完整扫描留给"用户主动选了这个音源 / 点了开始"的时刻。
export const HELPER_PROBE_QUICK_PORTS = 2;
export const HELPER_SAMPLE_RATE = 16000;
//: 助手仓库的 Releases 页：面板切到「桌面助手」音源时会把地址附在提示里
//: （还没装助手 / 想更新的人可以直接点过去）。助手是独立仓库。
export const HELPER_RELEASES_URL = 'https://github.com/easysub-org/easysub-helper/releases';

const SESSION_KEY = 'helperSession';
const PROBE_TIMEOUT_MS = 700;
const PAIR_TIMEOUT_MS = 4000;

export interface HelperInfo {
  port: number;
  version: string;
  paired: boolean;
  /** 助手窗口的总开关是否处于暂停（默认暂停）：暂停时助手不采音频，只推静音帧 */
  paused: boolean;
  lang: string;
  platform: string;
}

export interface HelperSession {
  port: number;
  token: string;
  label?: string;
  pairedAt?: number;
}

export interface PairFailure {
  ok: false;
  code: string;
  message: string;
}

export interface PairSuccess {
  ok: true;
  token: string;
  label: string;
}

export function helperPorts(preferred?: number, full = true): number[] {
  const out: number[] = [];
  if (preferred) out.push(preferred);
  const last = full ? HELPER_PORT_SCAN : HELPER_PROBE_QUICK_PORTS;
  for (let i = 0; i <= last; i++) out.push(HELPER_DEFAULT_PORT + i);
  return out.filter((p, idx) => out.indexOf(p) === idx);
}

export function helperBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

// 令牌放 query：WS 与 fetch 都能用同一种方式带（助手同时支持 X-Easysub-Token 头）
export function helperWsUrl(port: number, token: string): string {
  return `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;
}

async function fetchJson(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<any | null> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined, ...(init || {}) });
    if (!res.ok) {
      // 403/429 也是"助手在"的证据：把 body 带回去，调用方才能区分"没配对"与"配对码错"
      let body: any = null;
      try { body = await res.json(); } catch { /* 非 JSON 就当没有 */ }
      return { __status: res.status, __body: body };
    }
    return await res.json();
  } catch {
    return null;   // 连接失败/超时/被 CORS 拦：一律当"这个端口上没有助手"
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 读回上次成功的端口，让探测先打这一个（命中时只发一个请求）
async function storedPort(): Promise<number | undefined> {
  try {
    const r = await storage.get(SESSION_KEY);
    const s = r?.[SESSION_KEY];
    return s && typeof s.port === 'number' ? s.port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 探测本机助手。**并行**打候选端口、取最先成功的一个——
 * 串行 21 个端口在"没有助手"时要等十几秒，面板初始化不能这么慢。
 *
 * `full=false`（默认）只探"记住的端口 + 8790/8791/8792"：面板一打开就扫 21 个端口，
 * 助手刚好没开时会在控制台刷一片 ERR_CONNECTION_REFUSED（用户实测吐槽过）。
 * 用户主动选「桌面助手」或点「开始」时用 `full=true`，这时才值得为端口漂移找一遍。
 */
export async function probeHelper(opts: { full?: boolean } = {}): Promise<HelperInfo | null> {
  const ports = helperPorts(await storedPort(), opts.full === true);
  const attempts = ports.map((port) =>
    fetchJson(`${helperBaseUrl(port)}/api/pair/info`, undefined, PROBE_TIMEOUT_MS)
      .then((data): HelperInfo | null => {
        // /api/pair/info 无鉴权且必定 200；拿到 __status 说明被拒（CORS/其它服务），不算助手
        if (!data || data.__status || data.app !== 'easysub-helper') return null;
        return {
          port,
          version: String(data.version || ''),
          paired: data.paired === true,
          paused: data.paused === true,
          lang: String(data.lang || ''),
          platform: String(data.platform || ''),
        };
      })
      .catch(() => null),
  );
  const results = await Promise.all(attempts);
  const found = results.filter((x): x is HelperInfo => !!x);
  if (!found.length) return null;
  // 优先"已配对"的那一个（多开助手/换端口时更符合用户预期）
  found.sort((a, b) => Number(b.paired) - Number(a.paired));
  return found[0];
}

export async function loadHelperSession(): Promise<HelperSession | null> {
  try {
    const r = await storage.get(SESSION_KEY);
    const s = r?.[SESSION_KEY];
    if (!s || typeof s.token !== 'string' || typeof s.port !== 'number') return null;
    return { port: s.port, token: s.token, label: s.label, pairedAt: s.pairedAt };
  } catch {
    return null;
  }
}

export async function saveHelperSession(session: HelperSession): Promise<void> {
  await storage.set({ [SESSION_KEY]: session });
}

export async function clearHelperSession(): Promise<void> {
  await storage.remove(SESSION_KEY);
}

export async function pairHelper(port: number, code: string, label?: string): Promise<PairSuccess | PairFailure> {
  const data = await fetchJson(`${helperBaseUrl(port)}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, label: (label || navigator.userAgent || 'browser').slice(0, 80) }),
  }, PAIR_TIMEOUT_MS);
  if (data && data.ok && typeof data.token === 'string') {
    return { ok: true, token: data.token, label: String(data.label || '') };
  }
  const body = (data && data.__body) || {};
  return {
    ok: false,
    code: String(body.code || 'failed'),
    message: String(body.message || ''),
  };
}


export function helperErrorKey(code: string): string {
  switch (code) {
    case 'bad_code': return 'helperPairErrBadCode';
    case 'code_expired': return 'helperPairErrExpired';
    case 'locked': return 'helperPairErrLocked';
    case 'no_code': return 'helperPairErrNoCode';
    // 助手窗口的「启动/暂停」总开关处于暂停（默认）：不是错误，是等用户去按启动
    case 'paused': return 'helperPaused';
    default: return 'helperPairErrGeneric';
  }
}

export function helperErrorMessage(code: string, fallback: string, lang: string): string {
  const key = helperErrorKey(code);
  const text = tSync(lang || 'zh_CN', key);
  if (text.indexOf('{m}') >= 0) return text.replace('{m}', fallback || '');
  return text || fallback || '';
}

export interface HelperSourceOptions {
  port: number;
  token: string;
  source?: 'system' | 'mic';
  onPcm: (samples: Float32Array, sampleRate: number) => void;
  onLevel?: (rms: number, peak: number) => void;
  onState?: (capturing: boolean, info?: any) => void;
  onError?: (message: string, code?: string) => void;
  log?: (message: string) => void;
  /** 错误文案语言（宿主显式给；i18n 的 getLang 是异步的，同步回调里用不了） */
  lang?: string;
}

/**
 * 助手音频源：连 WS、收裸 PCM 帧，直接交给引擎的 feedMicChunk。
 *
 * 帧契约（助手侧 protocol.py 声明）：**裸 f32le、单声道、16 kHz、20 ms = 320 样本 = 1280 字节**，
 * 定长无包头 —— 所以这里不需要缓冲或重排，收到就能喂。
 */
export class HelperSource {
  private opts: HelperSourceOptions;
  private ws: WebSocket | null = null;
  private stopping = false;
  private sampleRate = HELPER_SAMPLE_RATE;

  constructor(opts: HelperSourceOptions) {
    this.opts = { source: 'system', ...opts };
  }

  get running(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (this.ws) return;
    this.stopping = false;
    this.log(`连接桌面助手 127.0.0.1:${this.opts.port}`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(helperWsUrl(this.opts.port, this.opts.token));
    } catch (e: any) {
      this.opts.onError?.(String(e?.message || e), 'connect_failed');
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.log('已连接，请求开始采集');
      try {
        ws.send(JSON.stringify({ type: 'start', source: this.opts.source || 'system' }));
      } catch { /* 刚打开就断开：下面的 onclose 会报错 */ }
    };
    ws.onmessage = (ev) => this.handleMessage(ev);
    ws.onerror = () => {
      // onerror 之后一定会有 onclose，报错统一放 onclose，避免重复弹两次
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.stopping) {
        this.opts.onState?.(false);
        return;
      }
      // 非主动关闭：明确告诉用户，别让它变成"界面在跑、永远没字幕"的幽灵会话
      this.opts.onError?.(tSync(this.opts.lang || 'zh_CN', 'helperWsClosed'), 'ws_closed');
      this.opts.onState?.(false);
    };
  }

  stop(): void {
    this.stopping = true;
    const ws = this.ws;
    this.ws = null;
    if (!ws) {
      this.opts.onState?.(false);
      return;
    }
    try { ws.send(JSON.stringify({ type: 'stop' })); } catch { /* 已断开 */ }
    try { ws.close(); } catch { /* 同上 */ }
    this.opts.onState?.(false);
  }

  private handleMessage(ev: MessageEvent): void {
    const data = ev.data;
    if (typeof data === 'string') {
      let msg: any = null;
      try { msg = JSON.parse(data); } catch { return; }
      switch (msg?.type) {
        case 'hello':
          this.sampleRate = Number(msg.sampleRate) || HELPER_SAMPLE_RATE;
          this.opts.onState?.(msg.capturing === true, msg);
          break;
        case 'state':
          this.opts.onState?.(msg.capturing === true, msg);
          break;
        case 'level':
          this.opts.onLevel?.(Number(msg.rms) || 0, Number(msg.peak) || 0);
          break;
        case 'error': {
          // 优先用页面自己的 i18n 按稳定 code 渲染（助手带的 message 是桌面端语言的兜底）。
          // 例：助手窗口处于暂停 → code='paused' → 页面按自己的语言说"去助手窗口点启动"。
          const code = String(msg.code || 'error');
          this.opts.onError?.(helperErrorMessage(code, String(msg.message || ''), this.opts.lang || 'zh_CN'), code);
          break;
        }
        default:
          break;
      }
      return;
    }
    if (data instanceof ArrayBuffer) {
      if (data.byteLength % 4 !== 0) return;      // f32le 帧长必须是 4 的倍数，坏帧直接丢
      const f32 = new Float32Array(data);
      if (!f32.length) return;
      this.opts.onPcm(f32, this.sampleRate);
      return;
    }
    // 其它（Blob 等）：正常路径不该出现，留痕便于排障
    this.log('收到非预期帧类型: ' + Object.prototype.toString.call(data));
  }

  private log(message: string): void {
    this.opts.log?.(`[桌面助手] ${message}`);
  }
}
