// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
// 面板页 ↔ 字幕浮窗 的跨窗口消息总线（纯 Web 版专用）。
//
// 主通道用 **BroadcastChannel**，而不是 window.postMessage/opener：
//   - opener 关系不可靠：浏览器对 window.open 的 noopener 处理、以及某些环境下浮窗
//     被当作独立标签页打开时，window.opener 为 null，消息直接石沉大海（实测如此）；
//   - BroadcastChannel 与窗口拓扑无关，同源即可通，双方互发互收，窗口关闭自动失效。
// 兜底通道保留 window.postMessage 直投（浮窗→面板走 opener，面板→浮窗走窗口引用）：
// 极老浏览器没有 BroadcastChannel 时仍能工作（此时 window 监听才会启用）。
//
// 消息形态：{ from: 'panel' | 'subtitle', pair: string, msg: any }。
//   from —— 过滤掉自己发的（按角色）；
//   pair —— **实例配对号**：同源下可能同时存在多对"面板 + 浮窗"（用户开了两个面板页），
//           而 BroadcastChannel 是全局广播。没有 pair 的话，B 面板的会话会被 A 浮窗的
//           "停止/关窗"消息停掉，两场会话的字幕也会串进彼此的浮窗，A 的让位请求还会
//           去挪 B 的面板窗口。面板开窗时把 pair 写进浮窗 URL，双方此后只认自己的对号。
//           空 pair（用户手写地址直接打开 subtitle.html）不做过滤，保持旧行为。
// 心跳与握手：浮窗每 2 秒广播一次 hello（保活）；ack 里带 needReady 标志，只有
// "面板刚加载，还没补齐过偏好"或"对端是刚开/刷新的浮窗页"时才会触发一次 ready →
// 面板重推偏好与状态。steady state 下心跳只确认在线，握手循环不会永远转下去。

export type ChannelRole = 'panel' | 'subtitle';

const HELLO_INTERVAL_MS = 2000;
const CHANNEL_NAME = 'easysub-web';
// 对端失联判定：浮窗每 2 秒发心跳、面板收到就回 ack，正常情况每秒都该有入站消息。
// 连续这么久没有任何入站（面板崩溃/被任务管理器杀掉，beforeunload 都没跑到）时，
// 浮窗不能永远停在"运行中"——字幕早就不会再来，按钮却还是可点的。
const PEER_LOST_MS = 8000;
const PEER_LOST_CHECK_MS = 2000;
// 配对号在浮窗 URL 上的参数名（面板开窗时带上，浮窗打开时读出来）
export const PAIR_PARAM = 'pair';

type MsgHandler = (msg: any) => void;

let role: ChannelRole = 'panel';
let handler: MsgHandler = () => {};
let onPeerReady: (() => void) | null = null;
let bus: BroadcastChannel | null = null;
let peerSeen = false;
let helloTimer: any = null;
let peerWatchTimer: any = null;
// 本实例的配对号（见文件头）。面板侧自己生成、写进浮窗 URL；浮窗侧从 URL 读取。
let pairId = '';
export function setChannelPairId(id: string) { pairId = id || ''; }
// 面板侧：是否还在等一次「偏好补齐」握手。初始 true（面板刚加载，浮窗可能比它先开），
// 完成 ready 握手后置 false。没有它，2 秒一次的心跳会让 ack→ready→prime 循环永远转下去。
let awaitingPeerReady = true;
// 浮窗侧：本页是否已经发过 ready。新开/刷新的浮窗页自然为 false，补齐一次后即止。
let readySent = false;

// 兜底：极老环境无 BroadcastChannel 时用 window.postMessage 直投。
// targetOrigin 用 '*'：file:// 下 origin 是 "null"，用它做匹配会一条都发不出去；
// 消息体只有字幕/状态，不含敏感数据，可接受。
// 目标：浮窗角色投 window.opener；面板角色没有 opener，投自己 open 出来的浮窗
// 引用（setFallbackPeerWindow 登记）。两个方向都不依赖广播，点对点送达。
let fallbackTarget: Window | null = null;
export function setFallbackPeerWindow(w: Window | null) {
  fallbackTarget = w && !w.closed ? w : null;
}

function postViaOpener(msg: any) {
  const w = role === 'subtitle' ? (window.opener as Window | null) : fallbackTarget;
  if (!w) return;
  try { w.postMessage({ from: role, pair: pairId, msg }, '*'); } catch { /* 已关闭 */ }
}

export function sendToPeer(msg: any): boolean {
  const payload = { from: role, pair: pairId, msg };
  if (bus) {
    try { bus.postMessage(payload); return true; } catch { /* 通道已关闭，退回 opener */ }
  }
  postViaOpener(msg);
  return true;
}

export function hasPeer(): boolean { return peerSeen; }

// 对端窗口已经确认消失时清掉"在线"标记。不清的话，浮窗关掉之后 hasPeer() 仍为真：
// 面板会立刻通过 waitForPeer 并发 __park_host 给一个不存在的窗口，随后因为挪不动而
// 报出"浏览器不允许挪窗口"这种误导性提示（真实原因是对端已经没了）。
export function resetPeerSeen() { peerSeen = false; }

// 「对端已经没了」的回调。两个角色都可能用：
//   浮窗侧：面板崩溃/被任务管理器杀掉（beforeunload 都没跑到）时收敛显示端；
//   面板侧：浮窗被手动导航到别的网址、或被浏览器丢弃时收敛会话。
// 共同判据只有一条——连续 N 秒收不到任何入站消息（正常时每 2 秒必有一次心跳往返）。
let onPeerLost: (() => void) | null = null;
export function setPeerLostHandler(fn: (() => void) | null) { onPeerLost = fn; }

