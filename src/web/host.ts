// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
// 纯 Web 版宿主：扮演扩展里 background + offscreen 两个角色的合体。
//
// 架构对照（为什么这么分）：
//   扩展：popup(控制) → background(SW 路由) → offscreen(识别引擎) + floating(字幕窗/麦克风采集)
//   Web ：panel(控制) → **本文件(路由 + 识别引擎)** → subtitle(字幕浮窗，独立 window)
// 差异的根源是 Web 没有 SW/offscreen 这种"无界面常驻上下文"，只能把引擎放进某个真实页面。
// 选面板页承载引擎而不是浮窗，原因有二：
//   ① getDisplayMedia / getUserMedia 都要求**瞬时用户手势**，而面板的「开始」按钮就是那个手势
//      （浮窗是 window.open 出来的，拿不到激活态，还得让用户再点一次）；
//   ② 面板页藏着不动也没关系——音频泵由 AudioWorklet 在音频线程主动出块
//      （见 public/audio-worklet-processor.js 的"出块模式"注释），不依赖主线程定时器。
//
// 纪律：本文件只做路由与宿主接线，识别/标点/翻译/采集全在共享模块里
// （asr-engine.ts / mic-capture.ts / transcript-store.ts），保证与扩展行为一致。
// 但"会话生命周期"这一层必须逐条对齐扩展的 background：
//   START 前置校验 / 代次作废 / 结束即关显示端 / 关显示端即结束会话 / 锁态回源 storage，
//   少任何一条都会表现成"看起来一样、用起来不一样"（用户已验证过的那些 bug）。
import { AsrEngine } from '../asr-engine';
import { MicCapture, micErrorText } from '../mic-capture';
import { HelperSource, loadHelperSession } from '../helper';
import { emitToPanel, onHostMessage, resolveUrl, storage } from '../platform';
import { tSync } from '../i18n';
import { appendTranscript, attachTranscriptTranslation } from '../transcript-store';
import { sendToPeer } from './channel';

// 电平快照（最近 ~7s）：面板每次打开都要能看到上一段波形，而不是从空基线重填。
// 与扩展 background 里的 bgLevels 同口径（60 条 × 120ms）。
const LEVEL_SNAPSHOT_MAX = 60;
const LOCK_KEY = 'tmspeech_locked';
const levels: number[] = [];

// 面板页被字幕浮窗盖住后即进入"被遮挡"状态，Chrome 会节流 setTimeout
// （intensive throttling），主线程 60ms 的 flush 链随之停摆。所以本宿主的采集一律
// 走 push 模式：由 AudioWorklet 在音频线程按 60ms 自主出块。
const WEB_PUSH_MS = 60;

let engine: AsrEngine | null = null;
// 会话语言（由面板随 START_RECOGNITION 带来）：错误文案按它取 i18n
let msgLang = 'zh_CN';
let mic: MicCapture | null = null;
// 桌面助手音频源（本机助手进程采系统音频，经 WS 送 PCM）
let helper: HelperSource | null = null;
let status = 'Stopped';
let startedAt = 0;
let locked = false;
// START 已受理且尚未收敛（含模型加载中）。与 status 分开记：status 只跟随引擎上报
// （扩展 background 的 pipelineStatus 同语义），而"模型加载中"引擎还没报 Running，
// 这期间用户关掉浮窗仍必须能停掉整场会话。
let sessionActive = false;
// 会话代次：与扩展 background 的 sessionEpoch 同义。START 的异步初始化体在每个 await
// 恢复点核对代次，期间只要发生过 STOP（代次前进）就立即中止——否则"停止后残余的启动
// 代码"会把采集/管道重新拉起来，成为界面已停、音频还在跑的幽灵会话。
let sessionEpoch = 0;
// "会话真正进入 Running"只上报一次（引擎每次重建 pipeline 都会发 STATUS_CHANGED）
let runningNotified = false;

