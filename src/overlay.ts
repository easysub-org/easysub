// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
import { tSync } from './i18n';
import { storage, sendToHost } from './platform';

// —— 唯一事实源：页内字幕层（content.ts 注入脚本）与系统音频悬浮字幕窗（floating.ts）
// 共用同一份叠层实现，观感与交互由此天然一致，杜绝双份样式漂移。
// 宿主只需：①提供挂载目标 ②把各自消息入口接到 handle() ③决定何时 create()/destroy()。

export type OverlayBgMode = 'glass' | 'solid' | 'outline';

export interface OverlayOptions {
  // 拖拽位置持久化键：内容页与悬浮窗各自独立（避免互相覆盖坐标）
  storageKey?: string;
  // 挂载目标工厂（默认 document.body）：内容页用它做全屏迁移，悬浮窗挂进 pipRoot
  mountTarget?: () => HTMLElement;
  // 内容页需要监听 fullscreenchange 做全屏迁移，悬浮窗不需要
  trackFullscreen?: boolean;
  // 填充模式（悬浮窗/画中画宿主）：叠层铺满宿主窗口，拖边缩放窗口即缩放字幕区域
  // ——"字幕窗口与悬浮窗共同调节大小"的核心语义。页内卡片式的自由拖拽与
  // 位置持久化在此模式下无意义（要挪字幕直接挪窗口），一并关闭。
  fill?: boolean;
  // 填充模式的定位方式：默认 fixed + 100vw/100vh（宿主 = 整个窗口，扩展悬浮窗用）。
  // 纯 Web 版的字幕舞台只是页面里的一块区域，fixed 的百分比会按视口解析而溢出，
  // 故置 true 改为 absolute + 100%（宿主元素需自带 position:relative）。
  absoluteFill?: boolean;
  // 叠层内点了锁定按钮后的上行通道。扩展 = chrome.runtime.sendMessage（默认实现）；
  // 纯 Web 版的字幕浮窗与面板是**两个窗口**，chrome 消息不存在，必须换成跨窗口通道，
  // 否则浮窗里点锁定面板毫无反应（静默失效）。
  onLockChanged?: (locked: boolean) => void;
}

const BG_MODES: OverlayBgMode[] = ['glass', 'solid', 'outline'];

const LOCK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></svg>';
const UNLOCK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8.5 11V7a3.5 3.5 0 0 1 6.5-2"/></svg>';
const CHEVRON_UP_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
const CHEVRON_DOWN_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

// —— 延迟指示器 ——
// 颜色阈值（调整入口）：绿=优秀 <LATENCY_LOW_MS；黄=中 LOW–HIGH；红=高 >HIGH。
const LATENCY_LOW_MS = 200;
const LATENCY_HIGH_MS = 1000;
const LATENCY_GREEN = '#34c759';
const LATENCY_YELLOW = '#ffcc00';
const LATENCY_RED = '#ff3b30';
// 近句回看缓冲上限：转写内容可能涉及隐私，刻意只放内存、不写任何 storage，
// 随宿主销毁一并丢弃；跨会话留痕交给 popup 里已有的 tmspeech_transcript。
const RECENT_MAX = 10;

function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

export class Overlay {
  private storageKey: string;
  private mountTarget: () => HTMLElement;
  private trackFullscreen: boolean;
  private fill = false;
  private absoluteFill = false;
  private onLockChanged: ((locked: boolean) => void) | null;

