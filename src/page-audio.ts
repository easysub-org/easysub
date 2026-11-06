// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
//
// 页面媒体采音（**内容脚本**，按需注入；只在扩展端使用，Web 版没有这个音源）。
//
// 为什么需要它：手机/平板的扩展平台没有 `tabCapture`（Edge 官方 API 支持表：仅
// Windows/Linux/Mac），而 `getDisplayMedia` 的音频轨在移动端一律不可用 —— 于是"采集
// 当前标签页的声音"只剩一条路：**直接从页面里的 <video>/<audio> 取音频**。
//
// 成熟做法照抄 vantezzen/skip-silence（MIT，470★，生产环境验证过）：
//   ① 用**捕获阶段**的媒体事件监听 document：媒体事件不冒泡、但能捕获，动态插入的元素
//      也能覆盖，不需要 MutationObserver；
//   ② `createMediaElementSource()` 对每个元素**只能调用一次**（永久改道），所以按元素
//      缓存音频图（WeakMap）；
//   ③ AudioWorklet 从 web_accessible_resources 加载，跑在音频线程 —— 切到别的标签页、
//      计时器被节流时仍按 128 帧稳定回调，不会断流。
//
// 与 skip-silence 的差别：它的 worklet 只回报 RMS（用来跳静音）；我们的 worklet 把 PCM
// 分帧回传，经 background 转投 offscreen 里的识别引擎（16k 重采样在引擎侧做）。
//
// 覆盖边界（会在面板提示里写明）：
//   ✓ 普通 <video>/<audio>、MSE/blob 播放器（B 站/YouTube 网页）、同源 iframe
//   ✗ DRM/EME（静音）、跨域且无 CORS 的媒体（静音）、跨域 iframe、纯 WebAudio 播放器

interface PageAudioGraph { node: AudioWorkletNode }

const INSTANCE_KEY = '__easysubPageAudio';
const DIAG_SILENCE_AFTER_CHUNKS = 12;

interface PageAudioState {
  running: boolean;
  port: chrome.runtime.Port | null;
  ctx: AudioContext | null;
  workletReady: boolean;
  graphs: WeakMap<HTMLMediaElement, PageAudioGraph>;
  elements: Set<HTMLMediaElement>;
  /** 混音总线 + 唯一的 worklet 节点（所有媒体元素汇到这里，避免多节点交错/多份 worklet）。 */
  mix: GainNode | null;
  tap: AudioWorkletNode | null;
  chunks: number;
  silentChunks: number;
  silenceReported: boolean;
  suspendedReported: boolean;
  listenersBound: boolean;
}

function createState(): PageAudioState {
  return {
    running: false,
    port: null,
    ctx: null,
    workletReady: false,
    graphs: new WeakMap(),
    elements: new Set(),
    mix: null,
    tap: null,
    chunks: 0,
    silentChunks: 0,
    silenceReported: false,
    suspendedReported: false,
    listenersBound: false,
  };
}

const state: PageAudioState = ((window as any)[INSTANCE_KEY] as PageAudioState | undefined)
  ?? createState();
(window as any)[INSTANCE_KEY] = state;

function diag(text: string): void {
  try { state.port?.postMessage({ type: 'PAGE_AUDIO_DIAG', text }); } catch { /* 端口已断，忽略 */ }
}

/**
 * 本帧值不值得采集：只采**顶层帧**与**同源子帧**。
 * 内容脚本会被注入到所有帧（含广告等跨域 iframe），那些帧里的 <video>/<audio>
 * 与当前页面无关，混进识别管道只会产生噪声。
 */
function frameIsRelevant(): boolean {
  if (window.top === window) return true;
  try {
    // 同源子帧：能读到 top.location.origin；跨域会抛 SecurityError
    return window.top!.location.origin === location.origin;
  } catch {
    return false;
  }
}