// —— 生命周期钩子：宿主不懂窗口/UI，把这两件事交回面板 ——
// 这样 host.ts 保持"只做路由"，窗口几何与浮窗开关的知识全部留在 web/panel.ts。
export interface SessionLifecycleHooks {
  // 会话真正开始（引擎已报告 Running）：面板把自身窗口让开，别压住字幕浮窗
  onSessionRunning?(): void;
  // 会话收敛后（引擎已停、浮窗已关）：面板把窗口几何恢复原样
  onSessionStopped?(): void;
  // 面板的「显示字幕」开关。Web 版里它的语义就是"字幕浮窗开/关"
  // （扩展里 OVERLAY_TOGGLE 只作用于页内叠层，悬浮窗由音源决定开合——Web 没有页内叠层，
  //  若照搬"销毁叠层"的语义，用户取消勾选后只会留下一个空白浮窗）。
  onSubtitlesVisibility?(visible: boolean): void;
}
let lifeHooks: SessionLifecycleHooks = {};
export function setSessionLifecycleHooks(h: SessionLifecycleHooks) { lifeHooks = h; }

function getEngine(): AsrEngine {
  if (!engine) {
    engine = new AsrEngine({
      resolveUrl,
      pushMs: WEB_PUSH_MS,
      sink: {
        log: (message) => emitToPanel({ type: 'LOG', message }),
        toDisplay: (payload) => sendToPeer(payload),
        toPanel: (payload) => {
          const p = payload || {};
          // —— 与扩展 background 的 FW_POP 分支等价的三件宿主侧副作 ——
          // ① 定稿译文按 seq 挂到历史原句（跨刷新留存）
          if (p.type === 'TRANSLATION_FINAL') {
            attachTranscriptTranslation(p.text, p.seq, (e) => console.log('[EasySub] 转写译文持久化失败:', e));
          }
          // ② 电平快照（面板关闭/未打开时也要攒着，重开面板能还原波形）
          if (p.type === 'LEVEL') {
            levels.push(Math.max(0, Math.min(1, Number(p.v) || 0)));
            if (levels.length > LEVEL_SNAPSHOT_MAX) levels.shift();
          }
          // ③ 会话状态推进（含计时基准盖章）；SENTENCE_DONE 单独盖章后转发，
          //    避免面板收到两条（一条无 ts 一条有）导致列表重复
          if (p.type === 'STATUS_CHANGED') {
            status = p.status;
            if (p.status === 'Running') {
              // 计时基准在这里盖章（引擎真正跑起来那一刻），与扩展 background 的
              // "首次见到 Running 就地盖章"同口径——不能在 START 时乐观盖章，
              // 否则首次下载模型的几十秒全被算进会话时长。
              if (!startedAt) startedAt = Date.now();
              if (!runningNotified) { runningNotified = true; lifeHooks.onSessionRunning?.(); }
            }
            emitToPanel({ ...p, startedAt });
            // 主动推给字幕浮窗：它的停止按钮启用只看状态，不能等 2 秒一次的心跳
            // 握手来回补——模型加载完的那一刻按钮就该亮。
            sendToPeer({ type: 'STATUS_CHANGED', status: p.status });
          } else if (p.type === 'SENTENCE_DONE') {
            const ts = Date.now();
            emitToPanel({ ...p, ts });
            appendTranscript(p.text, ts, Number(p.seq) || undefined, (e) => console.log('[EasySub] 转写持久化失败:', e));
          } else {
            emitToPanel(p);
          }
          // ERROR：音频注定进不来，收敛成一次可见的停止（同扩展的 cleanupAll）
          if (p.type === 'ERROR') stopSession();
        },
        // 采集彻底起不来（用户关掉屏幕选择器、音频轨异常、模型缺失）→ 立即收敛会话，
        // 否则面板停在"识别中"、浮窗空挂，成为没有任何反馈的幽灵会话。
        requestStop: () => stopSession(),
      },
    });
  }
  return engine;
}

// 停止：停引擎、停麦克风采集、收敛状态、关字幕浮窗。
// 幂等——ERROR / 浮窗关闭 / 用户点停止 三条路都会走到这里。
// 导出给面板用：浮窗失联（被导航走/被浏览器丢弃）时面板也要能收敛整场会话。