  private overlay: HTMLDivElement | null = null;
  private prevEl: HTMLDivElement | null = null;
  private textEl: HTMLDivElement | null = null;
  private transEl: HTMLDivElement | null = null; // 实时翻译行（可选，位于当前句下方）
  private prevTransEl: HTMLDivElement | null = null; // 上一句最终译文行（可选）
  private lockBtn: HTMLButtonElement | null = null;
  private _locked = false;
  private _showPrev = true;
  private _prevOpacity = 0.35;
  private _pendingText = '';
  // 最近一次 SENTENCE_DONE 的句序号（offscreen 下发；0=尚未见到完成句）。
  // 当前句序号 = lastDoneSeq + 1，译文消息按序号路由到当前句行或上一句行。
  private lastDoneSeq = 0;
  private recentSentences: { text: string; tr?: string; seq?: number }[] = []; // 新句在前，环形截断 RECENT_MAX
  private reviewBtn: HTMLButtonElement | null = null;
  private reviewPanel: HTMLDivElement | null = null;
  private reviewOpen = false;
  private reviewCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private _lang = 'zh_CN';
  private _lookbackEnabled = true;
  private _latencyEnabled = true;
  private _overlayBgMode: OverlayBgMode = 'glass';
  private _lastLatencyMs: number | null = null;
  private latencyWrap: HTMLDivElement | null = null;
  private latencyDot: HTMLDivElement | null = null;
  private latencyText: HTMLSpanElement | null = null;
  private latencyTip: HTMLDivElement | null = null;
  private dragState: {
    baseLeft: number; baseTop: number;
    startX: number; startY: number;
    // 最近一次经边界 rubberband 钳制后的位移。pointerup 落盘必须用它，
    // 而不是拿 e.clientX 重算——setPointerCapture 下指针可在窗口外释放，
    // 原始坐标不带钳制，松手瞬间叠层会"飞"出屏幕并被持久化（字幕从此找不到）。
    lastDx: number; lastDy: number;
  } | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: OverlayOptions = {}) {
    this.storageKey = options.storageKey || 'tmspeech_overlay';
    this.trackFullscreen = options.trackFullscreen !== false;
    this.fill = options.fill === true;
    this.absoluteFill = options.absoluteFill === true;
    this.onLockChanged = options.onLockChanged ?? null;
    this.mountTarget = options.mountTarget
      || (() => (this.trackFullscreen ? this.fullscreenMount() : document.body));
    if (this.trackFullscreen) {
      // 进/出全屏时迁移挂载点（重复副本各自注册，appendChild 幂等，仅一层叠层）
      document.addEventListener('fullscreenchange', this.mountOverlay);
    }
  }

  // 全屏挂载：页面进 HTML5 全屏后，浏览器只绘制全屏元素，body 下其他节点不渲染，
  // 所以 bilibili 等站全屏视频时字幕会被盖掉。media 元素 append 子节点会被当作回退内容
  // 忽略，故就近挂到其祖先容器。position:fixed 不随父容器变化，坐标语义不变。
  private fullscreenMount(): HTMLElement {
    let el: HTMLElement | null = document.fullscreenElement as HTMLElement | null;
    while (el && /^(VIDEO|AUDIO|IFRAME|EMBED|OBJECT)$/.test(el.tagName)) {
      el = el.parentElement;
    }
    return el || document.body;
  }

  private mountOverlay = () => {
    if (!this.overlay) return;
    this.mountTarget().appendChild(this.overlay);
  };

  create() {
    // 坑：存活判据必须是 isConnected，不能只判 this.overlay 非空。节点可能已经
    // "被移出 DOM"（宿主页面 SPA 换页重建容器、全屏迁移时挂载点被替换、或更新的
    // 副本在 create() 里摘除同 id 节点），而本实例的引用仍非空——只判非空会让
    // create() 永久早退：既画不出字幕，又让后续 OVERLAY_TOGGLE 的"复活"全部失效，
    // 表现为字幕突然消失且再也回不来（直到刷新）。此处改为发现节点已游离就重建。
    if (this.overlay && this.overlay.isConnected) return;
    if (this.overlay) { this.overlay.remove(); this.overlay = null; }
    const overlay = document.createElement('div');
    overlay.id = 'tmspeech-overlay';
    this.overlay = overlay;
    const s = overlay.style;
    s.position = this.absoluteFill ? 'absolute' : 'fixed';
    s.zIndex = '2147483647';
    s.padding = '24px 32px';
    s.background = 'rgba(10,10,20,0.75)';
    s.backdropFilter = 'blur(16px) saturate(180%)';
    (s as any).webkitBackdropFilter = 'blur(16px) saturate(180%)';
    s.borderRadius = '16px';
    s.border = '1px solid rgba(255,255,255,0.08)';
    s.minWidth = '200px';
    s.maxWidth = '900px';
    s.overflow = 'hidden';
    s.userSelect = 'none';
    s.fontFamily = 'system-ui,-apple-system,sans-serif';
    s.boxShadow = '0 8px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04)';
    s.left = '50%';
    s.top = '50%';
    s.transform = 'translate(-50%, -50%)';
    if (this.fill) {
      // 填充模式：叠层 = 宿主窗口本身。字幕区域随窗口缩放（无独立宽高/圆角/居中偏移），
      // 文案用 flex 居中排布成"字幕条"观感；锁定/回看/延迟指示等绝对定位子元素不受影响。
      s.left = '0';
      s.top = '0';
      s.transform = 'none';
      // absoluteFill：宿主是页面里的一块区域而非整个窗口，百分比必须按宿主盒解析，
      // 用 100vw/100vh 会按视口算而溢出到宿主之外（Web 版字幕舞台用这条）。
      s.width = this.absoluteFill ? '100%' : '100vw';
      s.height = this.absoluteFill ? '100%' : '100vh';
      s.minWidth = '0';
      s.maxWidth = 'none';
      s.borderRadius = '0';
      s.display = 'flex';
      s.flexDirection = 'column';
      s.justifyContent = 'center';
      s.alignItems = 'center';
      s.textAlign = 'center';
    }
    // 坑：上面内联样式写死的是 glass 观感，而 paintOverlayChrome 此前只在下方异步
    // storage 回调里才跑——solid/outline 用户每次创建叠层都会先闪一帧旧毛玻璃再切换。
    // 同步体内按当前 _overlayBgMode 立即重涂一次；异步回调读到的 prefs 若不同会再次覆盖。
    this.paintOverlayChrome();

    storage.get('tmspeech_locked').then(r => {
      if (r.tmspeech_locked) { this._locked = true; this.applyLock(); }
    });

    storage.get('tmspeech_prefs').then(r => {
      const prefs = (r['tmspeech_prefs'] as any) || {};
      this._showPrev = prefs.showPrev !== false;
      this._prevOpacity = (prefs.prevOpacity ?? 35) / 100;
      this._lookbackEnabled = prefs.lookbackEnabled !== false;
      this._latencyEnabled = prefs.latencyIndicatorEnabled !== false;
      const bgMode = prefs.overlayBgMode as OverlayBgMode;
      if (BG_MODES.includes(bgMode)) this._overlayBgMode = bgMode;
      this.applyFeatureToggles();
      this.paintOverlayChrome();
    });

    this.prevEl = document.createElement('div');
    this.textEl = document.createElement('div');
    storage.get(['tmspeech_prefs', 'tmspeech_lang']).then(r => {
      const prefs = (r['tmspeech_prefs'] as any) || {};
      this._lang = (r['tmspeech_lang'] as string) || 'zh_CN';
      const fs = prefs.fontSize || 36;
      // 字幕文字阴影随外观模式走：outline 模式靠多向描边阴影保证任意背景可读
      const baseStyle = `color:#fff;font-size:${fs}px;font-weight:600;line-height:1.4;text-shadow:${this.subtitleShadow()};word-break:break-word;`;
      if (this.prevEl) {
        this.prevEl.style.cssText = baseStyle;
        this.prevEl.style.display = 'none';
        this.prevEl.style.opacity = String(this._prevOpacity);
      }
      if (this.textEl) {
        this.textEl.style.cssText = baseStyle;
        // 坑：这里**不能**再写"正在加载模型"当占位文案。它是硬编码的、与真实阶段无关：
        // 模型常驻复用后根本没有加载动作，用户却先看到"正在加载模型"、再被真实状态覆盖，
        // 观感上就是提示错乱。状态一律由 offscreen 在真实转换点经 STATUS_TEXT 下发。
        // ponytail: _pendingText 处理 TEXT_CHANGED 先于 overlay 创建（重连时），create 后立即替换
        if (this._pendingText) { this.textEl.textContent = this._pendingText; this._pendingText = ''; }
      }
      if (this.transEl) {
        this.transEl.style.fontSize = Math.round(fs * 0.6) + 'px';
        this.transEl.style.textShadow = this.subtitleShadow();
      }
    });
    overlay.appendChild(this.prevEl);
    overlay.appendChild(this.textEl);

    // 翻译行：跟随字幕字号缩放、随外观模式取描边阴影；无翻译时隐藏不占位
    this.transEl = document.createElement('div');
    this.transEl.style.cssText = [
      'color:#8ec9ff;font-weight:500;line-height:1.4;margin-top:2px;',
      'word-break:break-word;display:none;',
    ].join('');
    overlay.appendChild(this.transEl);

    // 上一句最终译文行：跟随上一句展示区（prevEl）的透明度基调，字号同当前句译文
    this.prevTransEl = document.createElement('div');
    this.prevTransEl.style.cssText = [
      'color:#8ec9ff;font-weight:500;line-height:1.4;margin-top:1px;',
      'word-break:break-word;display:none;',
    ].join('');
    overlay.appendChild(this.prevTransEl);

    this.addLockButton();
    // 开关默认开，先按内存偏好挂载；prefs 异步到达后 applyFeatureToggles 会校正
    if (this._lookbackEnabled) this.addReviewHandle();
    if (this._latencyEnabled) this.addLatencyIndicator();
    // 填充模式下叠层铺满窗口，窗口内拖拽无意义（挪字幕=挪窗口），跳过拖拽绑定
    if (!this.fill) this.addDragListeners();
    this.applyLock();
    // 兜底：清掉历史副本可能残留的同 id 节点（如扩展重载前的旧实例），防止视觉上叠加
    document.getElementById('tmspeech-overlay')?.remove();
    this.mountOverlay();
    // 位置/尺寸持久化只属于页内卡片模式；填充模式尺寸恒等于窗口尺寸，无需恢复与监听
    if (!this.fill) {
      // 坑：默认位置用 left:50% + translate(-50%,-50%) 居中，这是"依赖 transform 补偿"
      // 的中间态——若被 ResizeObserver 的**首帧回调**原样落盘，下次加载读回 left:'50%'
      // 后按恢复逻辑置 transform:'none'，叠层左上角就钉死在屏幕中心，永久偏移半宽/半高
      // （用户零操作就会被写坏）。挂载后立即把视觉位置换算成绝对像素并清除 transform，
      // 让落盘值从第一代起就是 px 坐标。
      const r = overlay.getBoundingClientRect();
      s.left = r.left + 'px';
      s.top = r.top + 'px';
      s.transform = 'none';
      const key = this.storageKey;
      storage.get(key).then(stored => {
        if (!this.overlay) return;
        const d = (stored[key] as any) || {};
        // 坑：只接受 px 值。历史版本可能落盘过 left:'50%' 这类百分比中间态，
        // 恢复它们 + transform:'none' 正是"字幕钉在屏幕中心"的成因，直接弃用走默认位。
        const px = (v: any) => typeof v === 'string' && /^-?\d+(\.\d+)?px$/.test(v.trim());
        if (px(d.left) && px(d.top)) {
          this.overlay.style.left = d.left;
          this.overlay.style.top = d.top;
        }
        if (px(d.width)) this.overlay.style.width = d.width;
        if (px(d.height)) this.overlay.style.height = d.height;
      });

      new ResizeObserver(() => this.scheduleSave()).observe(overlay);
    }
  }

  destroy() {
    if (!this.overlay) return;
    this.overlay.remove();
    this.overlay = null; this.prevEl = null; this.textEl = null; this.lockBtn = null;
    this.transEl = null; this.prevTransEl = null;
    this.reviewBtn = null; this.reviewPanel = null; this.reviewOpen = false;
    if (this.reviewCloseTimer) { clearTimeout(this.reviewCloseTimer); this.reviewCloseTimer = null; }
    this.latencyWrap = null; this.latencyDot = null; this.latencyText = null; this.latencyTip = null;
    this._lastLatencyMs = null;
    if (this.saveTimer) clearTimeout(this.saveTimer);
  }

  // 外部入口：处理来自 background 的显示消息（内容页与悬浮窗共用同一套协议）
  handle(msg: any) {
    switch (msg?.type) {
      case 'PING':
        break;
      case 'OVERLAY_TEXT':
        this.setOverlayText(msg.prev || '', msg.current || '');
        break;
      case 'TEXT_CHANGED':
        this.setText(msg.text);
        break;
      case 'STATUS_TEXT':
        // 状态文案（正在加载模型 / 正在等待音频 / 请选择共享屏幕）与字幕文本分流：
        // 只写当前字幕行，会被随后的真实字幕自然覆盖；不进回看缓冲、不参与译文绑定。
        // key 为空表示"清除状态"（例如音频已拿到、接下来就该出字了）。
        this.setText(msg.key ? tSync(this._lang, msg.key) : '');
        break;
      case 'SENTENCE_DONE':
        // 坑：只收 SENTENCE_DONE 的终版文本入回看缓冲；流式 TEXT_CHANGED 是中间态，
        // 同一句话会反复到达，入缓冲会导致列表里同一句出现多次半成品。
        if (msg.text && this._lookbackEnabled) {
          this.recentSentences.unshift({ text: String(msg.text), seq: Number(msg.seq) || undefined });
          if (this.recentSentences.length > RECENT_MAX) this.recentSentences.length = RECENT_MAX;
        }
        // 句序号推进：刚完成句的序号由 offscreen 随消息带（seq>0 用真值，缺省按本地计数兜底）
        {
          const seq = Number(msg.seq) || 0;
          this.lastDoneSeq = seq > 0 ? seq : this.lastDoneSeq + 1;
        }
        // 换句：手头的当前句译文立即移交"上一句"槽，当前行清空。
        // 坑：移交的前提是"当前句已有译文"。若该句的定稿翻译还没轮到（worker 慢），
        // 这里清空后它将以 backlog 补译的形式经 TRANSLATION_FINAL(seq) 归位到
        // prevTransEl/回看缓冲，而不是像旧实现那样永远丢掉。
        if (this.transEl && this.transEl.textContent) {
          if (this.prevTransEl) {
            this.prevTransEl.textContent = this.transEl.textContent;
            this.prevTransEl.style.opacity = String(this._prevOpacity);
            this.syncPrevTrans();
          }
          this.transEl.textContent = '';
        } else if (this.prevTransEl && this.prevTransEl.textContent) {
          // 坑（实测反馈）：当前句没有可移交的译文时（句说得快、流式译文没赶上、
          // 或仅定稿模式），上一句译文槽里挂的还是"上上句"的译文——上一句文本
          // 已换成新句，译文却停在旧句，错位悬挂。这里必须清空，
          // 等本句定稿译文经 TRANSLATION_FINAL 归位后再显示。
          this.prevTransEl.textContent = '';
          this.syncPrevTrans();
        }
        if (this.transEl) this.transEl.style.display = 'none';
        break;
      case 'TRANSLATION':
        // 流式译文按句序号路由：当前句（seq === lastDoneSeq+1）进 transEl；
        // 上一句的迟到流式结果（seq === lastDoneSeq）补进 prevTransEl，不再污染当前行。
        if (msg.text) {
          const s = Number(msg.seq) || 0;
          if (s === this.lastDoneSeq + 1 && this.transEl) {
            this.transEl.textContent = msg.text;
            this.transEl.style.display = '';
          } else if (s === this.lastDoneSeq && s > 0 && this.prevTransEl) {
            this.prevTransEl.textContent = msg.text;
            this.prevTransEl.style.opacity = String(this._prevOpacity);
            this.syncPrevTrans();
          }
        }
        break;
      case 'TRANSLATION_FINAL':
        // 定稿译文按句序号归位：
        //   seq === lastDoneSeq → 属于上一句（正常时序：句完→定稿），写上一句译文行；
        //   seq <  lastDoneSeq  → 更早句的 backlog 补译（慢速场景），只进回看缓冲，
        //                         不碰当前显示（上一句行已属于更新的句子）。
        // 无 seq（旧消息）退回"属于上一句"的旧语义。
        // 注：不存在 seq > lastDoneSeq 的定稿——offscreen 恒先发 SENTENCE_DONE 再发
        // final（同线程同端口保序），无需防御性推进序号（审查时确认后移除）。
        if (msg.text) {
          const s = Number(msg.seq) || this.lastDoneSeq;
          if (s === this.lastDoneSeq && this.prevTransEl) {
            this.prevTransEl.textContent = msg.text;
            this.prevTransEl.style.opacity = String(this._prevOpacity);
            this.syncPrevTrans();
            // 坑：不清 transEl——seq 路由保证当前行只装"当前句"（seq=lastDoneSeq+1）
            // 的流式译文，定稿属于上一句，清当前行只会把进行中的实时译文闪没。
          }
          if (this._lookbackEnabled) {
            // 回看缓冲按 seq 精确配对。坑：FW_CT 经 bg 扇出到 tab 与悬浮窗两端，
            // 端上到达顺序不保证（实测悬浮窗可能先收到 TRANSLATION_FINAL 后收到
            // SENTENCE_DONE）——该句还没入缓冲时按 seq 配对必落空，此时退回
            // "最早一条无译文句"兜底（FIFO，最老的缺口最可能就是它）。
            let target: { text: string; tr?: string; seq?: number } | undefined;
            if (s > 0) target = this.recentSentences.find(x => x.seq === s && !x.tr);
            if (!target) target = this.recentSentences.find(x => !x.tr);
            if (target) target.tr = String(msg.text);
          }
        }
        break;
      case 'LATENCY_UPDATE':
        // auditor-audio 的测量端约 2s 一条（仅 Running 时发送），经 bg 现有 FW_CT 路由到达。
        if (typeof msg.ms === 'number' && isFinite(msg.ms)) {
          this._lastLatencyMs = Math.max(0, Math.round(msg.ms));
          this.renderLatency();
        }
        break;
      case 'PREFS_PATCH': {
        // popup 开关推来的部分偏好：合并进内存并即时生效。持久化由 popup 侧负责。
        if (typeof msg.lookbackEnabled === 'boolean') this._lookbackEnabled = msg.lookbackEnabled;
        if (typeof msg.latencyIndicatorEnabled === 'boolean') this._latencyEnabled = msg.latencyIndicatorEnabled;
        if (typeof msg.overlayBgMode === 'string') this.applyOverlayStyle(msg.overlayBgMode as OverlayBgMode);
        this.applyFeatureToggles();
        break;
      }
      case 'OVERLAY_TOGGLE':
        if (msg.visible) this.create();
        else this.destroy();
        break;
      case 'LOCK_TOGGLE':
        this._locked = msg.locked;
        this.applyLock();
        break;
      case 'SET_FONT_SIZE':
        if (this.prevEl) { this.prevEl.style.fontSize = msg.fontSize + 'px'; }
        if (this.textEl) { this.textEl.style.fontSize = msg.fontSize + 'px'; this.scheduleSave(); }
        if (this.transEl) { this.transEl.style.fontSize = Math.round(msg.fontSize * 0.6) + 'px'; }
        if (this.prevTransEl) { this.prevTransEl.style.fontSize = Math.round(msg.fontSize * 0.6) + 'px'; }
        break;
      case 'SET_PREV_OPTS':
        this._showPrev = msg.showPrev;
        this._prevOpacity = (msg.prevOpacity ?? 35) / 100;
        if (this.prevEl) this.prevEl.style.opacity = String(this._prevOpacity);
        if (this.prevTransEl) { this.prevTransEl.style.opacity = String(this._prevOpacity); this.syncPrevTrans(); }
        break;
      case 'RESET_OVERLAY_POSITION':
        if (this.fill) break; // 填充模式无独立位置，重置无意义
        storage.remove(this.storageKey);
        if (this.overlay) {
          // 重置为屏幕中心。与 create() 同理：先按 50%+translate 定位，再立即换算成
          // 绝对像素并清 transform——不留"left:50% + translate(-50%)"中间态，
          // 否则会被 ResizeObserver 原样落盘，下次加载就是"字幕钉在屏幕中心"。
          this.overlay.style.left = '50%';
          this.overlay.style.top = '50%';
          this.overlay.style.transform = 'translate(-50%, -50%)';
          this.overlay.style.width = '';
          this.overlay.style.height = '';
          const r = this.overlay.getBoundingClientRect();
          this.overlay.style.left = r.left + 'px';
          this.overlay.style.top = r.top + 'px';
          this.overlay.style.transform = 'none';
        }
        this.scheduleSave();
        break;
    }
  }

  // —— 锁定 ——
  private toggleLock() {
    this._locked = !this._locked;
    storage.set({ tmspeech_locked: this._locked });
    this.applyLock();
    // 上行同步给面板与另一宿主（内容页/悬浮窗）。
    // 扩展默认走 chrome.runtime；Web 宿主通过 onLockChanged 换成跨窗口通道。
    if (this.onLockChanged) {
      this.onLockChanged(this._locked);
      return;
    }
    try { sendToHost({ type: 'LOCK_CHANGED_FROM_CONTENT', locked: this._locked }).catch(() => {}); } catch {}
  }

  private applyLock() {
    if (!this.overlay || !this.lockBtn) return;
    // 坑：下面两分支的视觉属性必须成对设置——backdropFilter 与 -webkit-backdropFilter、
    // background/boxShadow/border/pointerEvents 都要同时置 none(或恢复)，单边残留会造成
    // "已锁定但仍见半透明背景/毛玻璃"的错乱观感。
    if (this._locked) {
      this.overlay.style.pointerEvents = 'none';
      this.lockBtn.style.pointerEvents = 'auto';
      this.overlay.style.background = 'transparent';
      this.overlay.style.backdropFilter = 'none';
      (this.overlay.style as any).webkitBackdropFilter = 'none';
      this.overlay.style.boxShadow = 'none';
      this.overlay.style.border = 'none';
      this.overlay.style.cursor = 'default';
      this.lockBtn.style.opacity = '0.25';
    } else {
      this.overlay.style.pointerEvents = 'auto';
      this.lockBtn.style.pointerEvents = '';
      this.paintOverlayChrome();
      // 填充模式不可拖拽（挪字幕=挪窗口），光标不显示 move
      this.overlay.style.cursor = this.fill ? 'default' : 'move';
      this.lockBtn.style.opacity = '';
    }
    this.lockBtn.innerHTML = this._locked ? UNLOCK_SVG : LOCK_SVG;
    (this.reviewBtn as any)?.__syncVisibility?.();
    this.renderLatency();
  }

  private addLockButton() {
    if (!this.overlay) return;
    this.lockBtn = document.createElement('button');
    this.lockBtn.innerHTML = LOCK_SVG;
    this.lockBtn.style.cssText = [
      'position:absolute;top:6px;right:6px;width:36px;height:36px;',
      'border-radius:10px;border:none;background:rgba(255,255,255,0.06);',
      'color:rgba(255,255,255,0.5);cursor:pointer;',
      'display:flex;align-items:center;justify-content:center;padding:0;',
      'z-index:2147483647;opacity:0;',
    ].join('');
    this.overlay.appendChild(this.lockBtn);

    this.overlay.onmouseenter = () => { if (!this._locked) this.lockBtn!.style.opacity = '1'; };
    this.overlay.onmouseleave = () => { if (!this._locked) this.lockBtn!.style.opacity = '0'; };
    if (this._locked) this.lockBtn.style.opacity = '0.25';
    this.lockBtn.onmouseenter = () => { this.lockBtn!.style.background = 'rgba(255,255,255,0.12)'; };
    this.lockBtn.onmouseleave = () => { this.lockBtn!.style.background = 'rgba(255,255,255,0.06)'; };
    this.lockBtn.onclick = (e) => { e.stopPropagation(); this.toggleLock(); };
  }

  // —— 近句回看把手与展开面板 ——
  private renderReviewPanel() {
    if (!this.reviewPanel) return;
    // 只在展开瞬间对缓冲做一次快照渲染，避免流式重绘时列表抖动/跳行。
    this.reviewPanel.textContent = '';
    if (this.recentSentences.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:2px 0;color:rgba(255,255,255,0.45);font-style:italic;';
      empty.textContent = tSync(this._lang, 'transcriptEmpty');
      this.reviewPanel.appendChild(empty);
      return;
    }
    this.recentSentences.forEach((sentence, i) => {
      const item = document.createElement('div');
      // 全部用 textContent 写入，句子文本来自识别结果，绝不走 innerHTML（防 XSS 注入点）
      item.textContent = sentence.text;
      item.style.cssText = [
        'color:#fff;font-size:13px;font-weight:500;line-height:1.5;',
        'word-break:break-word;padding:6px 2px;',
        i > 0 ? 'border-top:1px solid rgba(255,255,255,0.08);' : '',
      ].join('');
      this.reviewPanel!.appendChild(item);
      if (sentence.tr) {
        const tr = document.createElement('div');
        tr.textContent = sentence.tr;
        tr.style.cssText = [
          'color:#8ec9ff;font-size:12px;font-weight:500;line-height:1.4;',
          'word-break:break-word;padding:0 2px 6px;',
        ].join('');
        this.reviewPanel!.appendChild(tr);
      }
    });
  }

  private openReview() {
    if (!this.reviewPanel || !this.reviewBtn || this.reviewOpen) return;
    if (this.reviewCloseTimer) { clearTimeout(this.reviewCloseTimer); this.reviewCloseTimer = null; }
    this.reviewOpen = true;
    this.renderReviewPanel();
    this.reviewPanel.style.display = 'block';
    this.reviewBtn.innerHTML = CHEVRON_DOWN_SVG;
  }

  private closeReview() {
    if (!this.reviewPanel || !this.reviewBtn || !this.reviewOpen) return;
    this.reviewOpen = false;
    this.reviewPanel.style.display = 'none';
    this.reviewPanel.textContent = '';
    this.reviewBtn.innerHTML = CHEVRON_UP_SVG;
  }

  private addReviewHandle() {
    if (!this.overlay) return;
    this.reviewBtn = document.createElement('button');
    this.reviewBtn.innerHTML = CHEVRON_UP_SVG;
    this.reviewBtn.setAttribute('aria-label', tSync(this._lang, 'transcript'));
    // 坑：锁定态下 overlay 是 pointerEvents:none，把手与面板必须显式自带 pointerEvents:auto。
    this.reviewBtn.style.cssText = [
      'position:absolute;top:6px;left:6px;width:28px;height:28px;',
      'border-radius:8px;border:none;background:rgba(255,255,255,0.06);',
      'color:rgba(255,255,255,0.55);cursor:pointer;',
      'display:flex;align-items:center;justify-content:center;padding:0;',
      'z-index:2147483647;pointer-events:auto;opacity:0;',
      'transition:opacity 150ms ease, background 150ms ease;',
    ].join('');
    this.overlay.appendChild(this.reviewBtn);

    this.reviewPanel = document.createElement('div');
    this.reviewPanel.style.cssText = [
      'display:none;margin:-10px -16px 14px;padding:8px 14px;',
      'background:rgba(10,10,20,0.85);border:1px solid rgba(255,255,255,0.1);',
      'border-radius:12px;max-height:40vh;overflow-y:auto;user-select:text;',
      'pointer-events:auto;',
      'box-shadow:0 4px 24px rgba(0,0,0,0.4);',
    ].join('');
    this.overlay.insertBefore(this.reviewPanel, this.overlay.firstChild);

    const syncHandleVisibility = () => {
      if (!this.reviewBtn) return;
      this.reviewBtn.style.opacity = this._locked ? '0.45' : '0';
    };
    syncHandleVisibility();
    (this.reviewBtn as any).__syncVisibility = syncHandleVisibility;

    this.reviewBtn.onmouseenter = () => { this.reviewBtn!.style.opacity = '1'; this.openReview(); };
    this.reviewBtn.onmouseleave = () => {
      syncHandleVisibility();
      if (this.reviewCloseTimer) clearTimeout(this.reviewCloseTimer);
      this.reviewCloseTimer = setTimeout(() => this.closeReview(), 180);
    };
    this.reviewPanel.onmouseenter = () => { if (this.reviewCloseTimer) { clearTimeout(this.reviewCloseTimer); this.reviewCloseTimer = null; } };
    this.reviewPanel.onmouseleave = () => { this.closeReview(); };
    this.reviewBtn.onclick = (e) => {
      e.stopPropagation();
      if (this.reviewOpen) this.closeReview(); else this.openReview();
    };
  }

  // —— 延迟指示器（右下角）——
  private latencyLevel(ms: number): number {
    if (ms < LATENCY_LOW_MS) return 0;
    if (ms <= LATENCY_HIGH_MS) return 1;
    return 2;
  }

  private latencyTipText(lvl: number): string {
    // 两语言的阈值描述必须与 latencyLevel 的实际阈值一致
    if (this._lang !== 'zh_CN') {
      return ['Low latency (<200ms)', 'Medium latency (200ms-1s)', 'High latency (>1s) - check device resource usage'][lvl];
    }
    return ['延迟优秀（<200ms）', '延迟中（<1s）', `延迟高（≥1s）建议检查设备资源占用`][lvl];
  }

  private renderLatency() {
    if (!this.latencyWrap || !this._latencyEnabled || this._lastLatencyMs == null) return;
    const lvl = this.latencyLevel(this._lastLatencyMs);
    const color = [LATENCY_GREEN, LATENCY_YELLOW, LATENCY_RED][lvl];
    if (this.latencyDot) this.latencyDot.style.background = color;
    if (this.latencyText) {
      this.latencyText.style.display = this._locked ? 'none' : '';
      this.latencyText.textContent = `${this._lastLatencyMs}ms`;
      this.latencyText.style.color = color;
    }
    if (this.latencyTip) this.latencyTip.textContent = this.latencyTipText(lvl);
    this.latencyWrap.style.display = 'flex';
  }

  private addLatencyIndicator() {
    if (!this.overlay || this.latencyWrap) return;
    this.latencyWrap = document.createElement('div');
    this.latencyWrap.style.cssText = [
      'position:absolute;bottom:6px;right:6px;display:none;',
      'align-items:center;gap:5px;padding:3px 8px;border-radius:999px;',
      'background:rgba(255,255,255,0.07);z-index:2147483647;',
      'pointer-events:auto;cursor:default;',
    ].join('');
    this.latencyDot = document.createElement('div');
    this.latencyDot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,0.25);flex-shrink:0;';
    this.latencyText = document.createElement('span');
    this.latencyText.style.cssText = 'font-size:11px;font-weight:500;font-variant-numeric:tabular-nums;color:rgba(255,255,255,0.75);';
    this.latencyTip = document.createElement('div');
    this.latencyTip.style.cssText = [
      'display:none;position:absolute;bottom:calc(100% + 6px);right:0;',
      'max-width:240px;padding:6px 10px;border-radius:10px;',
      'background:rgba(10,10,20,0.92);border:1px solid rgba(255,255,255,0.12);',
      'color:#fff;font-size:11px;line-height:1.5;text-align:right;',
      'box-shadow:0 4px 16px rgba(0,0,0,0.4);white-space:normal;',
    ].join('');
    this.latencyWrap.appendChild(this.latencyDot);
    this.latencyWrap.appendChild(this.latencyText);
    this.latencyWrap.appendChild(this.latencyTip);
    this.latencyWrap.onmouseenter = () => { if (this.latencyTip && this._lastLatencyMs != null) this.latencyTip.style.display = 'block'; };
    this.latencyWrap.onmouseleave = () => { if (this.latencyTip) this.latencyTip.style.display = 'none'; };
    this.overlay.appendChild(this.latencyWrap);
    this.renderLatency();
  }

  private teardownReview() {
    this.reviewBtn?.remove(); this.reviewPanel?.remove();
    this.reviewBtn = null; this.reviewPanel = null; this.reviewOpen = false;
    if (this.reviewCloseTimer) { clearTimeout(this.reviewCloseTimer); this.reviewCloseTimer = null; }
  }

  private teardownLatency() {
    this.latencyWrap?.remove();
    this.latencyWrap = null; this.latencyDot = null; this.latencyText = null; this.latencyTip = null;
  }

  private applyFeatureToggles() {
    if (!this.overlay) return;
    if (this._lookbackEnabled && !this.reviewBtn) this.addReviewHandle();
    if (!this._lookbackEnabled && this.reviewBtn) this.teardownReview();
    if (this._latencyEnabled && !this.latencyWrap) this.addLatencyIndicator();
    if (!this._latencyEnabled && this.latencyWrap) this.teardownLatency();
  }

  // —— 叠层外观三模式（solid / glass / outline）——
  private subtitleShadow(): string {
    if (this._overlayBgMode === 'outline') {
      return [
        '-2px -2px 3px rgba(0,0,0,0.9)', '2px -2px 3px rgba(0,0,0,0.9)',
        '-2px 2px 3px rgba(0,0,0,0.9)', '2px 2px 3px rgba(0,0,0,0.9)',
        '0 2px 8px rgba(0,0,0,0.85)',
      ].join(',');
    }
    return '0 1px 10px rgba(0,0,0,0.8)';
  }

  // 叠层"外壳"视觉的唯一绘制出口。所有相关属性必须成对设置，切换模式时不得残留
  // 上一模式的单边属性。锁定态的外壳由 applyLock 独占，本函数在锁定时必须让位。
  private paintOverlayChrome() {
    if (!this.overlay || this._locked) return;
    const s = this.overlay.style;
    switch (this._overlayBgMode) {
      case 'solid':
        s.background = 'rgba(12,12,18,0.96)';
        s.backdropFilter = 'none';
        (s as any).webkitBackdropFilter = 'none';
        s.boxShadow = '0 8px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)';
        s.border = '1px solid rgba(255,255,255,0.1)';
        break;
      case 'outline':
        s.background = 'transparent';
        s.backdropFilter = 'none';
        (s as any).webkitBackdropFilter = 'none';
        s.boxShadow = 'none';
        s.border = 'none';
        break;
      case 'glass':
      default:
        s.background = 'rgba(0,0,0,0.25)';
        s.backdropFilter = 'blur(4px)';
        (s as any).webkitBackdropFilter = 'blur(4px)';
        s.boxShadow = '0 0 0 1px rgba(255,255,255,0.03)';
        s.border = '1px solid rgba(255,255,255,0.06)';
        break;
    }
    const shadow = `text-shadow:${this.subtitleShadow()};`;
    for (const el of [this.prevEl, this.textEl, this.transEl]) {
      if (!el) continue;
      el.style.cssText = el.style.cssText.replace(/text-shadow:[^;]*;?/, shadow);
    }
  }

  private applyOverlayStyle(mode: OverlayBgMode) {
    if (!BG_MODES.includes(mode)) return;
    this._overlayBgMode = mode;
    this.paintOverlayChrome();
  }

  private addDragListeners() {
    if (!this.overlay) return;

    this.overlay.onpointerdown = (e) => {
      // 坑：必须用 contains 判定——按钮内部是 SVG 图标，点在图标上时 e.target 是 <svg>/<path>
      // 而非 lockBtn 本身；若漏判会启动拖拽并对 overlay setPointerCapture，
      // 指针被捕获后 click 落不到按钮上，锁定切换在"点图标正中"这一最常见操作下失效。
      const t = e.target;
      if (this._locked) return;
      if (this.lockBtn && t instanceof Node && this.lockBtn.contains(t)) return;
      if ((this.reviewBtn && t instanceof Node && this.reviewBtn.contains(t)) ||
          (this.reviewPanel && t instanceof Node && this.reviewPanel.contains(t))) return;
      const rect = this.overlay!.getBoundingClientRect();
      this.dragState = {
        baseLeft: rect.left,
        baseTop: rect.top,
        startX: e.clientX,
        startY: e.clientY,
        lastDx: 0,
        lastDy: 0,
      };
      this.overlay!.setPointerCapture(e.pointerId);
      if (this.lockBtn) this.lockBtn.style.opacity = '1';
    };

    this.overlay.onpointermove = (e) => {
      if (!this.dragState || this._locked) return;
      let dx = e.clientX - this.dragState.startX;
      let dy = e.clientY - this.dragState.startY;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const ow = this.overlay!.offsetWidth;
      const oh = this.overlay!.offsetHeight;
      const newLeft = this.dragState.baseLeft + dx;
      const newTop = this.dragState.baseTop + dy;
      if (newLeft < 0) dx = -rubberband(-newLeft, vw);
      if (newTop < 0) dy = -rubberband(-newTop, vh);
      if (newLeft + ow > vw) dx = (vw - ow - this.dragState.baseLeft) + rubberband(newLeft + ow - vw, vw);
      if (newTop + oh > vh) dy = (vh - oh - this.dragState.baseTop) + rubberband(newTop + oh - vh, vh);
      this.dragState.lastDx = dx;
      this.dragState.lastDy = dy;
      this.overlay!.style.transform = `translate(${dx}px, ${dy}px)`;
    };

    this.overlay.onpointerup = () => {
      if (!this.dragState) return;
      // 坑：位移必须取 move 阶段钳制后的 lastDx/lastDy，不能用 e.clientX 重算——
      // 指针在窗口外松手时原始坐标超界，落盘后字幕就停在屏幕外了。
      // transform 恒为 'none'（create 时已把位置换算成 px），这里无需再换算。
      const dx = this.dragState.lastDx;
      const dy = this.dragState.lastDy;
      this.overlay!.style.left = (this.dragState.baseLeft + dx) + 'px';
      this.overlay!.style.top = (this.dragState.baseTop + dy) + 'px';
      this.overlay!.style.transform = 'none';
      this.scheduleSave();
      this.dragState = null;
    };

    this.overlay.onpointercancel = () => { this.dragState = null; };
  }

  private saveState() {
    // 坑：回看面板展开时叠层的 offsetHeight 含面板（max-height 40vh 可变高），
    // 此刻保存的 height 落盘后，下次恢复会把收起态的字幕框撑成一坨空白——
    // 展开期间跳过保存即可（位置 left/top 在拖拽释放时另行保存，不受影响）。
    if (!this.overlay || this.reviewOpen) return;
    storage.set({
      [this.storageKey]: {
        left: this.overlay.style.left,
        top: this.overlay.style.top,
        width: this.overlay.style.width,
        height: this.overlay.style.height,
      },
    });
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveState(), 200);
  }

  private setText(text: string) {
    if (!this.textEl) { this._pendingText = text; return; }
    this.textEl.textContent = text;
  }

  private syncPrevTrans() {
    if (!this.prevTransEl) return;
    this.prevTransEl.style.display = (this._showPrev && !!this.prevTransEl.textContent) ? '' : 'none';
  }

  private setOverlayText(prev: string, current: string) {
    const pe = this.prevEl, te = this.textEl;
    if (!pe || !te) return;
    const showPrev = this._showPrev && prev;
    pe.textContent = prev;
    pe.style.display = showPrev ? '' : 'none';
    te.textContent = current;
    this.syncPrevTrans();
  }
}