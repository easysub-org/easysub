// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
// 字幕浮窗外壳（扩展悬浮窗 + 纯 Web 版字幕浮窗共用）。
//
// 两个宿主只有三点不同，其余（叠层、工具条、字号、画中画置顶、消息分发）完全一样：
//   ① 消息从哪来/往哪去 —— 扩展走 chrome.runtime Port，Web 走 window.postMessage 通道；
//   ② 窗口是 chrome.windows 弹窗还是 window.open 的浏览器窗口（影响"取消置顶时恢复前台"）；
//   ③ 关窗/关画中画时是"结束会话"还是"仅停止显示"。
// 这三点全部由调用方以回调注入，本文件不出现任何宿主 API。
import { getLang, tSync } from './i18n';
import { Overlay } from './overlay';
import { storage } from './platform';

const FS_MIN = 18;
const FS_MAX = 72;

export interface SubtitleShellOptions {
  // 叠层的位置持久化键：扩展悬浮窗与 Web 浮窗各自独立，避免互相覆盖坐标
  storageKey: string;
  // 工具条按钮 → 宿主的消息出口（停止识别 / 字号同步 / 取消置顶恢复前台等）
  onStop: () => void;
  onFontSize?: (size: number) => void;
  // 画中画窗口被用户直接关掉
  onPipClosed?: () => void;
  // 取消置顶后把原窗口恢复到前台（扩展用 chrome.windows，Web 用 window.focus；可不传）
  onRestoreHostWindow?: () => void;
  // 浮窗被关闭前的收尾（Web 版通知面板）
  onTeardown?: () => void;
  // 置顶成功后的宿主动作：扩展把原窗口最小化进任务栏；Web 版无此能力，不传即可
  onPinned?: () => void;
  // 叠层里点锁定后上行给面板（扩展走 chrome.runtime，Web 走跨窗口通道）
  onLockChanged?: (locked: boolean) => void;
}

export class SubtitleShell {
  private opts: SubtitleShellOptions;
  private pipRoot: HTMLElement;
  private btnPin: HTMLButtonElement | null;
  private btnFontUp: HTMLButtonElement | null;
  private btnFontDown: HTMLButtonElement | null;
  private btnStop: HTMLButtonElement | null;
  private overlay: Overlay;

  private lang = 'zh_CN';
  private fontSize = 34;
  private running = false;
  private pipWin: Window | null = null;

  // Document PiP 入口：按规范 [Exposed=Window] 只挂在 window 上
  // （document.documentPictureInPicture 恒为 undefined）；document 仅作兜底兼容。
  private dpi = (window as any).documentPictureInPicture || (document as any).documentPictureInPicture;

  constructor(opts: SubtitleShellOptions) {
    this.opts = opts;
    const $ = (id: string) => document.getElementById(id);
    this.pipRoot = $('pipRoot')!;
    this.btnPin = $('btnPin') as HTMLButtonElement | null;
    this.btnFontUp = $('btnFontUp') as HTMLButtonElement | null;
    this.btnFontDown = $('btnFontDown') as HTMLButtonElement | null;
    this.btnStop = $('btnStop') as HTMLButtonElement | null;

    this.overlay = new Overlay({
      storageKey: opts.storageKey,
      mountTarget: () => this.pipRoot,
      trackFullscreen: false,
      fill: true,
      onLockChanged: opts.onLockChanged,
    });
  }

  // 消息入口：显示类交给共享叠层（协议与页内 content.ts 完全一致），
  // 状态类由浮窗自用（停止按钮可用态）。
  handle(msg: any) {
    if (msg?.type === 'STATUS_CHANGED') {
      this.running = msg.status === 'Running';
      if (this.btnStop) this.btnStop.disabled = !this.running;
    }
    this.overlay.handle(msg);
  }

  // 初始化：**同步部分（界面 + 按钮绑定）必须先跑完，再去读偏好**。
  // 坑：早先把 wire() 放在 await getLang() 之后，一旦存储读取抛错（file:// 下 localStorage
  // 被禁、隐私模式等），await 直接中断 init，wire 永不执行——置顶/字号/停止按钮全部没反应，
  // 表现为"浮窗打开就是死的、没有置顶模式"。用户可见的界面必须在任何 await 之前可用。
  init() {
    // 浮窗仅在识别会话中存在，落地即建叠层
    this.overlay.create();
    // 叠层与工具条同为最高 z-index、靠 DOM 顺序分胜负——把工具条挪到叠层之后，确保浮于其上
    const toolbar = document.querySelector('.toolbar');
    if (toolbar) this.pipRoot.appendChild(toolbar);
    this.wire();
    this.applyLang();
    void this.loadPrefs();
  }

  // 异步读偏好：失败只影响字号/语言，不影响按钮可用性
  private async loadPrefs() {
    try {
      this.lang = await getLang();
      const pr = await storage.get('tmspeech_prefs');
      const prefs = (pr['tmspeech_prefs'] as any) || {};
      if (typeof prefs.fontSize === 'number') {
        this.fontSize = Math.min(FS_MAX, Math.max(FS_MIN, prefs.fontSize));
        this.overlay.handle({ type: 'SET_FONT_SIZE', fontSize: this.fontSize });
      }
      this.applyLang();
    } catch { /* 读不到走默认字号与中文 */ }
  }