// 桌面助手音频源：WS 由本宿主持有（面板页就是引擎宿主），PCM 直接喂进识别管道。
// 令牌从 storage 读——面板配对成功后会写进去，这里不重复探测（避免两处状态不一致）。
async function startHelperSource(isStale: () => boolean) {
  helper?.stop();
  helper = null;
  const session = await loadHelperSession();
  // 加载期间用户可能已经点了停止：stopSession() 那时只 stop 了「当时的 helper」（还是 null），
  // 这里必须再查一次代次，否则会留下一条没人关闭的 WS（助手会一直推流）。
  if (isStale()) return;
  if (!session) {
    // 缺会话 = 没配对（可能没启动助手，也可能开着但没配过/暂停）——全是常态，当静音音源。
    // 文案用对三种成因都成立的句子，别说"没在运行"（用户窗口可能开着）；且这是单行日志区，
    // 没有链接可点，别写"在下方链接下载"。
    emitToPanel({ type: 'HELPER_SILENT', message: tSync(msgLang, 'helperSilentGeneric') });
    return;
  }
  helper = new HelperSource({
    port: session.port,
    token: session.token,
    source: 'system',
    lang: msgLang,
    // 与扩展端同一条通道：PCM 交给引擎，电平由引擎自己算（不给 helper 开专属通路）
    onPcm: (f32, rate) => getEngine().feedMicChunk(f32, rate),
    onError: (message, code) => {
      // 与扩展端 offscreen 同一套降级（复审抓的不一致）：没启动/暂停是常态，
      // 空音频=静音帧、识别照常——只记日志，不把整场会话连模型一起拆掉。
      if (code === 'connect_failed' || code === 'ws_closed' || code === 'paused') {
        emitToPanel({ type: 'HELPER_SILENT', message });
        return;
      }
      emitToPanel({ type: 'ERROR', message });
      stopSession();
    },
    log: (m) => getEngine().log(m),
  });
  helper.start();
}

export function stopSession() {
  const wasRunning = sessionActive || status !== 'Stopped' || !!mic || !!engine?.hasPipeline();
  // 作废在途的 START 异步体（同扩展 cleanupAll 的 sessionEpoch++）
  sessionEpoch++;
  sessionActive = false;
  mic?.stop();
  mic = null;
  helper?.stop();
  helper = null;
  engine?.stop();
  status = 'Stopped';
  startedAt = 0;
  runningNotified = false;
  // 波形快照随之清空：停止后的面板不该显示已结束会话的电平残留（同扩展 bgLevels = []）
  levels.length = 0;
  emitToPanel({ type: 'STATUS_CHANGED', status: 'Stopped' });
  sendToPeer({ type: 'STATUS_CHANGED', status: 'Stopped' });
  // 顺序很重要：先让面板把窗口几何恢复原样，再关字幕浮窗。
  // 面板可能是靠浮窗代劳挪的（普通标签页自己挪不动窗口），几何恢复必须赶在
  // 浮窗消失之前发出，否则那条消息发给一个已关闭的对端，面板就永远卡在小窗里。
  lifeHooks.onSessionStopped?.();
  // 生命周期绑定（同扩展 cleanupAll 末尾的 closeFloating）：会话结束，字幕显示端
  // 没有继续存在的意义。此前漏了这一步，表现为"停止后浮窗还在那儿挂着"。
  if (wasRunning) closeSubtitleWindow();
}

export function getSessionStatus() { return status; }
// 会话是否已受理且尚未收敛（含引擎仍在加载模型、尚未报 Running 的阶段）
export function isSessionActive(): boolean { return sessionActive; }

// 面板/宿主想让一行文字出现在面板日志区时用它（引擎日志走 sink.log，这是宿主自用的）
export function emitLog(message: string) { emitToPanel({ type: 'LOG', message }); }

// 字幕浮窗的窗口引用由面板（web/panel.ts）用 window.open 建好后交给这里保管：
// 宿主在会话结束时需要主动关窗，而 panel 侧不该关心"谁负责关窗"这类路由细节。
let subtitleWindow: Window | null = null;