export function initChannel(r: ChannelRole, onMessage: MsgHandler, onPeerReconnected?: () => void) {
  role = r;
  handler = onMessage;
  onPeerReady = onPeerReconnected ?? null;

  // 最后一次收到对端消息的时刻。心跳/ack/业务消息都算——只要通道还活着就一定有入站。
  let lastPeerMsgAt = Date.now();
  let lostNotified = false;

  const dispatch = (msg: any) => {
    if (!msg || typeof msg !== 'object') return;
    lastPeerMsgAt = Date.now();
    lostNotified = false;

    if (msg.type === '__hello') {
      peerSeen = true;
      // 收到心跳即确认对端在。needReady 告诉对端"我这边还欠一次偏好补齐"
      // （面板刚加载、还没完成过 ready 握手），否则只确认在线、不触发重推。
      sendToPeer({ type: '__ack', needReady: awaitingPeerReady });
      return;
    }
    if (msg.type === '__ack') {
      peerSeen = true;
      // ready 只在两种情况下发：本浮窗页还没发过（新开/刷新的浮窗要一次补齐），
      // 或对端明说它在等（面板刚加载，对面是旧浮窗）。其余心跳只确认在线。
      if (!readySent || msg.needReady) {
        readySent = true;
        sendToPeer({ type: '__ready' });
      }
      return;
    }
    if (msg.type === '__ready') {
      peerSeen = true;
      awaitingPeerReady = false;
      onPeerReady?.();
      return;
    }
    try { handler(msg); } catch (err) { console.error('[EasySub] 跨窗口消息处理异常', err); }
  };

  // 配对号过滤：只处理属于本对（本面板 + 它的浮窗）的消息。同源下第二个面板页、
  // 或用户手写地址打开的另一份 subtitle.html，都会在同一频道里广播——不过滤的话
  // 别人的"停止/关窗"会停掉本场会话，两边字幕也会互串。
  // 本端没有配对号（旧版页面/手工打开的浮窗）时不隔离，保持宽松兼容。
  const pairedWithUs = (p: unknown) => !pairId || p === pairId;

  if (typeof BroadcastChannel !== 'undefined') {
    // 构造也可能抛（隐私模式/被策略禁用）：抛出去会让整个入口脚本夭折，
    // 连下面的 window 兜底通道都注册不上。失败就退回兜底通道。
    try {
      bus = new BroadcastChannel(CHANNEL_NAME);
      bus.addEventListener('message', (e: MessageEvent) => {
        const d = e.data;
        // 过滤自己发的消息与别人的配对号（BroadcastChannel 本身不回送发送方，统一过滤无害）
        if (!d || d.from === role || !pairedWithUs(d.pair)) return;
        dispatch(d.msg);
      });
    } catch (e) {
      bus = null;
      console.warn('[EasySub] BroadcastChannel 不可用，退回 window 消息通道', e);
    }
  }

  // window 兜底通道仅在无 BroadcastChannel 时启用：BC 可用时它是纯冗余（双向
  // 都走广播），而 window 通道谁都能投递，没必要常驻一个伪造消息的入口。
  if (!bus) {
    window.addEventListener('message', (e: MessageEvent) => {
      // 同源校验：window 通道谁都能投递，不校验 origin 的话，任意同浏览器页面都能
      // 伪造 {from:'subtitle', msg:{type:'STOP_RECOGNITION'}} 之类的控制消息。
      // file:// 下两侧 origin 都是字符串 "null"，等值比较依然成立。
      if (e.origin !== location.origin) return;
      const d = e.data;
      if (!d || d.from === role || !('msg' in d) || !pairedWithUs(d.pair)) return;
      dispatch(d.msg);
    });
  }

  // 心跳与失联看门狗，两个角色都要：
  //   - 浮窗发 hello（保活）；面板收到后回 ack。正常时每 2 秒必有一次入站往返。
  //   - 连续 PEER_LOST_MS 没有任何入站 → 对端已不在（浮窗被导航走/被浏览器丢弃、
  //     或面板崩溃被强杀导致 beforeunload 没跑到）→ 上报，由宿主如实收敛。
  // 面板侧的 onPeerLost 只在"本该有浮窗"时才会被宿主采取动作（见 web/panel.ts），
  // 所以这里无条件安装不会误伤"用户主动关掉字幕显示"的正常情形。
  if (role === 'subtitle') {
    // 注：__subtitle_closed 不在这里发——那条消息每次关窗只能发一条（host 侧据此区分
    // "用户关窗"与"面板主动关窗"）。发送点在 web/subtitle.ts 的 pagehide，
    // 那里还要赶在页面销毁前把面板窗口几何还原。
    const beat = () => sendToPeer({ type: '__hello' });
    beat();
    helloTimer = setInterval(beat, HELLO_INTERVAL_MS);
  }
  peerWatchTimer = setInterval(() => {
    if (lostNotified || Date.now() - lastPeerMsgAt < PEER_LOST_MS) return;
    lostNotified = true;
    peerSeen = false;
    onPeerLost?.();
  }, PEER_LOST_CHECK_MS);
}

export function stopChannel() {
  if (helloTimer) { clearInterval(helloTimer); helloTimer = null; }
  if (peerWatchTimer) { clearInterval(peerWatchTimer); peerWatchTimer = null; }
  try { bus?.close(); } catch { /* 已关闭 */ }
  bus = null;
}
