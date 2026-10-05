// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
// 纯 Web 版字幕浮窗宿主。
//
// 与扩展的悬浮字幕窗（floating.ts）共用同一份浮窗外壳 SubtitleShell + overlay.ts，
// 差别只有"消息从哪来"：这里走 window.postMessage 通道（channel.ts），
// 面板页是引擎宿主，浮窗只负责显示 + 工具条（停止/字号/置顶）。
import { SubtitleShell } from '../subtitle-shell';
import { storage } from '../platform';
import { getLang, tSync } from '../i18n';
import { initChannel, sendToPeer, setPeerLostHandler, setChannelPairId, PAIR_PARAM } from './channel';

// 配对号从 URL 读（面板开窗时带上）：同源可能同时存在多对"面板 + 浮窗"，
// 都挂在同一个 BroadcastChannel 上，只靠 from 角色过滤挡不住串台。
setChannelPairId(new URLSearchParams(location.search).get(PAIR_PARAM) || '');

const shell = new SubtitleShell({
  storageKey: 'tmspeech_overlay_web_floating',
  onStop: () => {
    // 工具条停止按钮：面板页是引擎宿主，停会话的消息发给它
    sendToPeer({ type: 'STOP_RECOGNITION' });
  },
  onFontSize: (size) => {
    // 字号同步：写偏好（面板下次启动会带上）+ 通知面板即时生效
    sendToPeer({ type: 'SET_FONT_SIZE', fontSize: size });
  },
  onPipClosed: () => {
    // 用户直接关掉画中画窗口：与扩展语义一致——浮窗是唯一显示端，关闭即停识别，
    // 否则识别继续跑却看不到任何字幕（用户会以为卡死）。
    sendToPeer({ type: 'STOP_RECOGNITION' });
  },
  // 取消置顶（画中画搬回本窗口）后把本窗口提到前台。扩展侧对应动作是
  // chrome.windows.update({state:'normal', focused:true}) 把悬浮窗拉回来；
  // 网页版没有那个能力，能做的是让本窗获得焦点（否则它仍被压在别的窗口后面，
  // 用户会以为"取消置顶后字幕不见了"）。
  onRestoreHostWindow: () => {
    try { window.focus(); } catch { /* 浏览器拒绝了聚焦（无用户手势等）：只是少了一次置前 */ }
  },
  // 注：这里**不要**挂 onTeardown 去发 __subtitle_closed。
  // 那条消息必须"一次关闭只发一条"（host 侧靠它区分"用户关窗"与"面板主动关窗"），
  // 发送点唯一化在本文件底部的 pagehide 里——那里还要先把面板窗口几何还原。
  onLockChanged: (locked) => {
    // 浮窗里点了锁定按钮：面板要同步勾选态。
    // 消息名沿用扩展的 LOCK_CHANGED_FROM_CONTENT，面板/宿主两侧因此无需区分宿主。
    sendToPeer({ type: 'LOCK_CHANGED_FROM_CONTENT', locked });
  },
});

// —— 替面板调整窗口几何 ——
// 为什么要绕这一手：resizeTo/moveTo 只对**脚本打开的窗口**生效，用户从地址栏直接
// 打开面板页时那边调了也没用；而本浮窗是 window.open 出来的，具备这个资格，
// 且 opener 指向面板，可以直接代劳。同源窗口才能访问 opener 的这些方法。
//
// 面板还把"挪之前的原尺寸"一起交给我们记住（msg.restore）。用途是：用户直接关掉
// 本浮窗 → 会话结束 → 但那时面板可能已经挪不动自己了（它本来就挪不动才请我们代劳），
// 唯一能替它还原的对端正在消失。所以在 pagehide 里**同步**还原一次，是最可靠的时机。
let hostRestoreRect: { x: number; y: number; w: number; h: number } | null = null;

function applyHostRect(host: Window, r: any) {
  const w = Number(r?.w), h = Number(r?.h), x = Number(r?.x), y = Number(r?.y);
  if (w > 0 && h > 0) { try { host.resizeTo(w, h); } catch { /* 不允许 */ } }
  if (Number.isFinite(x) && Number.isFinite(y)) { try { host.moveTo(x, y); } catch { /* 不允许 */ } }
}

// —— 通道：来自面板的消息（显示类 / 状态类 / 偏好类）——
initChannel('subtitle', (msg) => {
  if (msg?.type === 'STOP_RECOGNITION') {
    // 面板侧已自行收敛会话，这里只需把显示端也归位（按钮禁用）
    shell.handle({ type: 'STATUS_CHANGED', status: 'Stopped' });
    return;
  }
  if (msg?.type === '__panel_unload') {
    // 面板页关掉/刷新了：引擎随之消失，字幕不可能再来——停止按钮置灰并提示
    shell.handle({ type: 'STATUS_CHANGED', status: 'Stopped' });
    return;
  }
  if (msg?.type === '__park_host') {
    const host = window.opener as Window | null;
    if (host && !host.closed) {
      // 面板请求挪动时顺手记下"原尺寸"，供本窗关闭时兜底还原
      if (msg.restore) hostRestoreRect = msg.restore;
      try { applyHostRect(host, msg.rect); } catch { /* 跨源或已被禁止：面板会如实提示 */ }
      if (!msg.restore) hostRestoreRect = null; // 这是"还原"指令，用完即弃
    }
    return;
  }
  shell.handle(msg);
});

// 面板失联看门狗：面板页崩溃/被强杀时 beforeunload 跑不到，__panel_unload 永远不来，
// 浮窗会一直停在"运行中"（字幕不会再来、停止按钮却可点）。通道侧判定连续静默后回调这里，
// 把显示端收敛成已停止并在字幕行上说明原因——不假装还在识别。
setPeerLostHandler(() => {
  void getLang().then((lang) => {
    shell.handle({ type: 'STATUS_TEXT', key: '' });
    shell.handle({ type: 'STATUS_CHANGED', status: 'Stopped' });
    shell.handle({ type: 'TEXT_CHANGED', text: tSync(lang, 'webPanelLost') });
  });
});

// 本窗关闭：先把面板几何恢复原样（页面还在时才能动 opener），再通知面板。
// 顺序不能反——先发消息的话，面板收到时本窗的关闭流程可能已经走完，
// 那条"帮我还原"的回复就没人执行了。
window.addEventListener('pagehide', () => {
  const host = window.opener as Window | null;
  if (hostRestoreRect && host && !host.closed) {
    try { applyHostRect(host, hostRestoreRect); } catch { /* 跨源/已禁止 */ }
  }
  sendToPeer({ type: '__subtitle_closed' });
});

shell.init();
// 调试入口：控制台可查置顶状态
(window as any).__easysubSubtitle = { shell, isPinned: () => shell.isPinned() };
// 偏好由面板在握手后推来；这里先按 storage 里已有的值渲染一遍，避免开窗瞬间空白
void storage.get('tmspeech_prefs').then((r) => {
  const prefs = (r['tmspeech_prefs'] as any) || {};
  shell.handle({ type: 'PREFS_PATCH', ...prefs });
});