// 「刚才是我们自己关的窗」——用于区分两种 __subtitle_closed：
//   ① 用户在浮窗上点关闭（或关掉画中画）→ 显示端消失，必须结束会话（同扩展 onRemoved）；
//   ② 我们自己关的（结束会话收尾 / 用户勾掉「显示字幕」）→ 不该反过来再触发一次停止。
// 实现用"带有效期的标记 + 收到即消费"：标记必须在消息到达前有效，收到就立刻清掉，
// 不会误吞下一次真正的用户关窗。加有效期是为了兜住"消息没送到"的情形——
// 窗口在关闭流程里被销毁、消息丢失时，标记不能永远立着（那就再也识别不出用户关窗了）。
const CLOSED_BY_US_TTL_MS = 3000;
// 收到 __subtitle_closed 后等这么久再判定"是关窗还是刷新"。刷新时窗口对象仍然活着
// （文档被换掉而已），够新文档重新握手；关闭时窗口已销毁，一次心跳间隔内即可确认。
const SUBTITLE_RELOAD_GRACE_MS = 1200;
let closedByUsUntil = 0;
// 面板当前是否希望字幕窗开着（「显示字幕」勾选态）。宿主据此判断一次关窗是"用户想隐藏字幕"
// 还是"显示端意外消失"：前者应让识别继续跑，后者必须收敛会话。面板在 setSubtitleWanted
// 里同步它，宿主不直接读 DOM。
let subtitleWanted = true;
export function setSubtitleWanted(v: boolean) { subtitleWanted = v; }
export function onSubtitleWindowRef(): Window | null {
  return subtitleWindow && !subtitleWindow.closed ? subtitleWindow : null;
}

// 挂上新窗口引用。**不复位**标记：可能是"勾掉显示字幕 → 标记立起 → 立刻勾回来开新窗"，
// 那条还在路上的 __subtitle_closed 属于上一次关窗，标记必须仍然有效。
export function setSubtitleWindowRef(w: Window | null) {
  subtitleWindow = w;
}

// 关闭字幕浮窗。所有调用方都是"宿主侧主动关窗"（结束会话收尾、用户勾掉「显示字幕」、
// 本次启动夭折、页面卸载），语义一致：不要反过来触发一次停止。
// 只在**确实关掉了一个窗口**时才立标记——否则一次空关（窗口已不在）会让标记留在
// 不明不白的时间窗里，可能误吞随后真正的用户关窗。
export function closeSubtitleWindow() {
  const w = subtitleWindow;
  subtitleWindow = null;
  if (!w || w.closed) return;
  closedByUsUntil = Date.now() + CLOSED_BY_US_TTL_MS;
  try { w.close(); } catch { /* 已在关闭中 */ }
}

// 面板点「开始」时同步（在用户手势内）预取音频流。Web 版必须这么做：
// 面板的启动链路里 `await ensureAsrModel()` 会跨过若干微任务/网络请求，
// 等它结束再调 getDisplayMedia，浏览器会以"缺少瞬时用户激活"直接拒绝。
// 所以由面板在点击任务的最前面调用本函数，把流先拿到手，再走后面的异步检查。
export async function preAcquireAudio(source: string): Promise<MediaStream | null> {
  if (source !== 'system') return null;
  // 用户关掉选择器（NotAllowedError/AbortError）由调用方按取消处理，这里原样抛出
  return await getEngine().acquireSystemAudioStream();
}

