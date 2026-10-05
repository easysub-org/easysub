// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
import { Overlay } from './overlay';
console.log('[TM Content] loaded');
// 坑：background 可能在同一页面重复注入本脚本（启动重试、导航重注入竞态）。
// 这里刻意不用 window 标记拦截重复副本——扩展重载后旧标记会残留，把新副本误杀，
// 导致该页字幕失效到手动刷新为止。正确策略是"后来者接管"：
// Overlay.create() 会按 DOM id 移除旧节点，消息处理全部幂等，多副本并存也只显示一层字幕。

// 叠层实现与悬浮字幕窗共用 src/overlay.ts（唯一事实源），本文件只负责接线：
// 挂载进页面（含全屏迁移），接收 background 的 tabs.sendMessage 消息。
const overlayHost = new Overlay({ trackFullscreen: true });

// 坑：PING 必须显式应答（sendResponse + return true）。background 用
// chrome.tabs.sendMessage(PING) 的 resolve/reject 判断"页面里是否已有字幕层"，
// 而接收方存在却不响应时该 Promise 必然 reject —— 于是探测恒为 false，
// 每次启动、每次导航 complete 都会再注入一份副本。每份副本各持一套
// onMessage 监听 + runtime 端口 + fullscreenchange 监听 + ResizeObserver，
// 且都会响应每条消息、各自写 storage（写放大），并在特定交错下留下
// "节点已被摘除却拒绝重建"的僵尸实例（字幕消失到刷新为止）。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'PING') {
    sendResponse({ ok: true });
    return true;
  }
  overlayHost.handle(msg);
});

// 监听扩展断开，自动隐藏字幕
(function monitorExtension() {
  const port = chrome.runtime.connect({ name: 'content' });
  port.onDisconnect.addListener(() => overlayHost.destroy());
})();