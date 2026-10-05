// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
// 纯 Web 版面板入口：共享控制面板（src/panel.ts）+ 本文件的宿主接线。
//
// 宿主侧要做的四件事：
//   ① 起 host.ts（相当于扩展的 background + offscreen 合体）；
//   ② 在用户手势内预取屏幕共享音频流（getDisplayMedia 要求瞬时用户激活）；
//   ③ 管理字幕浮窗（window.open，对应扩展自动弹出的悬浮字幕窗）；
//   ④ 把音源收成"系统音频 / 麦克风"两态、把提示语换成 Web 版说法。
import { mountPanel, requireCrossOriginIsolation, isAsrModelReady, type PanelHostHooks } from '../panel';
import { getLang, tSync } from '../i18n';
import { resolveUrl } from '../platform';
import {
  installWebHost, preAcquireAudio, getSessionStatus, preloadEngine, setSessionLifecycleHooks,
  primeSubtitlePrefs, handleFromSubtitle, onSubtitleWindowRef, setSubtitleWindowRef,
  closeSubtitleWindow, emitLog, isEngineRuntimeLoaded, resendCurrentText, stopSession,
  isSessionActive, isSubtitleWindowUsable, setSubtitleWanted,
} from './host';
import { initChannel, sendToPeer, hasPeer, stopChannel, setFallbackPeerWindow, setChannelPairId, resetPeerSeen, setPeerLostHandler, PAIR_PARAM } from './channel';
// 纯 Web 版**必须**跨源隔离：sherpa-onnx 的 wasm 是 pthreads 构建（共享内存 + worker），
// 没有 crossOriginIsolated 时连初始化都会抛 DataCloneError。扩展侧豁免此限制。
requireCrossOriginIsolation(true);

// 注：wasm 的"模型存在才注入"门卫不在这里，而在 asr-engine 的 injectWasmScripts 里
// （它自己查 IndexedDB + 探测包内 .data，两端共用同一份判定）。宿主侧不再需要重复一份。

// 字幕浮窗尺寸：宽条 + 深色底，与扩展的悬浮字幕窗观感一致
const SUBTITLE_WIN_WIDTH = 780;
const SUBTITLE_WIN_HEIGHT = 200;
// 窗口名带面板实例后缀：固定名字的话，同浏览器开第二个面板页点「开始」会用
// window.open 复用并**重新导航**第一个面板正在用的浮窗（显示端被整个重置）。
// 随机后缀让每个面板各开各的窗，互不劫持。
const SUBTITLE_WIN_NAME = 'easysub-subtitle-' + Math.random().toString(36).slice(2, 8);
// 本面板实例的配对号：写进浮窗 URL，双方的消息都带它，同源多对面板/浮窗互不串台
// （BroadcastChannel 是全局广播，仅靠 from 角色过滤挡不住"另一个面板的浮窗")。
const PAIR_ID = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
// 会话开始时把面板窗口让开：字幕浮窗贴在屏幕下方居中，面板若原样留在原地就会把它
// 压住（用户实测"创建浮窗后原本的那个窗口没有自动隐藏"）。
// 扩展侧对应的动作是 chrome.windows.update(minimized)；网页没有最小化权限，
// 能做的是"挪到右上角 + 缩成小窗"：不再遮挡字幕，状态与波形又随手可见。
const PANEL_PARKED_WIDTH = 460;
const PANEL_PARKED_HEIGHT = 300;
// 挪动后留的边距（贴边太紧会让窗口装饰压到屏幕边缘）
const PANEL_PARK_MARGIN = 12;
// 窗口不缩到看不清的尺寸以下（屏幕本身比这还小时以屏幕为准）
const PANEL_MIN_WIDTH = 360;
const PANEL_MIN_HEIGHT = 220;
// 几何变更与校验之间的等待（resizeTo/moveTo 不是同步的）
const PARK_VERIFY_DELAY_MS = 160;
// 校验容差：浏览器可能对尺寸取整或受最小窗口尺寸限制
const PARK_TOLERANCE = 24;
// 等浮窗握手的上限：首次开窗后心跳最迟 2 秒到，留一点余量
const PEER_WAIT_MS = 3000;
// 让位前的原几何在 sessionStorage 的存档键（面板在会话中刷新时的还原依据）
const PARK_RESTORE_KEY = 'easysub_park_restore';