  private wire() {
    const dpi = this.dpi;
    if (this.btnPin) {
      if (!dpi) {
        // 老浏览器无 Document PiP：隐藏置顶按钮，窗口仍是普通的可缩放浮窗
        this.btnPin.style.display = 'none';
      }
      this.btnPin.onclick = () => {
        if (this.pipWin) { this.exitPip(); return; }
        if (!dpi) return;
        this.pinToPip().catch((e) => console.log('[EasySub] 置顶失败:', e));
      };
    }
    if (this.btnFontUp) this.btnFontUp.onclick = () => {
      this.fontSize = Math.min(FS_MAX, this.fontSize + 2);
      this.persistFontSize();
    };
    if (this.btnFontDown) this.btnFontDown.onclick = () => {
      this.fontSize = Math.max(FS_MIN, this.fontSize - 2);
      this.persistFontSize();
    };
    if (this.btnStop) this.btnStop.onclick = () => this.opts.onStop();

    // 注：曾经的"首次点击窗口任意位置自动置顶"已按用户要求移除——任意点击就进画中画
    // 属于意外触发重灾区（拖拽选字/误点都中招）。置顶只走工具条的图钉按钮（本身就在
    // 用户手势内，满足 requestWindow 的手势要求）。

    // 用户直接关掉画中画窗口：浮窗是唯一显示端兼控制器，关闭即结束会话/停止显示
    window.addEventListener('pagehide', () => {
      this.opts.onTeardown?.();
    });
  }

  private copyStylesTo(w: Window) {
    // 窗口内所有 <style> 克隆进 PiP 文档（含本页内联样式），保证字幕观感一致
    document.querySelectorAll('style').forEach((s) => {
      w.document.head.appendChild(s.cloneNode(true));
    });
  }

  private updatePinButton() {
    if (!this.btnPin) return;
    this.btnPin.classList.toggle('pinned', !!this.pipWin);
    this.applyLang();
  }

  private onPipHide = () => {
    this.pipWin = null;
    this.opts.onPipClosed?.();
  };

  // 把画中画搬回本窗口并恢复（取消置顶）。仅由工具条「置顶/取消置顶」按钮触发；
  // 用户直接关掉画中画窗口走 onPipHide。
  private exitPip() {
    if (!this.pipWin) return;
    const w = this.pipWin;
    this.pipWin = null;
    w.removeEventListener('pagehide', this.onPipHide);
    try { w.close(); } catch { /* 已在关闭中 */ }
    document.body.appendChild(this.pipRoot);
    this.updatePinButton();
    // 恢复原窗口到前台（置顶时它被最小化/被压到后面）
    this.opts.onRestoreHostWindow?.();
  }

  private async pinToPip() {
    // requestWindow 必须由用户手势触发：按钮点击满足；无手势会直接 NotAllowedError
    const w: Window = await this.dpi.requestWindow({
      width: Math.max(360, Math.round(window.outerWidth)),
      height: Math.max(120, Math.round(window.outerHeight)),
    });
    this.copyStylesTo(w);
    this.pipWin = w;
    w.document.body.append(this.pipRoot);
    w.addEventListener('pagehide', this.onPipHide);
    this.updatePinButton();
    // 坑：画中画窗口不能比 opener 活得久——原窗口必须存活，无法"关掉"。
    // 置顶成功后把它藏起来（扩展侧最小化进任务栏），桌面上就只剩置顶的字幕画中画窗口。
    this.opts.onPinned?.();
  }

  private persistFontSize() {
    this.overlay.handle({ type: 'SET_FONT_SIZE', fontSize: this.fontSize });
    this.opts.onFontSize?.(this.fontSize);
    storage.get('tmspeech_prefs').then(r => {
      const prefs = (r['tmspeech_prefs'] as any) || {};
      storage.set({ tmspeech_prefs: { ...prefs, fontSize: this.fontSize } });
    });
  }

  // 供宿主/调试查询当前置顶状态（画中画窗口是否打开）
  isPinned(): boolean { return !!this.pipWin; }

  // 面板改了字号/上一句等偏好时同步进来（宿主把消息透传给本方法即可）
  private applyLang() {
    const tr = (key: string) => tSync(this.lang, key);
    if (this.btnPin) {
      this.btnPin.title = this.pipWin ? tr('floatUnpin') : tr('floatPin');
      this.btnPin.setAttribute('aria-label', this.btnPin.title);
    }
    if (this.btnFontUp) this.btnFontUp.title = tr('floatFontUp');
    if (this.btnFontDown) this.btnFontDown.title = tr('floatFontDown');
    if (this.btnStop) {
      this.btnStop.title = tr('btnStop');
      this.btnStop.setAttribute('aria-label', tr('btnStop'));
    }
    document.title = tr('appTitle');
  }
}
