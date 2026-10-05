// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
// 本机助手（easysub-helper）客户端：探测 → 配对 → 从桌面端取 16 kHz PCM。
//
// 为什么需要它：系统音频在浏览器 API 里基本走不通——Chrome 的 getDisplayMedia 在 macOS/Linux
// 只有标签页音频、且每次开始都要选一次屏幕；Firefox 的 getDisplayMedia **根本不支持音频**；
// tabCapture 是 Chrome 独有。桌面助手用 OS 原生 API 采集（WASAPI loopback / PulseAudio
// monitor / macOS Core Audio tap），再把定长 20ms PCM 帧经 ws://127.0.0.1 推过来。
//
// 交互纪律（产品决定。**2026-10-05 用户澄清后修正过一次，别再按旧说法改回去**）：
//   ① **音源常驻显示**，介绍固定一句常态文案，不随启动/配对状态切换（早期"探测到才显示"已废弃：
//      用户实测在 Web 版里因此找不到这个音源，连怎么配对都无从下手）；
//   ② **没连上就不许开始**：能不能开始只看"有没有连上助手"，不看"有没有声音"——
//      · 助手没运行/没安装/探测不到 → 面板**拦住不启动**，弹说明框 + 下载链接；
//      · 探测到但**还没配对** → 弹配对框（首次要用配对码换设备令牌，配对码只显示在用户自己
//        启动的助手窗口里 = 用户在场的证明）；点「取消」= 放弃这次启动；
//      · 探测到、已配对、**助手窗口处于暂停** → **允许开始**（连着但没在采音频：页面收静音帧、
//        识别照常，用户在助手窗口点「启动」就直接出声）；
//      · 握手连不上（助手刚好退出/令牌失效）→ `never_connected` → **停掉**这场会话，
//        绝不留"看着在跑、其实永远没字幕"的空会话；
//      分界线就是"连上过没有"：连上过再掉线才降级成静音（下面 ④ 与 HELPER_SILENT_CODES）。
//   ③ 令牌存平台 storage（扩展=chrome.storage.local，Web=localStorage），
//      之后每次开始识别直接用，不再打扰用户；
//   ④ **助手窗口有总开关（默认暂停）**：暂停时不打开采集设备、只推全零帧保持流不断；
//      页面会收到 error{code:'paused'} —— 降级成 HELPER_SILENT 日志，提示用户点窗口里的
//      「启动」即可（server 会直接向已连客户端广播，无需重试），别当成故障。
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
  /**
   * 第二步（带 `?token=` 的复探）**是否真的拿到过答案**。
   *
   * 坑（独立审查抓的）：第二步是带令牌问"这个浏览器配过没有"，它可能瞬时失败（助手重启中、
   * 端口抖动），此时 `paired` 只能退回第一步的 false —— 调用方若据此判定"没配对"，
   * 已配好的浏览器会被要求重新配对。所以这里显式区分"助手说没配"与"没问出来"。
   */
  tokenChecked: boolean;
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

/**
 * 要探测的端口列表。`full=false`（默认）只扫开头几个，`full=true` 扫满 20 个（+ 记住的端口）。
 *
 * 坑：默认值必须与这里的文档一致（独立审查抓到签名写着 `full = true` 而文档说"默认 false"）。
 * 默认取 false 是有意的——裸调一次 `helperPorts()` 不该在本机刷出 21 条失败请求。
 * 两个调用方（面板 detectHelper 与 probeHelper）都**显式**传这个参数，所以改动不影响它们。
 */
export function helperPorts(preferred?: number, full = false): number[] {
  const out: number[] = [];
  if (preferred) out.push(preferred);
  const last = full ? HELPER_PORT_SCAN : HELPER_PROBE_QUICK_PORTS;
  for (let i = 0; i <= last; i++) out.push(HELPER_DEFAULT_PORT + i);
  return out.filter((p, idx) => out.indexOf(p) === idx);
}

