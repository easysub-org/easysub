// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
// 跨宿主平台层：把"MV3 扩展"与"普通网页"两种运行环境的差异收在这一处，
// 让 panel / i18n / overlay / model-db 这类共享模块不必各自写 if (chrome) 分支。
//
// 提供四种能力：
//   ① storage       键值持久化（扩展=chrome.storage.local，Web=localStorage）
//   ② resolveUrl    包内相对路径 → 可加载 URL（扩展=chrome.runtime.getURL，Web=相对路径）
//   ③ 消息总线      sendToHost / onHostMessage / emitToPanel，见下方注释
//   ④ 环境探测      getActiveTabId / hasBundledResource
//
// 判定依据是 `chrome?.runtime?.id`：内容脚本、可能被注入页面的脚本都能安全求值，
// 普通网页上 chrome 要么不存在、要么没有 runtime.id。
export const IS_EXTENSION = typeof chrome !== 'undefined'
  && !!(chrome as any)?.runtime?.id;

// ============ ① storage ============
// 形态对齐 chrome.storage.local 的 Promise 版 API：
//   get(keys) -> Promise<Record<string, any>>；set(obj) / remove(keys) -> Promise<void>
// keys 支持 string | string[] | Record<string, any> | null（与 chrome 语义一致）。
type StorageKeys = string | string[] | Record<string, any> | null | undefined;

const LS_PREFIX = 'easysub:';

function lsGet(keys: StorageKeys): Record<string, any> {
  const out: Record<string, any> = {};
  const collect = (k: string, fallback?: any) => {
    const raw = localStorage.getItem(LS_PREFIX + k);
    if (raw == null) {
      if (fallback !== undefined) out[k] = fallback;
      return;
    }
    try { out[k] = JSON.parse(raw); } catch { out[k] = fallback; }
  };
  if (keys == null) {
    for (let i = 0; i < localStorage.length; i++) {
      const full = localStorage.key(i) || '';
      if (full.startsWith(LS_PREFIX)) collect(full.slice(LS_PREFIX.length));
    }
  } else if (typeof keys === 'string') {
    collect(keys);
  } else if (Array.isArray(keys)) {
    keys.forEach(k => collect(k));
  } else {
    for (const k of Object.keys(keys)) collect(k, keys[k]);
  }
  return out;
}

export const storage = {
  get(keys?: StorageKeys): Promise<Record<string, any>> {
    if (IS_EXTENSION) return chrome.storage.local.get(keys as any);
    try { return Promise.resolve(lsGet(keys)); } catch { return Promise.resolve({}); }
  },
  set(items: Record<string, any>): Promise<void> {
    if (IS_EXTENSION) return chrome.storage.local.set(items);
    try {
      for (const k of Object.keys(items)) localStorage.setItem(LS_PREFIX + k, JSON.stringify(items[k]));
    } catch { /* 配额满/隐私模式：静默降级，与扩展侧写失败同样宽松 */ }
    return Promise.resolve();
  },
  remove(keys: string | string[]): Promise<void> {
    if (IS_EXTENSION) return chrome.storage.local.remove(keys);
    try {
      (Array.isArray(keys) ? keys : [keys]).forEach(k => localStorage.removeItem(LS_PREFIX + k));
    } catch { /* 同上 */ }
    return Promise.resolve();
  },
};

// ============ ② resolveUrl ============
// 扩展：包内资源必须走 chrome.runtime.getURL（否则被页面 CSP / 相对路径规则拦下）。
// Web：解析成**绝对 URL**。为什么不直接返回相对路径：这个值还会传进 Web Worker
// （翻译 worker 的 wasmPaths）与 AudioWorklet，而 worker 里没有 document、
// 相对路径的基准会变成 worker 脚本自身；给绝对 URL 就没有歧义。
// 以 document.baseURI 为基准解析，因此部署在 GitHub Pages 子目录（/easysub/）也对。
export function resolveUrl(path: string): string {
  if (IS_EXTENSION) return chrome.runtime.getURL(path);
  try {
    return new URL(path, document.baseURI).href;
  } catch {
    return path;
  }
}

// ============ ③ 消息总线 ============
// 面板页与后台宿主之间是双向的，两端各注册一个监听器，刻意分成两个列表——
// 否则 Web 版同页收发时，面板会收到自己发出的消息（扩展里由不同上下文天然隔离）：
//   面板侧：sendToHost(msg) 发请求；onMessageFromHost(h) 收状态/字幕/日志
//   宿主侧：onHostMessage(h) 收请求；emitToPanel(msg) 推状态/字幕/日志
// 扩展下两条"收"的路径都落到 chrome.runtime.onMessage，行为与改造前完全一致。
type MsgHandler = (msg: any) => any;

const hostListeners: MsgHandler[] = [];   // Web：后台宿主的消息路由
const panelListeners: MsgHandler[] = [];  // Web：面板页的消息接收器

function dispatch(list: MsgHandler[], msg: any): any {
  for (const h of list.slice()) {
    try {
      const r = h(msg);
      if (r !== undefined) return r;
    } catch (e) { console.error('[EasySub] 消息处理异常', e); }
  }
  return undefined;
}