async function ensureContext(): Promise<AudioContext | null> {
  if (state.ctx) {
    // 无用户手势创建/被浏览器挂起时可能是 suspended：在 media 事件里尽力恢复一次
    if (state.ctx.state === 'suspended') void state.ctx.resume().catch(() => {});
    return state.ctx;
  }
  try {
    const ctx = new AudioContext();
    state.ctx = ctx;
    // worklet 走 web_accessible_resources（见 manifest），必须用扩展 URL 加载
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('page-audio-worklet.js'));
    state.workletReady = true;
    // 混音总线 + 唯一 worklet：位置与生命周期与 ctx 绑定（**只建一次**，stop 时不销毁）
    const mix = ctx.createGain();
    const tap = new AudioWorkletNode(ctx, 'page-audio-tap', { processorOptions: { frameSamples: 2048 } });
    mix.connect(tap);
    tap.connect(ctx.destination);   // 旁路：用户照常听见声音
    tap.port.onmessage = onFrame;
    state.mix = mix;
    state.tap = tap;
    diag(`worklet=ok ctx=${ctx.state} sr=${ctx.sampleRate}`);
    return ctx;
  } catch (e: any) {
    state.workletReady = false;
    diag(`worklet 启动失败: ${e?.message || e}`);
    return null;
  }
}

function onFrame(e: MessageEvent): void {
  const data = e.data as { samples?: Float32Array; rms?: number } | undefined;
  if (!data?.samples || !state.running || !state.port) return;
  state.chunks += 1;
  const rms = typeof data.rms === 'number' ? data.rms : 0;
  if (rms < 1e-4) state.silentChunks += 1;
  // 诊断：静音或 ctx 被挂起时只报一次，避免刷屏（真机排查全靠这几行）
  if (!state.silenceReported && state.chunks >= DIAG_SILENCE_AFTER_CHUNKS && state.silentChunks >= state.chunks - 1) {
    state.silenceReported = true;
    diag(`rms≈0（已收 ${state.chunks} 帧）：可能是 DRM/跨域媒体，浏览器不给音频数据`);
  }
  if (!state.suspendedReported && state.ctx?.state === 'suspended') {
    state.suspendedReported = true;
    diag('ctx=suspended（浏览器暂停了 AudioContext）：请再点一次播放/开始');
    void state.ctx.resume().catch(() => {});
  }
  try {
    state.port.postMessage({
      type: 'PAGE_AUDIO_CHUNK',
      audio: Array.from(data.samples),   // Port/消息都走结构化克隆，转数组最稳（同 MIC_CHUNK）
      sampleRate: state.ctx?.sampleRate || 48000,
      // 采集时刻（墙钟）：引擎侧用它算"从取出这一帧到进识别管道"的真实延迟，
      // 供字幕层右下角的延迟指示灯显示（这条链路没有 MediaStream，算不出 RTT）。
      ts: Date.now(),
    });
  } catch { /* 端口断开（会话结束/扩展重载）→ 下一次 stop 会清理 */ }
}

async function attach(el: HTMLMediaElement): Promise<void> {
  if (!state.running || state.graphs.has(el)) return;
  const ctx = await ensureContext();
  if (!ctx || !state.workletReady || state.graphs.has(el)) return;
  try {
    const source = ctx.createMediaElementSource(el);
    // 所有元素汇入**同一条混音总线** → 唯一的 worklet → destination：
    // ① 多元素不会各自发帧、互相交错；② 只跑一份 worklet；
    // ③ 旁路接回 destination（经 worklet 透传），用户照常听见声音。
    if (!state.mix || !state.tap) throw new Error('音频总线未就绪');
    source.connect(state.mix);
    state.graphs.set(el, { node: state.tap });
    state.elements.add(el);
    diag(`已接入媒体元素（累计 ${state.elements.size}）`);
  } catch (e: any) {
    // 常见原因：该元素已被别处 createMediaElementSource 过（每元素只能一次）
    diag(`接入媒体元素失败: ${e?.message || e}`);
  }
}