interface ParkRect { x: number; y: number; w: number; h: number }

let parked = false;
let restoreGeom: ParkRect | null = null;
// 让位代次：每次开始让位 +1；停止（restorePanelWindow）也 +1，作废在途的让位
// （否则"停止时归还几何"跑在让位完成之前，面板会卡在右上角小窗里永远回不来）。
let parkGen = 0;
// 只提示一次"这个浏览器不让脚本挪窗口"，避免每次开始识别都刷一条日志
let parkRefusedWarned = false;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 等浮窗完成握手（心跳每 2 秒一次）。会话刚起来时浮窗可能还没连上，
// 这时就断言"挪不动"并输出提示是错的——绝大多数设备其实两步都能成。
async function waitForPeer(ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (hasPeer()) return true;
    await sleep(80);
  }
  return hasPeer();
}

// 目标矩形：屏幕右上角的小窗。坑：负坐标会被浏览器钳到 0,0（试过把窗口挪到屏幕外，
// 结果落在左上角，反而更挡），所以只能"缩小 + 贴边"，这才是"让开"的可做法。
function parkedRect(): ParkRect | null {
  const scr = window.screen;
  if (!scr) return null;
  const availW = scr.availWidth || scr.width;
  const availH = scr.availHeight || scr.height;
  if (!availW || !availH) return null;
  const w = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_PARKED_WIDTH, availW));
  const h = Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_PARKED_HEIGHT, availH));
  return { x: Math.max(0, availW - w - PANEL_PARK_MARGIN), y: PANEL_PARK_MARGIN, w, h };
}

function currentRect(): ParkRect {
  return { w: window.outerWidth, h: window.outerHeight, x: window.screenX, y: window.screenY };
}

function applyRect(win: any, r: ParkRect) {
  try { win.resizeTo(r.w, r.h); } catch { /* 不允许调整尺寸 */ }
  try { win.moveTo(r.x, r.y); } catch { /* 不允许移动 */ }
}

async function parkedOk(r: ParkRect): Promise<boolean> {
  await sleep(PARK_VERIFY_DELAY_MS);
  // 尺寸与位置都要对：只验尺寸的话，resizeTo 生效而 moveTo 被静默忽略的环境会
  // "原地缩小仍压着浮窗"还误判让位成功、跳过浮窗代挪的兜底。位置容差放宽一档
  // （浏览器对位置钳制比尺寸更常见）。
  return Math.abs(window.outerWidth - r.w) <= PARK_TOLERANCE
    && Math.abs(window.outerHeight - r.h) <= PARK_TOLERANCE
    && Math.abs(window.screenX - r.x) <= PARK_TOLERANCE * 2
    && Math.abs(window.screenY - r.y) <= PARK_TOLERANCE * 2;
}

// 挪窗口 + 校验。坑：`resizeTo/moveTo` 只对**脚本打开的窗口**生效；用户在地址栏
// 直接打开的普通标签页会被静默忽略（不报错、也不生效）。所以必须回读 outerWidth 校验，
// 并准备一条备用路径——本页挪不动时，请字幕浮窗替我们挪：它是 window.open 出来的
// 辅助窗口，具备调整窗口几何的资格（实测子窗口可以移动/缩放 opener）。
// 代劳时顺带把"原尺寸"也交给它记住：这样用户若直接关掉字幕浮窗（会话随之结束），
// 浮窗会在自己消失前把面板还原——否则面板永远卡在右上角的小窗里（它自己挪不动，
// 而唯一能替它挪的对端已经没了）。
async function parkPanelWindow(): Promise<void> {
  if (parked) return;
  const rect = parkedRect();
  if (!rect) return;
  // 让位代次：整段让位要跨好几个 await（校验 160ms、等对端最多 3s），期间用户随时可能
  // 点停止。停止会递增代次作废这次让位——否则"停止时归还几何"先跑（此时 parked 还是
  // false，白跑一趟），随后让位才完成并记账，面板就永远卡在右上角小窗里（它自己挪不动）。
  const gen = ++parkGen;
  const stale = () => gen !== parkGen;
  // 半途作废时的自行还原：本页挪得动就挪回来，挪不动时请浮窗代劳（与 restorePanelWindow 同路）
  const undo = () => { applyRect(window, before); sendToPeer({ type: '__park_host', rect: before, restore: null }); };
  const before = currentRect();
  applyRect(window, rect);
  if (await parkedOk(rect)) {
    if (stale()) { undo(); return; }
    markParked(before);
    return;
  }
  if (stale()) { undo(); return; }

  // 本页自己挪不动（普通标签页）。等浮窗握手完成后请它代劳——它是 window.open
  // 出来的脚本窗口，有权调整窗口几何，且 opener 指向本页，可以直接代调。
  if (await waitForPeer(PEER_WAIT_MS)) {
    if (stale()) { undo(); return; }
    sendToPeer({ type: '__park_host', rect, restore: before });
    if (await parkedOk(rect)) {
      if (stale()) { undo(); return; }
      markParked(before);
      return;
    }
  }
  if (stale()) return;

  if (!parkRefusedWarned) {
    parkRefusedWarned = true;
    // 真实浏览器限制，不是故障：字幕浮窗本身完全正常，只是本页不能自动让位。
    // 如实说明并给出用户自己能做的动作，而不是假装挪过了。
    void getLang().then((lang) => {
      const text = tSync(lang, 'webParkRefused');
      emitLog(text);
      // 单行日志区会被引擎日志立刻冲掉；常驻说明区才是用户读得到的位置
      const note = document.getElementById('webNote');
      if (note) { note.textContent = text; note.style.borderColor = '#f0a020'; }
    });
  }
}