async function startSession(msg: any) {
  const source = msg.source === 'mic' ? 'mic' : msg.source === 'helper' ? 'helper' : 'system';
  // 会话语言：错误文案要用会话启动时的语言（面板切语言后重开会话才变，与扩展一致）
  if (msg.lang) msgLang = msg.lang;
  // 先停干净上一场（含上一场的 getDisplayMedia 轨道），避免两份采集并存
  mic?.stop();
  mic = null;
  helper?.stop();
  helper = null;
  engine?.stop();
  const myEpoch = ++sessionEpoch;
  const stale = () => myEpoch !== sessionEpoch;
  // status/startedAt 不在这里乐观盖章：它们只跟随引擎上报（与扩展 pipelineStatus
  // 同语义），否则模型加载的几十秒里 GET_STATUS 会把"还在加载"报成 Running，
  // 会话计时也把加载时长算进去。受理态用 sessionActive 记。
  // startedAt 必须清零：重启路径（上一场还在跑时直接再点开始）只走 engine.stop()
  // 不走 stopSession，残留的话新会话的计时基准还是上一场的。
  sessionActive = true;
  runningNotified = false;
  startedAt = 0;

  // 坑：preStream 是面板在**用户手势内**取好的屏幕共享流。若这段启动已被 STOP 作废
  // （代次失配），必须把它停掉——否则用户看到"共享指示"常亮却没有任何识别在跑。
  const preStream: MediaStream | null = msg.preStream ?? null;
  const dropPreStream = () => preStream?.getTracks().forEach((t) => t.stop());

  if (source === 'mic') {
    // 麦克风：采集放本宿主（面板页是可见窗口，授权弹窗能正常出现），
    // PCM 经 feedMicChunk 喂进识别管道——与扩展"悬浮窗采集、bg 中转"同一协议。
    mic = new MicCapture({
      pushMs: WEB_PUSH_MS,
      onChunk: (f32, sampleRate) => getEngine().feedMicChunk(f32, sampleRate),
      onError: (name, error) => {
        // 文案走 micErrorText（与扩展 bg 的 MIC_RESULT 分支同一套键）；
        // micFailure 标记让面板把这类启动失败升级为模态（状态栏一行小字会被闪退冲掉）
        emitToPanel({
          type: 'ERROR',
          message: micErrorText(msgLang, name, error || ''),
          micFailure: true,
        });
        stopSession();
      },
    });
    void mic.start();
  }

  void (async () => {
    try {
      // 坑：会话配置必须像扩展 background 一样**回源 storage 读取**，不能透传 msg——
      // 面板的 START 消息从来只带 source/lang/overlayVisible（master 的 popup 同样不带），
      // 翻译开关/方向/时机、标点开关、端点阈值、热词全在 storage 里，由 bg 在 START 时
      // 自己读出来拼进 INIT。Web 宿主没做这一步的话，translationEnabled 恒为 undefined，
      // 引擎 `=== true` 判定直接把翻译关死（用户实测："网页版的翻译用不了"），
      // 热词与端点滑杆同理全部静默失效。
      const cfg = await readSessionConfig();
      if (stale()) { dropPreStream(); return; }
      msgLang = cfg.lang;
      await getEngine().init({
        source,
        lang: cfg.lang,
        usePunct: cfg.usePunct,
        endpointRule1: cfg.endpointRule1,
        endpointRule2: cfg.endpointRule2,
        endpointRule3: cfg.endpointRule3,
        hotwords: cfg.hotwords ?? undefined,
        translationEnabled: cfg.translationEnabled,
        translationDirection: cfg.translationDirection,
        translationTiming: cfg.translationTiming,
        // 面板预取的屏幕共享流（system 音源）：引擎拿到就直接接入管道，
        // 不再自己调 getDisplayMedia（那时已不在用户手势内，必失败）
        preStream,
      });
      // 桌面助手：init 之后才接音频（此前 feedMicChunk 没有管道，块会被丢弃）。
      // stale() 必须**再查一次**：加载模型期间用户可能已经点了停止，迟到的
      // startHelperSource 会开出一条没人负责关的 WS（助手会一直推流）。
      if (source === 'helper' && !stale()) void startHelperSource(stale);
    } catch (e: any) {
      // 这条 catch 是防御性的（引擎 init 内部各失败路只 log 不上抛），但真走到时
      // preStream 也必须释放，否则屏幕共享指示灯为一场不存在的会话常亮。
      dropPreStream();
      if (stale()) return;
      console.log('[EasySub] 启动失败:', e);
      emitToPanel({ type: 'ERROR', message: tSync(msgLang, 'startFailed').replace('{m}', String(e?.message || e)) });
      stopSession();
      return;
    }
    // 引擎 INIT 内部对"取消选择/代次失配/模型缺失"这几条路只 log 不上抛，
    // 所以这里不能假设 init 返回即成功——按当前状态判一次，未起来就收尾。
    if (stale()) { dropPreStream(); return; }
    if (status === 'Stopped') dropPreStream();
  })();
}

