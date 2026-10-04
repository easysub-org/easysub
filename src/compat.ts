// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
// 浏览器兼容性自检（两端共用：扩展弹窗 + 纯 Web 版面板，首次启动时弹一次）。
//
// 背景（用户实测）：Firefox/Safari 等浏览器打开面板后「点开始毫无反应」，排查成本极高。
// 与其让用户撞墙，不如在第一次打开面板时就把 UA 与关键 API 检一遍：
//   ① UA 必须是 Chrome / Edge（Chromium 系其它浏览器归单独一档：可用但未经充分测试；
//     Firefox / Safari / 未知内核直接判不兼容）；
//   ② 关键 API 与静态资源响应头按「必须 / 重要 / 建议」三档检测；
//   ③ 汇总为 0-100 评分；不达标时给出 Chrome / Edge 官方下载链接
//     （Chrome 按界面语言选 google.cn / google.com，Edge 用微软官方页）。
// 结果按 UA 记忆（storage）：同一浏览器只在首次启动时弹一次，之后静默跳过；
// 换了浏览器（UA 变化）会重新检测并再次提示。
//
// 纪律：本文件只依赖 platform.ts / i18n.ts，不 import chrome.*（跨宿主共享）；
// DOM 骨架在 ui-body.html 的 #compatModal（两端同一份模板）。
import { IS_EXTENSION, resolveUrl, storage } from './platform';
import { getLang, tSync } from './i18n';

type CheckLevel = 'blocker' | 'important' | 'advice';

interface CompatCheck {
  // i18n 键后缀：compatChk + Id（如 compatChkBrowser）
  id: string;
  level: CheckLevel;
  ok: boolean;
}

interface CompatReport {
  browser: string;
  family: 'chrome' | 'edge' | 'chromium' | 'firefox' | 'safari' | 'unknown';
  score: number;
  checks: CompatCheck[];
  uaOk: boolean;
}

// 同一浏览器只提示一次的记忆键（存 UA 字符串；UA 变了视为换了浏览器，重新提示）
const SEEN_KEY = 'easysub_compat_seen';
// 响应头探测目标：wasm 加载器在所有安装包（full/lite/nomodel/web）里都有，
// 正常托管下 content-type 必须是 JS。被 SPA 回退 / 对象存储错误配置成 text/html 时，
// 识别引擎根本起不来——这就是"请求头检测"的真靶子（.data 会随 nomodel 包缺席，不作探针）。
const PROBE_PATH = 'wasm/sherpa-onnx-wasm-main-asr.js';
// 最低可用版本：getDisplayMedia(70+)/AudioWorklet(66+)/broad 能力在 90 之前参差，
// 90 是本项目实际依赖能力的保守合拢线。版本未知（解析失败）不扣分。
const MIN_MAJOR = 90;