// 让位成功的记账：内存 + sessionStorage 各记一份。后者是给"会话中刷新面板"准备的——
// beforeunload 已把会话与浮窗一并收掉，内存里的 restoreGeom 随旧页面消失，
// 没有这份存档，刷新后的窗口会永远停在 460×300 的小窗上。sessionStorage 正好是
// "本标签页"的作用域：刷新后还在，关掉标签页即消失，不会污染新开的页面。
function markParked(before: ParkRect) {
  restoreGeom = before;
  parked = true;
  try { sessionStorage.setItem(PARK_RESTORE_KEY, JSON.stringify(before)); } catch { /* 隐私模式等 */ }
  // 若上一次让位失败在说明区留了警告，这次成功就把它撤掉
  resetWebNote();
}

function restorePanelWindow() {
  // 作废在途的让位：它可能在"停止"之后才走完（跨 160ms 校验 + 最多 3s 等对端），
  // 那时它会把面板挪成小窗并记账，而归还流程早已跑完——面板就再也回不来了。
  parkGen++;
  if (!parked || !restoreGeom) { parked = false; return; }
  const rect = restoreGeom;
  parked = false;
  restoreGeom = null;
  try { sessionStorage.removeItem(PARK_RESTORE_KEY); } catch { /* 已被刷新路径消费 */ }
  // 两条路都走一遍：本页自己挪得动就挪（普通场景）；挪不动时由浮窗代劳
  // （脚本窗口才有权改几何）。两条路互相不干扰，谁有效谁生效。
  // 不能只按"当初是谁挪的"来选——会话结束时浮窗可能已经被关掉了（先关窗再恢复几何
  // 就会把恢复消息发给一个不存在的对端，面板永远卡在右上角小窗）。
  applyRect(window, rect);
  sendToPeer({ type: '__park_host', rect, restore: null });
}

// 字幕浮窗的开关状态：由 host 的生命周期钩子与面板的勾选框共同驱动
let subtitleWantOpen = true;

// 关掉字幕浮窗（宿主侧主动关窗的统一入口）。除关窗外还清掉通道的"对端在线"标记：
// 窗口都没了，hasPeer() 不该再返回 true——否则 waitForPeer 会立刻通过、把让位请求
// 发给一个不存在的窗口，最后报出"浏览器不允许挪窗口"这种误导性的提示。
function closeSubtitleWindowNow() {
  closeSubtitleWindow();
  resetPeerSeen();
}