export function helperBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * 哪些助手错误码属于**静音降级**（不是故障，别把会话连模型一起拆掉）。
 *
 * 规则（用户澄清后的原意）：判断的是"**有没有连上**"，不是"有没有声音"。
 *   * 没连上 → **不该开始**：面板那层直接拦（`!helperInfo` 弹说明框、未配对弹配对框），
 *     万一还是连不上（握手被拒），走 `never_connected` → ERROR 把会话停掉，绝不留一场
 *     "看着在跑、其实永远没字幕"的空会话。
 *   * 连上了但暂时没声音（助手窗口处于「暂停」）→ 静音降级，会话照常跑。
 *   * 连上过之后掉线（助手中途退出）→ 也保持静音降级，不拆会话（用户只是没声音）。
 *
 * 逐个说明：
 *   * `connect_failed` —— WebSocket 都没构造出来（端口非法 / CSP 拦了 ws://127.0.0.1）；
 *   * `ws_closed` —— **连上过**之后断开（助手中途退出）；
 *   * `paused` —— 助手窗口的总开关（**默认暂停**）：助手对 `start` 回 ERR_PAUSED；
 *   * `forbidden` / `not_paired` —— 令牌没被接受：页面需要重新配对，但会话本身照常跑，
 *     把它当 ERROR 会平白拆掉一整场。**注意（独立审查实测）：坏令牌时助手是在握手层回
 *     HTTP 403，浏览器只给 onclose，页面实际看到的是"从没连上"→ `never_connected`；这两个码
 *     只可能出现在 `/api/pair` 的响应里**，列进来是防御未来协议变化。
 */
const HELPER_SILENT_CODES = ('connect_failed,ws_closed,paused,forbidden,not_paired').split(',');

export function isHelperSilentCode(code?: string): boolean {
  return !!code && HELPER_SILENT_CODES.indexOf(code) >= 0;
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
/**
 * 探测**单个**端口，分两步：
 *   ① 不带令牌问一次，确认"这确实是助手"（`/api/pair/info` 本就不需要鉴权）；
 *   ② 确认之后**才**带 `?token=` 复探，拿这个浏览器是否配过的准确答案。
 *
 * 为什么要分两步：探测会扫最多 21 个端口，若一上来就带令牌，本机任意占用这些端口的进程
 * 都能拿到"可以换本机音频流"的令牌 —— 暴露面从 1 个端口扩到 21 个。
 * 令牌走 query 而非 `X-Easysub-Token` 头：query 是"简单请求"不触发 CORS 预检，
 * 而助手的 /api/pair/info 没有预检处理（自定义头会被浏览器直接拦掉）。
 */
async function probePort(port: number, token?: string): Promise<HelperInfo | null> {
  const url = `${helperBaseUrl(port)}/api/pair/info`;
  const first = await fetchJson(url, undefined, PROBE_TIMEOUT_MS).catch(() => null);
  // /api/pair/info 无鉴权且必定 200；拿到 __status 说明被拒（CORS/其它服务），不算助手
  if (!first || first.__status || first.app !== 'easysub-helper') return null;
  let data = first;
  let tokenChecked = false;
  if (token) {
    const withToken = await fetchJson(`${url}?token=${encodeURIComponent(token)}`, undefined,
      PROBE_TIMEOUT_MS).catch(() => null);
    if (withToken && !withToken.__status) {
      data = withToken;
      tokenChecked = true;              // 只有真的问出来了才敢说"助手答了"
    }
  }
  return {
    port,
    version: String(data.version || ''),
    paired: data.paired === true,
    tokenChecked,
    paused: data.paused === true,
    lang: String(data.lang || ''),
    platform: String(data.platform || ''),
  };
}

export async function probeHelper(opts: { full?: boolean; token?: string } = {}): Promise<HelperInfo | null> {
  const ports = helperPorts(await storedPort(), opts.full === true);
  // 带令牌探测是**必须**的：助手侧 `paired` 的语义是"本次请求带的令牌是否有效"
  // （server.py handle_pair_info + _token_from_request），不带令牌恒为 false —— 那样每次打开
  // 面板都会被当成"没配对过"，逼用户重输配对码，"只配一次"的承诺直接失效。
  const results = await Promise.all(ports.map((port) => probePort(port, opts.token)));
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
    // 坑（独立审查抓的）：空串 token 也算"没有会话"。否则 storage 里留了个 `token: ""` 时，
    // 第二步复探必然问不出答案（tokenChecked=false）→ 上层按"瞬时失败"保留这条死会话 →
    // 永远静音、而且连配对框都不弹，用户完全没有出路。
    if (!s || typeof s.token !== 'string' || !s.token || typeof s.port !== 'number' || !s.port) {
      return null;
    }
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
    // pairHelper 连不上助手时返回的哨兵码（message 为空）——给一句人话，别把 failed 抛给用户
    case 'failed': return 'helperPairErrNetwork';
    // 助手现在发 code_expired；`expired` 是旧版本发的，留着兜底
    case 'code_expired':
    case 'expired': return 'helperPairErrExpired';
    case 'locked': return 'helperPairErrLocked';
    case 'no_code': return 'helperPairErrNoCode';
    // 助手窗口的「启动/暂停」总开关处于暂停（默认）：不是错误，是等用户去按启动
    case 'paused': return 'helperPaused';
    default: return 'helperPairErrGeneric';
  }
}