function detectBrowser(): { name: string; family: CompatReport['family']; major: number } {
  const ua = navigator.userAgent || '';
  // UA-CH 品牌列表比 UA 字符串可靠（UA 冻结后 Chrome/Edge 的 UA 区分度下降），优先用
  const brands: Array<{ brand: string; version: string }> | undefined =
    (navigator as any).userAgentData?.brands;
  const hasBrand = (re: RegExp) => !!brands?.some(b => re.test(b.brand));
  const edgeM = ua.match(/Edg(?:e|A|iOS)?\/(\d+)/);
  if (edgeM || hasBrand(/Microsoft Edge/i)) {
    const major = Number(edgeM?.[1] ?? brands?.find(b => /Microsoft Edge/i.test(b.brand))?.version ?? 0);
    return { name: 'Microsoft Edge', family: 'edge', major };
  }
  const chromeM = ua.match(/Chrome\/(\d+)/);
  // 其它 Chromium 壳（Opera/三星/国产系）的 UA 特征串：命中即归 chromium 档，不算 Chrome
  const shell = /OPR\/|Opera|SamsungBrowser|QQBrowser|UBrowser|MiuiBrowser|HeyTapBrowser|VivoBrowser|HuaweiBrowser/i.test(ua);
  if (chromeM && !shell) return { name: 'Google Chrome', family: 'chrome', major: Number(chromeM[1]) };
  if (chromeM) return { name: 'Chromium', family: 'chromium', major: Number(chromeM[1]) };
  if (/Firefox\//i.test(ua)) return { name: 'Firefox', family: 'firefox', major: Number(ua.match(/Firefox\/(\d+)/)?.[1] ?? 0) };
  if (/Safari\//i.test(ua)) return { name: 'Safari', family: 'safari', major: Number(ua.match(/Version\/(\d+)/)?.[1] ?? 0) };
  return { name: 'Unknown', family: 'unknown', major: 0 };
}

function buildChecks(family: CompatReport['family'], major: number): CompatCheck[] {
  const checks: CompatCheck[] = [];
  const add = (id: string, level: CheckLevel, ok: boolean) => checks.push({ id, level, ok });
  add('Browser', 'blocker', family === 'chrome' || family === 'edge');
  add('Version', 'important', major === 0 || major >= MIN_MAJOR);
  add('Wasm', 'important', typeof WebAssembly === 'object');
  // pthreads 构建的 wasm 需要共享内存；扩展页与 Web 页都真实依赖它，都检测
  add('Sab', 'important', typeof SharedArrayBuffer === 'function');
  add('Display', 'important', !!navigator.mediaDevices?.getDisplayMedia);
  add('Mic', 'important', !!navigator.mediaDevices?.getUserMedia);
  const ACtx: any = (window as any).AudioContext || (window as any).webkitAudioContext;
  add('Worklet', 'important', !!ACtx && 'audioWorklet' in ACtx.prototype);
  add('Idb', 'important', !!indexedDB);
  add('Worker', 'important', typeof Worker === 'function');
  if (!IS_EXTENSION) {
    // 跨源隔离 = COOP/COEP 响应头真的下发了（静态托管最常漏的配置）；扩展页豁免该限制
    add('Isolated', 'important', !!window.crossOriginIsolated);
    add('Secure', 'important', !!window.isSecureContext);
    // 字幕浮窗的主通道（无它退化为单窗兜底，能用但多窗口能力打折）→ 建议档
    add('Channel', 'advice', typeof BroadcastChannel === 'function');
    // 412MB 模型下载的进度条依赖流式响应体
    add('Stream', 'advice', !!(new Response()).body);
  }
  // 响应头检测是异步 HEAD 探测，先占位（默认过），探测回来后覆盖
  add('Headers', 'important', true);
  return checks;
}

async function probeAssetHeaders(): Promise<boolean> {
  try {
    const res = await fetch(resolveUrl(PROBE_PATH), { method: 'HEAD' });
    if (!res.ok) return false;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    return ct.includes('javascript') || ct.includes('application/wasm');
  } catch {
    return false;
  }
}

// 评分：满分 100，重要项每缺一项 −15，建议项 −5；
// 内核分档封顶——非 Chrome/Edge 的 Chromium 系至多 70（可用但未经充分测试），
// Firefox/Safari/未知内核至多 25（核心 API 大面积缺失或内核不支持）。
function scoreReport(family: CompatReport['family'], checks: CompatCheck[]): number {
  let score = 100;
  for (const c of checks) {
    if (c.ok || c.level === 'blocker') continue;
    score -= c.level === 'important' ? 15 : 5;
  }
  if (family === 'chrome' || family === 'edge') return Math.max(0, score);
  const cap = family === 'chromium' ? 70 : 25;
  return Math.max(0, Math.min(cap, score));
}

export function initCompatCheck(): void {
  void runCompatCheck();
}

async function runCompatCheck(): Promise<void> {
  // 「同一浏览器不再显示」的记忆**只在用户点「知道了」时落盘**（见 fillCompatModal 的
  // ok.onclick），这里只读不写。原因（用户实测）：Web 版首次访问会触发 coi-serviceworker
  // 的跨源隔离自动刷新，弹窗刚亮就被刷掉——若在这里就落盘，用户永远见不到检测结果，
  // 且按 UA 记忆再也不弹。读取提前到探测之前，命中记忆连 HEAD 请求都省掉。
  try {
    const seen = (await storage.get(SEEN_KEY))[SEEN_KEY];
    if (seen === navigator.userAgent) return;
  } catch { /* 存储异常：照常提示 */ }
  showCompatModal(await detectCompat());
}

// 执行一轮完整检测（同步 API 检查 + 异步 HEAD 响应头探测）并评分。
// 抽成独立函数：「重新检测」按钮复用同一条路径，保证与首次检测口径完全一致。
async function detectCompat(): Promise<CompatReport> {
  const { name, family, major } = detectBrowser();
  const checks = buildChecks(family, major);
  const headersOk = await probeAssetHeaders();
  checks.find(c => c.id === 'Headers')!.ok = headersOk;
  return {
    browser: name,
    family,
    score: scoreReport(family, checks),
    checks,
    uaOk: family === 'chrome' || family === 'edge',
  };
}

// 最近一次检测结果 + 当前语言：语言切换时（面板 applyLang 回调 __easysubCompatRefresh）
// 用它们原地重渲染弹窗文案。弹窗是"首次启动"场景，遮罩挡住了面板的 btnLang，
// 所以弹窗内自带语言按钮（委托给面板的 btnLang 走同一套 setLang+applyLang）。
let lastReport: CompatReport | null = null;
let compatLang = 'zh_CN';

function fillCompatModal(report: CompatReport, lang: string): void {
  const modal = document.getElementById('compatModal');
  if (!modal) return;
  // 标题 + 评分（颜色随分数分档：绿/琥珀/红）
  document.getElementById('compatTitle')!.textContent = tSync(lang, 'compatTitle');
  const scoreEl = document.getElementById('compatScore')!;
  scoreEl.textContent = `${report.score}/100`;
  scoreEl.style.color = report.score >= 90 ? 'var(--green)'
    : report.score >= 60 ? 'var(--orange)' : 'var(--red)';
  // 语言切换按钮：文案显示"可切换到的另一种语言"（与面板 btnLang 同一约定）
  const langBtn = document.getElementById('compatLang') as HTMLButtonElement | null;
  if (langBtn) langBtn.textContent = tSync(lang, 'langSwitch');
  // 结论行：检测到的浏览器 + 三档结论
  const verdictKey = report.score >= 90 ? 'compatVerdictGood'
    : report.score >= 60 ? 'compatVerdictMid' : 'compatVerdictBad';
  document.getElementById('compatVerdict')!.textContent =
    tSync(lang, 'compatDetected').replace('{name}', report.browser) + ' ' + tSync(lang, verdictKey);
  // 检查明细：按 必须/重要/建议 分组；通过=✓（绿），重要/必须失败=✗（红），建议失败=!（琥珀）
  const list = document.getElementById('compatList')!;
  list.innerHTML = '';
  let lastLevel: CheckLevel | null = null;
  for (const c of report.checks) {
    if (c.level !== lastLevel) {
      const g = document.createElement('div');
      g.className = 'compat-group';
      g.textContent = tSync(lang, c.level === 'blocker' ? 'compatGroupBlocker'
        : c.level === 'important' ? 'compatGroupImportant' : 'compatGroupAdvice');
      list.appendChild(g);
      lastLevel = c.level;
    }
    const row = document.createElement('div');
    row.className = 'compat-row' + (c.ok ? ' ok' : (c.level === 'advice' ? ' warn' : ' fail'));
    const ico = document.createElement('span');
    ico.className = 'compat-ico ' + (c.ok ? 'pass' : (c.level === 'advice' ? 'warn' : 'fail'));
    ico.textContent = c.ok ? '✓' : (c.level === 'advice' ? '!' : '✗');
    const txt = document.createElement('span');
    txt.textContent = tSync(lang, 'compatChk' + c.id);
    row.append(ico, txt);
    list.appendChild(row);
  }
  // 不达标才给下载推荐。Chrome 给中国站与国际站两个官方链接（google.cn 对部分
  // 地区/网络不可达，google.com 同理——两个都摆出来让用户按自己网络挑能打开的）
  const dl = document.getElementById('compatDl')!;
  if (!report.uaOk || report.score < 90) {
    (document.getElementById('compatDlChromeCn') as HTMLAnchorElement).href =
      'https://www.google.cn/chrome/';
    document.getElementById('compatDlChromeCn')!.textContent = tSync(lang, 'compatDlChromeCn');
    (document.getElementById('compatDlChromeIntl') as HTMLAnchorElement).href =
      'https://www.google.com/chrome/';
    document.getElementById('compatDlChromeIntl')!.textContent = tSync(lang, 'compatDlChromeIntl');
    (document.getElementById('compatDlEdge') as HTMLAnchorElement).href =
      'https://www.microsoft.com/edge/download';
    document.getElementById('compatDlEdge')!.textContent = tSync(lang, 'compatDlEdge');
    document.getElementById('compatDlLabel')!.textContent = tSync(lang, 'compatNeedBrowser');
    dl.hidden = false;
  } else {
    dl.hidden = true;
  }
  const ok = document.getElementById('compatOk')!;
  ok.textContent = tSync(lang, 'compatOk');
  // 「知道了」= 用户确认读完 → 落盘"该浏览器已看过"，之后不再弹。
  // Esc / 点遮罩关闭**不**落盘：下次启动还会再弹（写失败不阻断关闭）。
  ok.onclick = () => {
    modal.hidden = true;
    storage.set({ [SEEN_KEY]: navigator.userAgent }).catch(() => {});
  };
}

// 手动重新打开检测弹窗（面板 Hero 顶栏的盾牌按钮）：每次都重跑一轮完整检测
// （与首次检测同一条 detectCompat() 路径，口径一致），且**不受**「已读」记忆限制——
// 用户主动点开就给他看最新结果。
export async function openCompatCheck(): Promise<void> {
  showCompatModal(await detectCompat());
}

function showCompatModal(report: CompatReport): void {
  const modal = document.getElementById('compatModal');
  if (!modal) return; // 模板缺失（极端）：静默跳过，兼容性提示不能阻塞面板
  lastReport = report;
  void getLang().then((lang) => {
    compatLang = lang;
    fillCompatModal(report, lang);
    // 弹窗内语言切换 → 委托面板的 btnLang（它做 setLang + applyLang），
    // applyLang 末尾的 __easysubCompatRefresh 钩子会把本弹窗文案原地刷新
    const langBtn = document.getElementById('compatLang') as HTMLButtonElement | null;
    if (langBtn && !compatLangBound) {
      compatLangBound = true;
      langBtn.onclick = () => document.getElementById('btnLang')?.click();
    }
    modal.onclick = (e) => { if (e.target === modal) modal.hidden = true; };
    if (!compatEscBound) {
      compatEscBound = true;
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
      });
    }
    modal.hidden = false;
    (document.getElementById('compatOk') as HTMLButtonElement).focus();
  });
}

// 面板 applyLang 末尾回调：任何语言切换（弹窗内按钮 / 面板按钮 / 其它入口）都让
// 打开中的检测弹窗原地换文案。弹窗没开或尚无检测结果时是空操作。
(window as any).__easysubCompatRefresh = (lang: string) => {
  compatLang = lang;
  const modal = document.getElementById('compatModal');
  if (modal && !modal.hidden && lastReport) fillCompatModal(lastReport, lang);
};

let compatEscBound = false;
let compatLangBound = false;