function openSubtitleWindow(): Window | null {
  const existing = onSubtitleWindowRef();
  if (existing && !existing.closed) { existing.focus(); return existing; }
  // 位置：屏幕底部居中。字幕的视线习惯就在下方，且与「面板停靠右上角」错开，
  // 两者互不遮挡。位置特征同尺寸一样只在 window.open 时生效，之后由用户拖动决定。
  const scr = window.screen;
  const availW = scr?.availWidth || scr?.width || 0;
  const availH = scr?.availHeight || scr?.height || 0;
  const left = availW ? Math.max(0, Math.round((availW - SUBTITLE_WIN_WIDTH) / 2)) : null;
  const top = availH ? Math.max(0, availH - SUBTITLE_WIN_HEIGHT - 60) : null;
  const pos = (left != null && top != null) ? `left=${left},top=${top},` : '';
  const w = window.open(
    // 配对号走 URL：浮窗打开时第一个脚本就读它，双方此后只认自己的对号
    `${resolveUrl('subtitle.html')}?${PAIR_PARAM}=${encodeURIComponent(PAIR_ID)}`,
    SUBTITLE_WIN_NAME,
    // popup=yes 必须显式写：只给尺寸时部分浏览器会把它开成普通标签页而不是独立小窗，
    // 那样"浮窗"就名不副实（用户以为坏了）。toolbar/location 等一并关掉，观感同扩展的弹窗。
    `${pos}popup=yes,width=${SUBTITLE_WIN_WIDTH},height=${SUBTITLE_WIN_HEIGHT},menubar=no,toolbar=no,location=no,status=no,resizable=yes`,
  );
  setSubtitleWindowRef(w);
  // 兜底通道（无 BroadcastChannel 的老浏览器）的面板→浮窗方向靠这个引用直投
  setFallbackPeerWindow(w && !w.closed ? w : null);
  // window.open 被浏览器/扩展拦截时返回 null（没有异常）。此时字幕根本没有显示端：
  // 继续跑下去用户只会看到"识别中却什么都没有"。告知用户放行弹窗，并让宿主知道
  // "显示端不可用"（浮窗开不出来时不该让会话在没有显示端的情况下继续）。
  if (!w) {
    void getLang().then((lang) => {
      const text = tSync(lang, 'webPopupBlocked');
      emitLog(text);
      const note = document.getElementById('webNote');
      if (note) { note.textContent = text; note.style.borderColor = '#f0a020'; }
    });
    return null;
  }
  return w;
}

// —— 跨窗口通道：字幕浮窗回来的消息（锁定切换、浮窗关闭）——
setChannelPairId(PAIR_ID);
initChannel('panel', (msg) => handleFromSubtitle(msg), () => {
  // 浮窗重新握手（首次连接、或面板刷新后靠心跳自愈）：补推偏好与当前状态，
  // 否则刷新过的面板会把"仍活着的浮窗"留在一个没有显示设置的空白状态。
  void primeSubtitlePrefs();
  sendToPeer({ type: 'STATUS_CHANGED', status: getSessionStatus() });
  // 顺带补当前句：浮窗刚开/刚刷新时字幕区是空的，不补这一段要等用户说下一句才有字
  //（扩展侧由 background 在开窗后发 RESEND_CURRENT_TEXT，Web 版由这里对应）。
  resendCurrentText();
});

// 对端（字幕浮窗）失联：浮窗被手动导航到别的网址、或被浏览器丢弃时，同源通道随之消失。
// 此时会话还在跑，字幕却没有显示端——与"用户关掉浮窗"是同一后果，按同一语义收尾。
// 只在"本该有浮窗"时才处理：用户主动取消勾选「显示字幕」是明确的隐藏意图，通道静默
// 是预期的（closeSubtitleWindowNow 已把 peerSeen 清掉，用窗口引用判空更直接）。
setPeerLostHandler(() => {
  if (!subtitleWantOpen) return;
  // 显示端还在（窗口未关闭、也没被导航走，只是暂时没握手）：再等下一轮
  if (isSubtitleWindowUsable()) return;
  // 只有会话真的在跑才收尾：空闲时浮窗失联（用户自己导航走了）不该报"识别已停止"
  if (!isSessionActive()) return;
  stopSession();
  void getLang().then((lang) => emitLog(tSync(lang, 'webSubtitleLost')));
});