// 会话配置回源 storage（与扩展 background.startRecognition 的读取完全同构）。
// 端点阈值交给引擎的 ?? 默认值（0.8/0.6/15），与 master 的 initMsg「有值才带」等价。
async function readSessionConfig(): Promise<{
  lang: string; usePunct: boolean;
  endpointRule1?: number; endpointRule2?: number; endpointRule3?: number;
  hotwords: string[] | null;
  translationEnabled: boolean; translationDirection: 'auto' | 'zh-en' | 'en-zh';
  translationTiming: 'stream' | 'final';
}> {
  const [langR, punctR, prefsR, hotwordsR] = await Promise.all([
    storage.get('tmspeech_lang'),
    storage.get('tmspeech_use_punct'),
    storage.get('tmspeech_prefs'),
    storage.get('tmspeech_hotwords'),
  ]);
  const prefs = (prefsR['tmspeech_prefs'] as any) || {};
  const hotwords = hotwordsR['tmspeech_hotwords'];
  const tdir = prefs.translationDirection;
  return {
    lang: langR['tmspeech_lang'] || 'zh_CN',
    usePunct: punctR['tmspeech_use_punct'] !== false,
    endpointRule1: prefs.endpointRule1 ?? 0.8,
    endpointRule2: prefs.endpointRule2 ?? 0.6,
    endpointRule3: prefs.endpointRule3 ?? 15,
    hotwords: Array.isArray(hotwords) && hotwords.length ? hotwords : null,
    translationEnabled: prefs.translationEnabled === true,
    translationDirection: tdir === 'zh-en' || tdir === 'en-zh' ? tdir : 'auto',
    translationTiming: prefs.translationTiming === 'final' ? 'final' : 'stream',
  };
}

// —— 面板 → 宿主 的消息路由 ——
// 消息名与扩展的 background 完全一致，面板因此不需要区分宿主。
export function installWebHost() {
  onHostMessage((msg: any) => {
    switch (msg?.type) {
      case 'START_RECOGNITION':
        void startSession(msg);
        return true;

      case 'STOP_RECOGNITION':
        stopSession();
        return true;

      case 'GET_STATUS':
        // 契约与扩展 background 的 GET_STATUS 一致：面板据此恢复状态、锁态与波形快照。
        // 锁态回源 storage（唯一事实源）——只回内存值的话，面板刷新/sw 重启后会把
        // 实际仍锁定的字幕报成未锁定（扩展为此专门改成了异步回源）。
        return (async () => {
          const lock = await readLock();
          return { status, startedAt, locked: lock, levels: levels.slice() };
        })();

      case 'OVERLAY_TOGGLE':
        // Web 版语义是"字幕浮窗开/关"，交给面板执行窗口动作
        lifeHooks.onSubtitlesVisibility?.(msg.visible !== false);
        return true;

      case 'LOCK_TOGGLE':
        locked = msg.locked === true;
        // 与扩展同样落库：字幕层/浮窗重建时读的是 storage，不写就会两端记账发散
        storage.set({ [LOCK_KEY]: locked }).catch(() => {});
        sendToPeer({ type: 'LOCK_TOGGLE', locked });
        return true;

      // （LOCK_CHANGED_FROM_CONTENT 不在 switch 里：它只会从字幕浮窗经 channel 到
      // handleFromSubtitle，不会有面板代码发这个名字。）

      case 'SET_FONT_SIZE':
      case 'SET_PREV_OPTS':
      case 'RESET_OVERLAY_POSITION':
      case 'SET_PUNCT':
        sendToPeer(msg.type === 'SET_PUNCT'
          ? { type: 'SET_PUNCT', enabled: msg.enabled }
          : msg);
        if (msg.type === 'SET_PUNCT') engine?.setPunctuation(msg.enabled !== false);
        return true;

      case 'SET_ENDPOINT':
        // 端点阈值在识别器创建时一次性烘焙，运行时只记日志（与扩展一致：重启生效）
        engine?.logEndpoint(msg.rule1, msg.rule2, msg.rule3);
        return true;

      case 'FORWARD_TO_CONTENT':
        // 面板的显示类偏好改动（PREFS_PATCH / OVERLAY_TOGGLE 等）实时推到字幕浮窗
        sendToPeer(msg.payload);
        return true;

      case 'TRANSLATE_TEST':
        // 面板的"测试翻译"：直接问引擎（Web 版没有跨上下文转发层）
        return getEngine().testTranslate(String(msg.text ?? ''), msg.direction || 'auto');

      case 'TRANSLATE_TEST_CANCEL':
        engine?.cancelTranslateTest();
        return true;

      case 'TRANSLATION_MODEL_IMPORTED':
        // 面板刚导入/更新翻译模型：解除引擎与 worker 里"缺模型"的记忆，
        // 正在运行的会话无需重启即可开始出译文。
        getEngine().notifyTranslationModelImported();
        return true;

      case 'TRANSLATION_SETTINGS_LIVE':
        // 会话运行中改了实时翻译开关/方向/时机：当场生效（不生效会表现成"开了没反应"）
        engine?.setTranslationLive(
          msg.enabled === true,
          msg.direction === 'zh-en' || msg.direction === 'en-zh' ? msg.direction : 'auto',
          msg.timing === 'final' ? 'final' : 'stream',
        );
        return true;

      case 'OPEN_FLOATING':
      case 'CLOSE_FLOATING':
        // 这两个在扩展里由 background 管窗口；Web 版的字幕浮窗由面板自己 window.open。
        // 不空转：折到同一个"字幕可见性"语义上，面板刷新后靠它把窗口拉回正确状态。
        lifeHooks.onSubtitlesVisibility?.(msg.type === 'OPEN_FLOATING');
        return true;
    }
    return undefined;
  });
}