// 面板 → 宿主。扩展走 chrome.runtime.sendMessage（可拿到应答）；Web 走同页路由，
// 宿主 handler 的返回值即应答（popup 的 GET_STATUS / TRANSLATE_TEST 都依赖它）。
export function sendToHost(msg: any): Promise<any> {
  if (IS_EXTENSION) {
    try { return chrome.runtime.sendMessage(msg); } catch { return Promise.resolve(undefined); }
  }
  return Promise.resolve(dispatch(hostListeners, msg));
}

// 宿主侧注册（Web 专用；扩展的 background 用自己的 onMessage）
export function onHostMessage(handler: MsgHandler): void {
  if (IS_EXTENSION) {
    chrome.runtime.onMessage.addListener((msg: any, _sender: any, sendResponse: any) => {
      if (handler(msg) === true) return true;
      return undefined;
    });
    return;
  }
  hostListeners.push(handler);
}

// 面板侧注册：接收来自宿主的消息
export function onMessageFromHost(handler: MsgHandler): void {
  if (IS_EXTENSION) {
    chrome.runtime.onMessage.addListener((msg: any) => {
      try { handler(msg); } catch (e) { console.error('[EasySub] 消息处理异常', e); }
    });
    return;
  }
  panelListeners.push(handler);
}

// 宿主 → 面板页（Web 专用；扩展的 background 用 chrome.runtime.sendMessage 推给 popup）
export function emitToPanel(msg: any): void {
  if (IS_EXTENSION) return;
  dispatch(panelListeners, msg);
}

// ============ ④ 环境探测 ============

// 是否有"当前标签页"这个音源。扩展靠 tabCapture 抓标签页音频，Web 版拿不到，
// 面板据此决定下拉里要不要出现该项、以及默认音源是什么。
export const HAS_TAB_SOURCE = IS_EXTENSION;
export const DEFAULT_AUDIO_SOURCE: 'tab' | 'system' | 'mic' = IS_EXTENSION ? 'tab' : 'system';

// 当前活动标签页 id。Web 版没有"标签页"概念（音源只有系统音频/麦克风），恒为 null。
export async function getActiveTabId(): Promise<number | null> {
  if (!IS_EXTENSION) return null;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

// 包内是否自带该资源（用于判定 full/lite 版 vs nomodel 版）。
// 判定失败一律当"没有"——那样会走模型导入引导，用户最多多点一下，不会静默失灵。
// 注意：这个布尔语义只适合"引导用"的宽松场景。识别引擎的注入门卫要区分"明确没有"与
// "探测不了"，见 probeBundledResource。
export async function hasBundledResource(path: string): Promise<boolean> {
  return (await probeBundledResource(path)) === 'present';
}

// 包内资源的三态探测。为什么要三态：识别引擎据此决定"要不要注入 wasm 脚本"——
// 注入是重操作（pthread 运行时 + 412MB 模型），模型确实不在时注入会留下半初始化的
// 运行时。
// 但三态**只对 Web 托管场景有意义**，扩展侧必须保持 master 的布尔语义（见下），
// 否则会把 nomodel 包锁死。
export type ResourceProbe = 'present' | 'absent' | 'unknown';

// 模型 .data 恒为 ~412MB：远小于这个数量级的响应不可能是它，多半是托管方的
// SPA 回退（把 index.html 以 200 返回）或错误页。
const BUNDLED_MIN_BYTES = 100 * 1024 * 1024;

export async function probeBundledResource(path: string): Promise<ResourceProbe> {
  try {
    const res = await fetch(resolveUrl(path), { method: 'HEAD' });
    // 坑：扩展侧**不能**区分"明确没有"与"探测不了"，必须沿用 master 的 `res.ok`
    // 布尔语义——扩展里资源由浏览器自己服务、没有中间层，"200" 就是确定存在，
    // 其余一切（非 200 响应或 fetch 抛错，Chrome 取不存在的打包资源时两者都可能发生）
    // 都当确定不存在。走三态的话，抛错会落进 unknown 被当成"照旧尝试"，于是 nomodel 包
    // （无 .data 且用户未导入）被判成"模型就绪"、跳过下载引导，最后卡在 30 秒 wasm 超时。
    if (IS_EXTENSION) return res.ok ? 'present' : 'absent';
    if (!res.ok) {
      return res.status === 404 || res.status === 403 || res.status === 410 ? 'absent' : 'unknown';
    }
    // 以下是 Web 托管专用判定：要防 SPA 回退（200 + index.html）与错误页中间层，
    // 所以除 200 之外还要看类型与体积。判定不了（异常）才归 unknown，
    // 交给调用方按"照旧尝试"处理——宁可让它去报真实错误，也别把网络抽风当缺模型。
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (ctype.includes('text/html')) return 'absent';
    const len = Number(res.headers.get('content-length') || 0);
    if (len > 0 && len < BUNDLED_MIN_BYTES) return 'absent';
    return 'present';
  } catch {
    // 扩展侧抛错 = 文件取不到（见上），与 master 的 catch{return false} 等价
    return IS_EXTENSION ? 'absent' : 'unknown';
  }
}

// 语言读写（i18n 用）。同一个键名两端共用，调用方无需关心宿主。
export async function getLang(): Promise<string> {
  const r = await storage.get('tmspeech_lang');
  return (r['tmspeech_lang'] as string) || 'zh_CN';
}

export async function setLang(lang: string): Promise<void> {
  await storage.set({ tmspeech_lang: lang });
}