// —— 会话生命周期钩子（面板窗口几何 + 字幕浮窗开关）——
setSessionLifecycleHooks({
  onSessionRunning() {
    // 会话真正起来了：把面板让开，让字幕浮窗独占视线（同扩展"自动开悬浮窗 + 最小化原窗"）
    if (subtitleWantOpen) void parkPanelWindow();
  },
  onSessionStopped() {
    restorePanelWindow();
  },
  onSubtitlesVisibility(visible) {
    // 面板的「显示字幕」= 字幕浮窗开关。关掉就真的关窗（扩展里对应"页内叠层隐藏"，
    // Web 没有页内叠层，留着只会是一个空白浮窗）。
    // 这是"隐藏字幕"，不是"结束识别"——面板里还有实时预览与字幕记录，识别继续跑
    // （与扩展勾掉「显示字幕」的语义一致）；closeSubtitleWindow 会标记"这次是我们关的"，
    // 不让回来的 __subtitle_closed 把会话也停掉。
    subtitleWantOpen = visible;
    setSubtitleWanted(visible); // 宿主据此区分"用户想隐藏字幕"与"显示端意外消失"
    const chk = document.getElementById('chkOverlay') as HTMLInputElement | null;
    if (chk && chk.checked !== visible) chk.checked = visible;
    if (visible) {
      openSubtitleWindow();
      // 重新显示字幕时若会话还在跑，要把面板重新让开：隐藏那一步已经把几何还原了
      //（见下方），不重新让位的话新浮窗会被面板压住。
      if (isSessionActive()) void parkPanelWindow();
    } else {
      closeSubtitleWindowNow();
      // 隐藏字幕 = 用户想回到面板。让位状态一并撤回，否则面板仍停在小窗、
      // 而能替它还原的浮窗刚好被我们关掉（它就永远卡在那儿了）。
      restorePanelWindow();
    }
  },
});

// —— 宿主钩子 ——
const hooks: PanelHostHooks = {
  // 「开始」按钮的第一件事，必须发生在用户手势内：开字幕浮窗 + 预取屏幕共享流。
  // 坑：面板的启动链路里隔着 ensureAsrModel()（至少一次 fetch，首次还要下载 412MB），
  // 等它结束再调 getDisplayMedia 会因"缺少瞬时用户激活"被浏览器直接拒绝——
  // 所以这两件事都必须在点击任务的最前面做掉。
  async prepareStart(source) {
    syncSubtitleOpenFlag();
    // 环境门卫必须排在**取音频之前**：sherpa 的 wasm 需要 SharedArrayBuffer（只在
    // crossOriginIsolated 下可用）。面板里的那道检查在 prepareStart 之后才跑，若这里
    // 先弹屏幕选择器，用户共享完屏幕才被告知"环境不合格"，白共享一次（共享指示灯闪一下）。
    if (readinessReason() !== null) return {};
    // 坑：Web 版的唯一显示端就是字幕浮窗。浮窗被弹窗拦截时（window.open 返回 null），
    // 会话起来也只会是"识别中却什么都看不到"——这里如实拦下，让面板走早退路径
    // （释放已预取的流、不开无声会话），而不是让用户对着面板猜。
    if (subtitleWantOpen && !openSubtitleWindow()) return { displayUnavailable: true };
    void primeSubtitlePrefs();
    // 坑：模型没装时**绝不能先弹屏幕选择器**。首次安装模型要下载 412MB（分钟级），
    // 等它下完用户激活早已过期，preStream 只能被丢弃——屏幕上却留下过一次"已共享"
    // 的痕迹，用户观感极差。模型缺失时直接放行给面板的引导流程，并回报
    // modelPending，让引导走"装好后请用户再点一次"的显式流程。
    // 同时把刚开的浮窗收掉：这次会话起不来，留一个空浮窗只会让人以为已经开始了。
    // （用户点「开始识别」时会重新开，那一次是新窗口 + 新鲜手势。）
    if (!(await isAsrModelReady())) {
      closeSubtitleWindowNow();
      return { modelPending: true };
    }
    const stream = await preAcquireAudio(source);
    return stream ? { preStream: stream } : {};
  },

  // 本次启动半路夭折（环境不合格 / 用户取消屏幕选择 / 没有可用音源…）：
  // prepareStart 已经预开了字幕浮窗，这里必须把它收回去——否则屏幕上留着一个空浮窗，
  // 用户以为已经开始识别了，其实什么都没跑。
  startAborted() {
    closeSubtitleWindowNow();
  },

  // 音源下拉：Web 版没有"当前标签页"，摘掉该项
  customizeSources(sel) {
    sel.querySelector('option[value="tab"]')?.remove();
    if (sel.value === 'tab') sel.value = 'system';
  },

  // 系统音频提示：**Web 版不做平台限制**（用户明确要求）。
  // 扩展 offscreen 文档里只有"共享整个屏幕 + 勾系统音频"一条路，平台不支持就是真没戏；
  // 而网页里 getDisplayMedia 还能选"共享某个标签页 + 共享标签页音频"，
  // 这条路在 Linux 上也能拿到声音——所以只给操作指引，不下"不支持"的结论。
  sourceHint(source, lang) {
    if (source === 'system') return tSync(lang, 'sourceHintSystem');
    // 麦克风：扩展侧那句提示说的是"授权框弹在悬浮字幕窗上"，网页版的授权框弹在**本页**
    // （采集就发生在面板页里），照搬会指错地方。webMicHint 是网页版的说法。
    if (source === 'mic') return tSync(lang, 'webMicHint');
    return undefined;
  },

  // 模型刚装好：立刻开始注入 wasm 脚本，别等用户点「开始识别」才加载。
  // 门卫在 asr-engine 里（模型不在就跳过注入），这里只负责"装好就预热"的时序。
  onModelReady() {
    preloadEngine();
  },

  // 刚导入的识别模型本页换不掉：识别模型是在 wasm 运行时初始化那一刻被读进它的文件
  // 系统的，而整个 wasm 运行时的注入是**文档级一次性**的（重新初始化会撞上共享内存/
  // pthread 池的重复注册，见 asr-engine 的 injectWasmScripts）。扩展侧不存在这个问题——
  // 它每次停止都销毁 offscreen 文档，下次开始重建整个运行时。
  // 所以这里如实回答"需要刷新"，让引导卡把「开始识别」换成刷新提示，而不是让用户点下去
  // 却静默用旧模型跑（那是用户最无法理解的一种失败）。
  // 判据很直接：本函数在 onModelReady 之后、preloadEngine 的异步结果落地之前被调用，
  // 此刻"运行时已就绪"只可能是**上一次**就建好的（用着旧模型）——首次导入时运行时
  // 还没起来（缺模型时注入被门卫拦下），新模型会随这次预热一起装进去，不需要刷新。
  modelNeedsReload() {
    return isEngineRuntimeLoaded();
  },

  // 整页环境：引导卡必须做成带遮罩的居中大卡，"角上一张小卡"用户根本注意不到（实测）
  modelGuideStyle: 'modal',
  // 首次下载 412MB 耗以分钟计，点「开始」那次手势早已过期，自动续跑必然失败；
  // 改成卡片上显式的「开始识别」主按钮（那一次点击才是新鲜手势）
  manualRestartAfterModel: true,

  // 文案定制：把以"浏览器之外/标签页"为前提的话术换成 Web 版说法。
  // 每次 applyLang 都会重跑（含语言切换），所以环境提示也在这里跟着语言刷新。
  customizeText(lang) {
    const tip = document.getElementById('sourceTip');
    if (tip) tip.textContent = tSync(lang, 'webSourceTip');
    (window as any).__easysubRefreshReadiness?.(lang);
  },
};

