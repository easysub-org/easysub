// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
// 扩展悬浮字幕窗宿主（floating.html + floating.js）。
//
// 窗口生命周期由 background 决定（START 时按音源自动开合），本文件的职责只有三件：
//   ① 与 background 建长连接并转发消息；
//   ② mic 音源时兼任采集端（Chrome 不允许 offscreen 文档做 getUserMedia）；
//   ③ 提供宿主回调给共享浮窗外壳（SubtitleShell）。
// 界面/叠层/画中画逻辑在 src/subtitle-shell.ts 里，与纯 Web 版字幕浮窗共用同一份。
import { sendToHost } from './platform';
import { MicCapture } from './mic-capture';
import { SubtitleShell } from './subtitle-shell';

// 与 background 的长连接：窗口关闭连接自动断开，bg 侧清 floatingPort
const port = chrome.runtime.connect({ name: 'floating' });
// 坑：MV3 的 SW 空闲会终止并断开所有端口——悬浮窗不能就此失聪。
// 断线后整页重载：init 重建连接，bg 的 floating 分支会补发 STATUS_CHANGED
// 并让 offscreen 重发当前句文本，UI 状态从 storage 还原。3s 防抖避免重载循环。
(window as any).__tmFloatLoaded = Date.now();
port.onDisconnect.addListener(() => {
  if (Date.now() - (window as any).__tmFloatLoaded > 3000) window.location.reload();
});

// ---- 麦克风采集宿主（mic 音源）----
// Chrome 不允许 offscreen 文档做 getUserMedia 麦克风采集（直接 NotAllowedError），
// 权限气泡也只能出现在可见窗口——所以 mic 模式下本窗口兼任采集端：PCM 以 16k 单声道
// 出块，交 bg 转发给 offscreen 的识别管道。首次使用的授权弹窗就挂在本窗口上。
// 采集实现走共享的 mic-capture.ts（Web 版同一份），本文件只管"采集端在哪"这个宿主差异。
const micHost = new MicCapture({
  // pushMs：悬浮窗可能被用户最小化或压在别的窗口后面（置顶画中画时原窗就是最小化的）。
  // 被最小化/隐藏的窗口 setTimeout 会被 Chrome 节流，pull 模式下麦克风音频只进不出、
  // 识别静默停摆——所以这一端也交给音频线程自己按 60ms 出块。
  // 麦克风链路不参与"flush 往返延迟"的测量（recordLatency 只服务引擎的系统/标签页采集），
  // 因此这里开 push 不会让任何指标失真。
  pushMs: 60,
  onChunk: (f32, sampleRate) => {
    // 坑：chrome.runtime.Port 的 postMessage 走 JSON 结构化克隆，ArrayBuffer 会被
    // 序列化成空对象（byteLength 丢失、字节内容全无），PCM 静默变垃圾。
    // 必须转成普通数组传（Float32 样本经 JSON 是保值的），接收端再还原 Float32Array。
    try {
      port.postMessage({ type: 'MIC_CHUNK', audio: Array.from(f32), sampleRate });
    } catch { /* 端口瞬断（窗口正在关闭），下一块继续 */ }
  },
  onError: (name, error) => {
    // 文案走 i18n（双语）：权限被拒与其它失败分开表述，前者额外给出补救入口
    try { port.postMessage({ type: 'MIC_RESULT', ok: false, name, error }); } catch { /* 端口已断，bg 侧自会停会话 */ }
  },
});

const shell = new SubtitleShell({
  storageKey: 'tmspeech_overlay_floating',
  onStop: () => {
    // 工具条停止按钮：交 background 走统一清理（关 offscreen、停采集、关本窗口）
    sendToHost({ type: 'STOP_RECOGNITION' }).catch(() => {});
  },
  onFontSize: (size) => {
    // 字号也要回写面板偏好（面板侧会带到 storage），浮窗自己那份已由 shell 落库
    sendToHost({ type: 'SET_FONT_SIZE', fontSize: size }).catch(() => {});
  },
  onPipClosed: () => {
    // 用户直接关掉画中画窗口：悬浮窗是唯一显示端兼控制器，关闭即结束识别。
    sendToHost({ type: 'STOP_RECOGNITION' }).catch(() => {});
  },
  onTeardown: () => {
    // 窗口整体关闭（含被 bg 移除）：轨道随之释放，避免麦克风指示灯常亮
    micHost.stop();
  },
  onPinned: async () => {
    // 坑：画中画窗口不能比 opener 活得久——原窗口必须存活，无法"关掉"。
    // 置顶成功后把它最小化藏进任务栏，桌面上就只剩置顶的字幕画中画窗口；
    // 若用户此后再从任务栏恢复/关闭原窗，bg 的 windows.onRemoved 仍会兜底停识别。
    try {
      const win = await chrome.windows.getCurrent();
      if (win?.id != null) await chrome.windows.update(win.id, { state: 'minimized' });
    } catch { /* 最小化失败不影响置顶使用 */ }
  },
  onRestoreHostWindow: () => {
    // 取消置顶：把原窗口恢复到前台
    chrome.windows.getCurrent().then((win) => {
      if (win?.id != null) chrome.windows.update(win.id, { state: 'normal', focused: true });
    }).catch(() => {});
  },
});

// ---- 消息处理 ----
port.onMessage.addListener((msg: any) => {
  if (msg?.type === 'MIC_CAPTURE_START') { void micHost.start(); return; }
  if (msg?.type === 'MIC_CAPTURE_STOP') { micHost.stop(); return; }
  shell.handle(msg);
});

// 窗口关闭/重载即停采集：轨道随之释放，避免麦克风指示灯常亮
window.addEventListener('pagehide', () => micHost.stop());

shell.init();