function scan(): void {
  if (!state.running) return;
  if (!frameIsRelevant()) return;   // 跨域子帧不参与（广告 iframe 之类）
  const els = Array.from(document.querySelectorAll('video, audio')) as HTMLMediaElement[];
  if (!els.length) {
    diag('页面暂未发现 <video>/<audio>（等待播放）');
    return;
  }
  for (const el of els) void attach(el);
}

function onMediaEvent(ev: Event): void {
  const t = ev.target as HTMLMediaElement | null;
  if (!t || typeof (t as any).play !== 'function') return;
  if (t.tagName !== 'VIDEO' && t.tagName !== 'AUDIO') return;
  // 媒体开始播放 = 页面已有用户交互（用户点了播放）→ 借机恢复被浏览器挂起的 AudioContext。
  // 无手势创建的 AudioContext 可能是 suspended，不恢复就永远收不到 process() 回调。
  if (state.ctx?.state === 'suspended') void state.ctx.resume().catch(() => {});
  void attach(t);
}

/** 一次性手势兜底：点页面任意位置时再试一次 resume（部分浏览器只认手势）。 */
function resumeOnGesture(): void {
  const resume = () => {
    if (state.ctx?.state === 'suspended') void state.ctx.resume().catch(() => {});
  };
  document.addEventListener('pointerdown', resume, { capture: true, once: true });
}

function bindListeners(): void {
  if (state.listenersBound) return;
  state.listenersBound = true;
  // 捕获阶段：媒体事件不冒泡，但会在捕获阶段经过 document（skip-silence 验证过的做法）
  for (const type of ['play', 'playing', 'loadedmetadata']) {
    document.addEventListener(type, onMediaEvent, true);
  }
}

function unbindListeners(): void {
  if (!state.listenersBound) return;
  state.listenersBound = false;
  for (const type of ['play', 'playing', 'loadedmetadata']) {
    document.removeEventListener(type, onMediaEvent, true);
  }
}

function start(): void {
  if (state.running) { scan(); return; }
  if (!frameIsRelevant()) return;   // 跨域子帧不参与（广告 iframe 之类）
  state.running = true;
  state.chunks = 0;
  state.silentChunks = 0;
  state.silenceReported = false;
  state.suspendedReported = false;
  try {
    state.port = chrome.runtime.connect({ name: 'page-audio' });
    state.port.onDisconnect.addListener(() => { state.port = null; stop(); });
  } catch {
    state.port = null;
  }
  diag(`开始：media=${document.querySelectorAll('video, audio').length}`);
  // 上一次 stop() 让 worklet 停止上报了，这里恢复（AudioContext 与元素图是复用的）
  try { state.tap?.port.postMessage({ type: 'start' }); } catch { /* ignore */ }
  resumeOnGesture();
  bindListeners();
  scan();
}

function stop(): void {
  state.running = false;
  unbindListeners();
  // **不销毁 AudioContext / 不断开元素**：createMediaElementSource 对每个元素只能调用一次，
  // 关掉 ctx 或删掉映射后，本页第二次开始就再也接不回来了（会永久静音）。
  // 这里只让 worklet 停止上报（旁路照旧，用户仍能听见声音），端口断开即可。
  try { state.tap?.port.postMessage({ type: 'stop' }); } catch { /* ignore */ }
  try { state.port?.disconnect(); } catch { /* ignore */ }
  state.port = null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'PAGE_AUDIO_START') {
    start();
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === 'PAGE_AUDIO_STOP') {
    stop();
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === 'PAGE_AUDIO_DIAG') {
    diag(`manual diag: media=${document.querySelectorAll('video, audio').length} graph=${state.elements.size} ` +
      `worklet=${state.workletReady ? 'ok' : 'no'} chunks=${state.chunks}`);
    sendResponse({ ok: true });
  }
});

// 防重复注入：模块顶层不自动启动 —— 由 background 在会话开始时发 PAGE_AUDIO_START。
// 但若这条注入发生在"已经开始采集之后"（多帧/慢加载），主动对齐一次：
if (state.running) scan();