function syncSubtitleOpenFlag() {
  const chk = document.getElementById('chkOverlay') as HTMLInputElement | null;
  if (chk) subtitleWantOpen = chk.checked;
  setSubtitleWanted(subtitleWantOpen);
}

// 面板刷新自愈：上一场会话把窗口挪成了右上角小窗，页面刷新后内存里的恢复路径已随
// 旧页面消失。这里从 sessionStorage 的存档补一次还原。会话本体已随刷新终止
// （引擎就住在本页面），所以这条还原总是安全的、也不需要恢复任何会话状态。
try {
  const savedRect = sessionStorage.getItem(PARK_RESTORE_KEY);
  if (savedRect) {
    sessionStorage.removeItem(PARK_RESTORE_KEY);
    const rect = JSON.parse(savedRect) as ParkRect;
    if (rect && rect.w > 0 && rect.h > 0) applyRect(window, rect);
  }
} catch { /* 坏数据/隐私模式：忽略，窗口停在原样 */ }

// —— 启动 ——
installWebHost();
mountPanel(hooks);
preloadEngine(); // 内部自带"未隔离则不预热"的守卫（见 web/host.ts）
void primeSubtitlePrefs();

// 面板关闭/刷新：引擎随页面一起消失，先让浮窗停机并通知它（避免留下一个再也收不到字幕的空窗）
window.addEventListener('beforeunload', () => {
  sendToPeer({ type: '__panel_unload' });
  closeSubtitleWindow();
  stopChannel();
});