// 锁态读取：storage 为唯一事实源，读失败退化为内存值（至少不阻塞面板初始化）
async function readLock(): Promise<boolean> {
  try {
    const r = await storage.get(LOCK_KEY);
    locked = r[LOCK_KEY] === true;
  } catch { /* 存储异常：保留内存值 */ }
  return locked;
}

// 预热 wasm：面板页一加载就开始把模型读成 blob URL 并注入三个 wasm 脚本，
// 「开始」到出字的空窗因此明显更短（与扩展 offscreen 文档的预加载行为一致）。
// 未进入跨源隔离时不预热：pthreads 加载器在非隔离页面会在
// `new WebAssembly.Memory({shared:true})` 处立刻抛 DataCloneError，预热注定失败还会
// 留下半初始化的运行时（正常部署下 coi-serviceworker 那次自动刷新之后页面就是隔离的，
// 这里只是把"未隔离"这一段噪声掐掉；真正的门卫在 doStart 与环境自检里）。
export function preloadEngine(): void {
  if (!window.crossOriginIsolated) return;
  void getEngine().preload().catch((e) => console.log('[EasySub] wasm 预加载失败:', e));
}

// wasm 运行时是否已经初始化过。识别模型是在这个时刻被读进 wasm 文件系统的：
// 之后再导入新模型，当前页面已经无法换掉它（换掉要重新初始化整个 wasm 运行时，
// 而那是文档级一次性的——见 asr-engine 的 injectWasmScripts）。
// 扩展侧不存在这个问题：它每次停止都销毁 offscreen 文档，下次开始重建。
export function isEngineRuntimeLoaded(): boolean {
  return !!engine?.isRuntimeLoaded();
}