//: 配对阶段才会出现的 code；其它（capture_failed / backend_unavailable / resample_unavailable …）
//: 都是**运行期**错误，不能再套"配对失败"的文案 —— 那会把用户引去重新配对。
const PAIRING_CODES = ['bad_code', 'code_expired', 'expired', 'locked', 'no_code',
                       'failed', 'forbidden', 'not_paired'];

export function helperErrorMessage(code: string, fallback: string, lang: string): string {
  const language = lang || 'zh_CN';
  if (code !== 'paused' && PAIRING_CODES.indexOf(code) < 0) {
    // 运行期错误：用通用的「错误：{m}」，让助手给的 message 说话
    return tSync(language, 'errorPrefix').replace('{m}', fallback || code);
  }
  const key = helperErrorKey(code);
  const text = tSync(language, key);
  if (text.indexOf('{m}') >= 0) return text.replace('{m}', fallback || '');
  return text || fallback || '';
}

export interface HelperSourceOptions {
  port: number;
  token: string;
  source?: 'system' | 'mic';
  /** PCM 交给宿主（宿主再喂 engine.feedMicChunk）——**唯一的音频出口** */
  onPcm: (samples: Float32Array, sampleRate: number) => void;
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
  /** 这次连接是否**真的建立过**（onopen 过的）。用来区分"启动失败"与"运行中掉线"。 */
  private opened = false;
  private sampleRate = HELPER_SAMPLE_RATE;

  constructor(opts: HelperSourceOptions) {
    this.opts = { source: 'system', ...opts };
  }

  start(): void {
    if (this.ws) return;
    this.stopping = false;
    this.log(`连接桌面助手 127.0.0.1:${this.opts.port}`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(helperWsUrl(this.opts.port, this.opts.token));
    } catch (e: any) {
      // 坑：这里**不能**把浏览器给的原始异常串当提示——Chrome 这类消息通常内嵌完整 URL
      // （含 `?token=`），会被面板日志原样记下来（独立审查指出）。所以 UI 走本地化文案，
      // 控制台也只留异常**名字**（连名字都别带 URL）。
      console.log('[桌面助手] WebSocket 构造失败:', e?.name || 'Error');
      this.opts.onError?.(tSync(this.opts.lang || 'zh_CN', 'helperConnectFailed'), 'connect_failed');
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.opened = true;
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
      if (this.stopping) return;
      // 坑（用户澄清的规则："没连上就不该开始"）：**从没连上过**与"连上后断了"必须分开——
      //   * 从没连上（握手被拒/助手刚退出）：它就是一次失败的启动，必须走 ERROR 把会话停掉，
      //     否则页面看着在跑、其实一句字幕都不会有（用户抱怨的就是这个）；
      //   * 连上过再断（助手中途退出）：保持静音降级，不拆会话（决定 3）。
      // 协议里握手相关的两个码不是静音码，所以 ERROR 分支会收敛掉这场会话。
      if (!this.opened) {
        this.opts.onError?.(tSync(this.opts.lang || 'zh_CN', 'helperNeverConnected'), 'never_connected');
        return;
      }
      // 非主动关闭：明确告诉用户，别让它变成"界面在跑、永远没字幕"的幽灵会话
      this.opts.onError?.(tSync(this.opts.lang || 'zh_CN', 'helperWsClosed'), 'ws_closed');
    };
  }

  stop(): void {
    this.stopping = true;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try { ws.send(JSON.stringify({ type: 'stop' })); } catch { /* 已断开 */ }
    try { ws.close(); } catch { /* 同上 */ }
  }

  private handleMessage(ev: MessageEvent): void {
    const data = ev.data;
    if (typeof data === 'string') {
      let msg: any = null;
      try { msg = JSON.parse(data); } catch { return; }
      switch (msg?.type) {
        case 'hello':
          this.sampleRate = Number(msg.sampleRate) || HELPER_SAMPLE_RATE;
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