// 「打开字幕浮窗」按钮（Web 版头部）——点击本身就是用户手势，window.open 合法。
// 勾选态走共享面板的原生 change 处理：savePrefs 落库 + OVERLAY_TOGGLE 生效，
// 不然偏好记账漂移（勾选框变了、prefs 里还是旧值，刷新后回不到一致状态）。
document.getElementById('btnWebOpenFloat')?.addEventListener('click', () => {
  subtitleWantOpen = true;
  setSubtitleWanted(true);
  const chk = document.getElementById('chkOverlay') as HTMLInputElement | null;
  if (chk && !chk.checked) {
    chk.checked = true;
    // 走共享面板那条原生 onchange：落库 overlayVisible + OVERLAY_TOGGLE → 宿主开窗。
    // 不自己写 storage 的话，偏好里仍是旧的 false，下次开始又不开窗（用户会以为按钮没生效）。
    chk.dispatchEvent(new Event('change'));
  }
  openSubtitleWindow();
});

// 坑：这里**不要**再挂一个 chkOverlay 的 change 监听去开关窗口。面板自身的
// chkOverlay.onchange 已经会发 OVERLAY_TOGGLE → 宿主钩子 onSubtitlesVisibility → 开关窗口。
// 两处都做的话，本地那次会先关窗（走 closeSubtitleWindowNow，标记"是我们关的"），
// 随后到达的 __subtitle_closed 虽有标记护着不会停会话，但两条路径的记账会打架：
// 一处记 subtitleWantOpen=true 另一处刚关完窗，勾选态与窗口实际状态就此发散。
// 单一入口才是正确做法（勾掉「显示字幕」本就不该结束识别，那一头已由 subtitleWanted 保证）。

// —— 启动前置条件自检：把"点开始必然失败"的原因在页面加载时就摆到用户眼前 ——
// 两个条件缺一不可，且都不是用户能猜到的：
//   ① 安全上下文：http:// 非本机时 getUserMedia / getDisplayMedia 根本不存在；
//   ② 跨源隔离：sherpa 的 wasm 是 pthreads 构建，需要 SharedArrayBuffer，
//      而 SAB 只在 crossOriginIsolated 下可用（静态托管靠 coi-serviceworker.js 补）。
// 检测放在加载时而不是点「开始」时，用户一进页面就知道要不要先处理环境。
// 坑：提示必须写进 #webNote（常驻说明区），**不能**写进 #modelStatus ——
// 后者是引擎日志的单行出口，wasm 预热/"模型尚未安装"等日志会立刻把它冲掉，
// 用户根本读不到环境不合格这句最关键的提示。
// 环境不合格的原因键（null = 合格）。文案是异步取的（语言在 storage 里），
// 所以检测与渲染分开：检测同步做，渲染等语言取到再补文案。
function readinessReason(): string | null {
  if (!window.isSecureContext) return 'webNeedSecureContext';
  if (!window.crossOriginIsolated) return 'webNoIsolation';
  return null;
}

function renderReadinessHint(reason: string | null, lang: string) {
  const note = document.getElementById('webNote');
  if (!note) return;
  if (reason) {
    note.textContent = tSync(lang, reason);
    note.style.borderColor = '#f0a020';
    note.style.color = 'var(--text)';
    return;
  }
  // 环境达标：把常驻说明还原成模型提示（避免上次的不合格文案残留在页面上）
  note.textContent = tSync(lang, 'webModelNote');
  note.style.borderColor = '';
  note.style.color = '';
}

const startupReason = readinessReason();
void getLang().then((lang) => renderReadinessHint(startupReason, lang));

// 把常驻说明区恢复成"环境/模型提示"。让位失败时说明区被借去放警告，让位成功后
// 由 markParked 调它撤掉警告、还原常规提示。
function resetWebNote() {
  void getLang().then((lang) => renderReadinessHint(startupReason, lang));
}

// 隔离态就绪后（coi-serviceworker 触发的那次自动刷新之后）页面自然重启，
// 这里只需在语言切换时让提示跟着走：宿主钩子的 customizeText 会重刷。
// 把状态暴露给宿主钩子，供语言切换时重算同一段提示。
function refreshReadinessHint(lang: string) { renderReadinessHint(startupReason, lang); }
(window as any).__easysubRefreshReadiness = refreshReadinessHint;

// 调试入口（控制台里查会话状态、手动开关浮窗）
(window as any).__easysubWeb = { getSessionStatus, openSubtitleWindow, hasPeer };