// 字幕浮窗回来的消息：锁定切换、停止、窗口关闭。
export function handleFromSubtitle(msg: any) {
  if (msg?.type === 'LOCK_CHANGED_FROM_CONTENT') {
    locked = msg.locked === true;
    storage.set({ [LOCK_KEY]: locked }).catch(() => {});
    emitToPanel({ type: 'LOCK_CHANGED', locked });
    return;
  }
  if (msg?.type === 'STOP_RECOGNITION' || msg?.type === '__subtitle_stop') {
    // 浮窗工具条的「停止」按钮、以及浮窗关掉画中画窗口时的收尾，都走这里。
    // 坑：这条消息名与面板发出的同名，但**来源是浮窗**——早先只处理了锁定回传，
    // 浮窗里点停止毫无反应（用户会以为按钮坏了）。
    stopSession();
    return;
  }
  if (msg?.type === '__subtitle_closed') {
    // 浮窗被用户**主动关掉** = 唯一的字幕显示端消失。扩展里对应 background 的
    // windows.onRemoved → cleanupAll（关窗即结束会话），Web 必须同语义，
    // 否则识别继续跑却看不到任何字幕，用户以为卡死。
    // 两种"不是用户关的"要放行：
    //   ① 会话已停（我们自己收尾时关的窗）——状态已是 Stopped，本来就会跳过；
    //   ② 面板主动关窗（勾掉「显示字幕」只是想隐藏字幕，面板里还有实时预览与记录）
    //      ——closedByUsUntil 由 closeSubtitleWindow 立起，这里消费掉（收到即失效）。
    const byUs = Date.now() < closedByUsUntil;
    closedByUsUntil = 0;
    // 用 sessionActive（受理未收敛）而不是 status 判断：模型加载中引擎还没报 Running，
    // status 仍是 Stopped，但这场会话真实存在，用户关浮窗必须能停掉它。
    if (!sessionActive || byUs) return;
    // 坑：pagehide 同时发生在"关窗"与"刷新（F5）"两种情形，消息本身分不出来。
    // 延迟一拍再判，用窗口状态区分三种结局：
    //   · 窗口已销毁        → 真关闭
    //   · 窗口还在、仍停在字幕页 → 刷新（新文档会重新握手）
    //   · 窗口还在、但已不在字幕页 → 用户把浮窗导航到别的网址（同源可读出 href；
    //     跨源读取会抛 SecurityError）——显示端同样没了，必须按关闭处理
    const at = sessionEpoch;
    setTimeout(() => {
      if (!sessionActive || sessionEpoch !== at) return;
      // 面板本来就希望"没有字幕窗"（用户取消勾选「显示字幕」）——那这次关窗是预期的，
      // 识别该继续跑（面板里还有实时预览与记录）。这条判定不能只靠 closedByUsUntil 的
      // TTL：消息若因主线程长阻塞迟到超过 TTL，byUs 会失效，落到这里就会把会话误停。
      if (!subtitleWanted) return;
      const w = subtitleWindow;
      const alive = !!w && !w.closed;
      if (alive && isStillSubtitlePage(w!)) {
        // 刷新：新文档会重新握手，这里先把状态补齐
        void primeSubtitlePrefs();
        sendToPeer({ type: 'STATUS_CHANGED', status });
        return;
      }
      stopSession();
    }, SUBTITLE_RELOAD_GRACE_MS);
    return;
  }
}

// 窗口是否仍停在字幕浮窗页。同源时能读到 href；被导航到跨源页面会抛 SecurityError，
// 读到同源的其它页面则 href 不含字幕页文件名——两种情况都算"已不在字幕页"。
function isStillSubtitlePage(w: Window): boolean {
  try {
    return /subtitle\.html/i.test(w.location.href || '');
  } catch {
    return false;
  }
}

// 字幕显示端是否仍然可用（窗口存在、未关闭、且没被导航走）。宿主与面板都用它判断
// "显示端是不是真的没了"——只看窗口引用非空是不够的：浮窗被导航到其它网址后引用仍在，
// 但一个字幕也不会再显示。
export function isSubtitleWindowUsable(): boolean {
  const w = subtitleWindow;
  return !!w && !w.closed && isStillSubtitlePage(w);
}

// 会话开始前把面板的偏好快照推给浮窗（浮窗可能是刚打开的，尚未读到任何消息）
export async function primeSubtitlePrefs(): Promise<void> {
  const r = await storage.get(['tmspeech_prefs', LOCK_KEY, 'tmspeech_lang']);
  const prefs = (r['tmspeech_prefs'] as any) || {};
  sendToPeer({ type: 'PREFS_PATCH', ...prefs });
  locked = r[LOCK_KEY] === true;
  sendToPeer({ type: 'LOCK_TOGGLE', locked });
}

// 把"当前正在说的这一句"重推给显示端。浮窗刚开/刚刷新时字幕区是空的，
// 不补这一下要等到用户开口说下一句才有字（扩展侧由 background 在开窗后发
// RESEND_CURRENT_TEXT 达到同样效果，Web 版没有那一层，由这里补上）。
export function resendCurrentText(): void {
  engine?.resendCurrentText();
}
