// 识别引擎（宿主无关）：把 WASM 识别、标点恢复、离线翻译、音频采集、延迟/电平测量
// 全部收敛到这一个类里，**不依赖任何 chrome.* API**。
//
// 存在意义：同一套逻辑要同时跑在 MV3 扩展的 offscreen 文档（offscreen.ts，薄适配层）
// 与纯 Web 单页（web/main.ts）中。宿主只需提供两件东西：
//   ① resolveUrl —— 把 'wasm/xxx.js' 这类相对路径解析成该宿主可加载的 URL
//      （扩展=chrome.runtime.getURL，Web=相对于页面路径的原样值）；
//   ② sink —— 接收出站消息。这里的消息体与扩展既有的 FW_CT / FW_POP 协议**逐字段一致**，
//      于是 offscreen.ts 只做端口转发、web/main.ts 直接把同一份 payload 喂给共享叠层。
//
// 代价与纪律：本文件是"宿主无关"的边界，任何新功能若必须碰 chrome.*，请加在宿主侧
// （offscreen.ts / web/main.ts），不要在这里开洞，否则 Web 版会跟着一起烂。
import { Pipeline, JobStatus } from './pipeline';
import { tSync } from './i18n';
import { addPunctuation } from './punctuator';
import { resample } from './audio-processor';
import { getModelFile } from './model-db';
import { probeBundledResource } from './platform';

// ---- wasm 脚本动态注入（nomodel 支持）----
// 宿主页面只静态加载 preload.js（仅定义 Module 不拉资源）。三个 wasm 脚本必须等
// IndexedDB 检查完成后再注入：nomodel 包里没有 .data，需要先把用户导入的模型读成
// blob URL 挂到 window.__asrDataUrl，preload.js 的 locateFile 会在加载器求值瞬间
// 同步取用它；若包内自带 .data（full/lite/开发版）则 __asrDataUrl 为空，locateFile
// 走宿主提供的原路径。
const WASM_SCRIPTS = [
  'wasm/sherpa-onnx-wasm-main-asr.js',
  'wasm/sherpa-onnx-asr.js',
  'wasm/sherpa-onnx-punctuation.js',
];

// 识别模型数据文件名（emscripten 的 .data 文件系统映像，包里自带或用户导入到 IndexedDB）
export const ASR_DATA_PATH = 'wasm/sherpa-onnx-wasm-main-asr.data';
export const ASR_DB_KEY = '__asr_wasm_data';
// 模型缺失时的错误标记：宿主据此弹"导入模型"引导而不是报一句看不懂的加载失败
export const ERR_MODEL_MISSING = 'MODEL_MISSING';

export type EngineSource = 'tab' | 'system' | 'mic';

// 出站消息出口。两条通道与扩展既有协议同名：display=字幕显示端（页内叠层/悬浮窗），
// panel=控制面板。Web 宿主里两者通常指向同一个页面上的不同区域。
export interface EngineSink {
  log(message: string): void;
  toDisplay(payload: any): void;
  toPanel(payload: any): void;
  // 采集彻底起不来、会话注定空挂时的收敛请求（对应扩展的 FW_STOP）
  requestStop(): void;
}

export interface EngineOptions {
  resolveUrl: (path: string) => string;
  sink: EngineSink;
  // AudioWorklet 出块模式：>0 表示由音频线程每 N 毫秒主动回吐（push），缺省 0 为
  // 主线程定时 flush（pull）。仅当宿主页面可能在后台/被盖住时才传（见 worklet 文件注释）。
  // 扩展侧**必须保持 pull**：offscreen 文档不受节流影响，而"发 flush → 收回包"的因果
  // 关系正是延迟指示的测量口径，push 会让回包与 flush 不再对应、数值失真。
  pushMs?: number;
}

export interface InitOptions {
  source: EngineSource;
  tabId?: number | null;
  lang?: string;
  usePunct?: boolean;
  endpointRule1?: number;
  endpointRule2?: number;
  endpointRule3?: number;
  hotwords?: string[];
  translationEnabled?: boolean;
  translationDirection?: 'auto' | 'zh-en' | 'en-zh';
  translationTiming?: 'stream' | 'final';
  // 宿主预取的屏幕共享音频流（纯 Web 版专用）。getDisplayMedia 需要瞬时用户激活，
  // 而 Web 版的启动链路里隔着模型检查等异步步骤，等走到引擎这步手势已失效，
  // 所以由面板在点击任务内先取流，engine 直接消费。扩展侧不传（offscreen 文档
  // 自己调 getDisplayMedia 没有这个限制）。
  preStream?: MediaStream | null;
}

export interface ReconnectInfo {
  tabId: number | null;
  streamId: string | null;
  source: EngineSource;
}

declare function createOnlineRecognizer(Module: any, config: any): any;

export class AsrEngine {
  private resolveUrl: (path: string) => string;
  private sink: EngineSink;
  // 0 = 主线程定时 flush（扩展）；>0 = 音频线程主动出块（Web，见 EngineOptions.pushMs）
  private pushMs: number;

  private pipeline: Pipeline | null = null;
  private reconnectTabId: number | null = null;
  private reconnectStreamId: string | null = null;
  private reconnectSource: EngineSource = 'tab';
  private currentLang = 'zh_CN';
  private lastText = '';
  private prevSentence = '';
  private usePunct = true;
  private punctPending = false;
  private lastPunctText = '';
  // 坑：标点延迟回调的代次令牌。INIT 重启或 STOP 停止时递增，在途的 setTimeout(0) 标点
  // 回调触发时发现代次已变就整体丢弃（不写缓存不发消息），防止上一场字幕串进新会话、
  // 或停止后字幕被迟到的标点结果"复活"。
  private punctEpoch = 0;

  // ---- 实时翻译（离线，worker 内跑 transformers.js）----
  // 模型由用户在面板选目录读入 IndexedDB，worker 内重写 fetch 从 IndexedDB 取文件，
  // 全程零网络零权限；翻译推理在独立 worker 线程，不阻塞本线程的音频泵/ASR。
  //
  // —— 调度模型（单 worker 单线程串行 + 优先级队列）——
  // worker 每次只跑一条翻译且按提交顺序返回；这里维护"在途 + 待办"两个槽，
  // 待办是一个按优先级取任务的队列。优先级（用户指定）：
  //   1. FINAL（上一句定稿）——用户体验上最重要：句子说完就该看到完整译文；
  //   2. STREAM（当前句实时中间态）——次之，只保留最新一版（旧中间态无意义）；
  //   3. BACKLOG（以往句的迟到定稿补译）——最末，但绝不丢弃。
  // 旧实现的三个丢译文根因全部由此消除：
  //   ① translateFinal 绕过队列直接 postMessage → final 与在途 stream 回包乱序，
  //      显示端按 seq 路由时定稿被同一句的旧中间态覆盖（"只有后半句"）；
  //   ② transPending 只有一个槽，句完成时未翻的中间态直接被置 null 丢弃；
  //   ③ 流式译文回包后按代次（epoch）整批作废——句子定稿后中间态不再有意义，
  //      但作废动作把"这句还没翻过"的事实也抹掉了，历史/回看里该句永久无译文。
  private translateWorker: Worker | null = null;
  private translateEnabled = false;
  private translateDirection: 'auto' | 'zh-en' | 'en-zh' = 'auto';
  // 翻译时机：stream=实时跟句（中间态重译）｜final=仅定稿（句完才翻，最省 CPU）
  private translationTiming: 'stream' | 'final' = 'stream';
  private translateWarned = false;

  // 当前识别句的序号（从 1 起）。随 SENTENCE_DONE 递增，随每次 TRANSLATE 消息带给 worker，
  // worker 结果原样回传 → 显示端据此把译文路由到"当前句行"还是"上一句行"。
  private sentenceSeq = 1;

  // —— 优先级队列状态 ——
  private inFlight: { kind: 'final' | 'stream'; seq: number; text: string } | null = null;
  private lastFinalTexts = new Map<number, string>();
  private transQueue: TransJob[] = [];
  private streamSlot: { text: string; seq: number } | null = null;
  private bestBySeq = new Map<number, string>();
  // backlog 上限：极端慢速下最多积压这些句的补译，防内存无界增长。
  private static readonly BACKLOG_MAX = 8;
  // 会话代次：随请求下发给 worker 并原样回传，对账时校验。
  private transGen = 0;

  // —— 延迟测量 ——
  private latEmaMs = 0;
  private lastFlushSentAt = 0;
  private lastLatencySentAt = 0;
  // —— 电平测量 ——
  private levelEnv = 0;
  private lastLevelSentAt = 0;

  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private captureStream: MediaStream | null = null;
  private fallbackCleanup: (() => void) | null = null;
  private flushTimer: any = null;

  // —— 预取采集流的提前看护（见 adoptCaptureStream 的注释）——
  // adoptedStream = 已经取到手、但还没接到管道上的那条流；adoptedAudioDead = 它的音频轨
  // 在接线前就结束了（"装完就已死"）。接线时由 consumeAdopted 认领并判定。
  private adoptedStream: MediaStream | null = null;
  private adoptedAudioDead = false;
  // 已挂过 ended 监听的轨道。adoptCaptureStream 与 pipeCaptureStream 会走到同一批轨道，
  // 必须幂等，否则同一轨道挂两个监听 → 一次中断上报两条 ERROR。
  private watchedTracks = new WeakSet<MediaStreamTrack>();
  // 当前正在喂管道的音源（tab/system）。文案要按它选：tab 音源的轨道结束=来源结束，
  // 不能报成"系统音频轨中断"。
  private captureSource: EngineSource = 'tab';
  // 已经上报过"来源结束"的流：同一条流只收敛一次（多轨同时 ended 时不重复报）。
  private endedReported = new WeakSet<MediaStream>();

  // 会话代次：INIT/STOP 各递增一次，用于作废在途的异步初始化。
  private sessionEpoch = 0;
  private scriptsReady: Promise<void> | null = null;

  // —— 翻译自测 ——
  private translateTestResolver: ((r: TranslateTestResult) => void) | null = null;
  private translateTestTimer: any = null;
  private testOwnedWorker = false;

  constructor(opts: EngineOptions) {
    this.resolveUrl = opts.resolveUrl;
    this.sink = opts.sink;
    this.pushMs = Math.max(0, Number(opts.pushMs) || 0);
  }

  // 预热：把 IndexedDB 模型读成 blob URL 并注入三个 wasm 脚本。
  // 扩展侧在 offscreen 文档加载时立即调用（与旧实现一致：文档一建就开始加载，
  // 等 INIT 到达时 WASM 往往已就绪）；Web 版在面板加载时调用，但**模型没装时会静默跳过**
  // ——那时注入 wasm 会留下半初始化的 pthread 运行时（见 injectWasmScripts 注释）。
  // 幂等：重复调用共用同一个 Promise（失败会复位，允许重试）。
  preload(): Promise<void> {
    return this.ensureScripts().then(
      () => undefined,
      (e) => {
        if (String(e?.message || e) === ERR_MODEL_MISSING) {
          this.log('识别模型尚未安装，跳过 wasm 预热（点「开始」会引导下载或导入）');
          return;
        }
        // 其它注入错误只是"预热失败"：不阻断页面，等用户点开始时再报一次真实错误。
        this.log('wasm 预热失败（点「开始」时会重试）：' + (e?.message || e));
      },
    );
  }

  // ================= 生命周期 =================

  hasPipeline(): boolean { return !!this.pipeline; }
  // wasm 运行时是否已注入就绪（宿主可用于"模型还没装"的前置提示）
  isRuntimeLoaded(): boolean { return !!(window as any).__wasmReady; }
  getReconnectInfo(): ReconnectInfo {
    return { tabId: this.reconnectTabId, streamId: this.reconnectStreamId, source: this.reconnectSource };
  }
  isTranslateWorkerAlive(): boolean { return !!this.translateWorker; }

  log(msg: string) {
    console.log('[易字幕 引擎]', msg);
    this.sink.log(msg);
  }

  async init(msg: InitOptions): Promise<void> {
    this.log('收到 INIT');
    this.sessionEpoch++;
    const epoch = this.sessionEpoch;
    this.reconnectTabId = msg.tabId ?? null;
    // 扩展的 background 目前不在 INIT 里带 streamId（tab 流由 STREAM_READY 后补），
    // 但保持与旧实现同构：带上就记下来，重连上报时一并还原，免得日后 bg 补发该字段时静默失效。
    this.reconnectStreamId = (msg as any).streamId || null;
    this.reconnectSource = msg.source === 'system' ? 'system' : msg.source === 'mic' ? 'mic' : 'tab';
    if (msg.lang) this.currentLang = msg.lang;
    this.usePunct = msg.usePunct !== false;

    this.stopAudio();
    this.pipeline?.stop();
    this.pipeline = null;

    this.translateEnabled = msg.translationEnabled === true;
    this.translateDirection = msg.translationDirection === 'zh-en' || msg.translationDirection === 'en-zh'
      ? msg.translationDirection : 'auto';
    this.translationTiming = msg.translationTiming === 'final' ? 'final' : 'stream';
    if (this.translateEnabled) this.ensureTranslateWorker();
    this.resetTranslationState();

    // 坑：跨会话残留的文本状态会让新会话开头闪出上一场的字幕；这里全部清零，
    // 并递增标点代次使所有在途的标点延迟回调失效（回调内部会校验代次）。
    this.lastText = '';
    this.prevSentence = '';
    this.lastPunctText = '';
    this.punctPending = false;
    this.punctEpoch++;
    this.latEmaMs = 0;
    this.lastFlushSentAt = 0;
    this.lastLatencySentAt = 0;
    this.levelEnv = 0;
    this.lastLevelSentAt = 0;

    this.pipeline = new Pipeline({
      onTextChanged: (text) => this.handleTextChanged(text),
      onSentenceDone: (text) => this.handleSentenceDone(text),
      onStatusChanged: (status) => {
        this.sink.toPanel({ type: 'STATUS_CHANGED', status: JobStatus[status] });
      },
      onError: (err) => {
        this.log('错误: ' + err.message);
        try { this.pipeline?.stop(); } catch (e) { this.log('stop 异常: ' + e); }
        this.sink.toPanel({ type: 'ERROR', message: err.message });
      },
    });

    try {
      // system 模式：先弹选择器拿权限、拿到音频，再加载模型——用户不必对着
      // "已运行却没字幕"干等模型加载完才见弹窗，取消选择时也不会白加载一遍模型。
      // mic 模式音频由宿主采集后 feedMicChunk 送入，无需预拿。
      let preStream: MediaStream | null = null;
      const needLoadModel = !(window as any).__wasmReady
        || !(window as any).__recognizer
        || (this.usePunct && !(window as any).__punctuator);
      if (this.reconnectSource === 'system') {
        if (msg.preStream) {
          // 宿主已在用户手势内取好流（Web 版）：直接用它，跳过选择器
          preStream = msg.preStream;
        } else {
          this.sendStatus('pickingScreen');
          try {
            preStream = await this.acquireSystemAudioStream();
          } catch (e: any) {
            this.log('系统音频捕获失败或已取消: ' + (e?.message || e));
            const cancelled = e?.name === 'NotAllowedError' || e?.name === 'AbortError';
            this.sink.toPanel({
              type: 'ERROR',
              message: cancelled ? tSync(this.currentLang, 'pickerCancelled') : `系统音频捕获失败: ${e?.message || e}`,
            });
            this.sink.requestStop();
            return;
          }
        }
        if (epoch !== this.sessionEpoch) {
          preStream.getTracks().forEach((t) => t.stop());
          return;
        }
      }
      if (needLoadModel) this.sendStatus('loadingModel');
      await this.waitForWasm();
      // 识别器配置指纹：端点阈值与热词都在 createOnlineRecognizer 时一次性烘焙进 WASM
      // 配置，运行时改不了。扩展侧靠"停止即销毁 offscreen 文档"天然拿到新配置；纯 Web 版
      // 页面常驻不销毁，若只看"有没有 recognizer"，用户第二场会话起改了阈值/热词会**永不生效**
      // （看起来像功能坏了）。这里比对指纹，变了就把旧识别器 free 掉再按新配置重建。
      //
      // 为什么 free+create 是安全的（与文件顶部"WASM 无法二次加载模型"的警告不冲突）：
      // 那条警告针对的是①重新求值 wasm 加载器、②同时存在两个识别器（模型经 .data 常驻
      // MEMFS，两份推理会话会让内存峰值翻倍）。同一 Module 内先销毁再新建走的是
      // SherpaOnnxDestroyOnlineRecognizer → SherpaOnnxCreateOnlineRecognizer 的正常
      // 生命周期，模型映像仍只有一份。此刻上一场的 pipeline 已在 init 开头 stop（流已 free），
      // 本场 pipeline 尚未 start，不存在活着的流引用旧句柄。
      const recCfgKey = JSON.stringify([
        msg.endpointRule1 ?? null, msg.endpointRule2 ?? null, msg.endpointRule3 ?? null,
        Array.isArray(msg.hotwords) && msg.hotwords.length ? msg.hotwords : null,
      ]);
      if ((window as any).__recognizer && recognizerCfgKey !== null && recognizerCfgKey !== recCfgKey) {
        this.log('识别配置已变更，重建识别器');
        try {
          (window as any).__recognizer.free?.();
        } catch (e) {
          this.log('释放旧识别器失败（继续重建）: ' + e);
        }
        (window as any).__recognizer = null;
      }
      if (!(window as any).__recognizer) {
        this.createRecognizer(msg);
        recognizerCfgKey = recCfgKey;
      }
      if (this.usePunct && !(window as any).__punctuator) {
        try {
          (window as any).__punctuator = new (window as any).OfflinePunctuation({
            model: { ctTransformer: 'model.punct.int8.onnx', numThreads: 1, provider: 'cpu' }
          }, (window as any).Module);
        } catch (e) {
          this.log('标点模型初始化失败: ' + e);
        }
      }
      if (epoch !== this.sessionEpoch) {
        preStream?.getTracks().forEach((t) => t.stop());
        return;
      }
      this.sendStatus(this.reconnectSource === 'system' ? '' : 'waiting');
      await this.pipeline!.start();
      // 坑：capture streamId 有效期很短，必须在消费前一刻才签发。此刻 WASM/模型已就绪，
      // 向宿主要一个全新的 streamId 并立即开流。旧实现"启动时预签发、模型加载完才消费"，
      // 时间窗一长就会报 "Error starting tab capture"。
      if (this.reconnectSource === 'tab') {
        this.sink.toPanel({ type: 'REQUEST_STREAM', tabId: this.reconnectTabId, source: 'tab' });
      } else if (this.reconnectSource === 'system') {
        if (!preStream || epoch !== this.sessionEpoch) {
          preStream?.getTracks().forEach((t) => t.stop());
          return;
        }
        try {
          await this.pipeCaptureStream(preStream, 'system');
        } catch (e: any) {
          this.log('系统音频接入管道失败: ' + (e?.message || e));
          preStream.getTracks().forEach((t) => t.stop());
          this.sink.toPanel({ type: 'ERROR', message: `系统音频接入失败: ${e?.message || e}` });
          this.sink.requestStop();
        }
      }
      // mic：什么都不做——宿主采集的 PCM 会以 feedMicChunk 持续流入
    } catch (e: any) {
      // 坑：模型缺失（MODEL_MISSING）是**预期内的用户态**，不是故障——面板本应先弹引导
      // 拦下，但测试翻译等路径会绕过那道门卫。这里必须换成可读文案，否则用户看到的是
      // 「Pipeline启动失败: MODEL_MISSING」这种内部标记（既不像错误也不给下一步）。
      const raw = e?.message || String(e);
      const desc = raw === ERR_MODEL_MISSING
        ? tSync(this.currentLang, 'asrModelMissingRuntime')
        : await this.describeWasmException(e);
      this.log('INIT 异常: ' + desc);
      this.sink.toPanel({ type: 'ERROR', message: `Pipeline启动失败: ${desc}` });
      // 会话注定跑不起来：请求宿主收敛，别把界面停在"识别中"（幽灵会话）
      if (raw === ERR_MODEL_MISSING) this.sink.requestStop();
    }
  }

  stop() {
    this.log('收到 STOP');
    this.sessionEpoch++;
    this.reconnectTabId = null;
    this.reconnectStreamId = null;
    this.stopAudio();
    this.destroyTranslateWorker();
    this.translateEnabled = false;
    this.pipeline?.stop();
    this.pipeline = null;
    // 坑：停止同样要作废在途的标点延迟回调，否则迟到的标点结果会把已清空的
    // 字幕重新写回缓存并推给显示端，表现为"点了停止字幕又复活"。
    this.punctPending = false;
    this.punctEpoch++;
    this.lastText = '';
    this.prevSentence = '';
    this.lastPunctText = '';
    this.levelEnv = 0;
    this.lastLevelSentAt = 0;
  }

  setPunctuation(enabled: boolean) {
    this.usePunct = enabled !== false;
    this.log('标点功能: ' + (this.usePunct ? '开' : '关'));
    // 会话中从关到开：标点模型只在 init 时按当时的开关创建，这里不补建的话会静默退到
    // 规则标点（punctuator.ts 的兜底），效果与"标点已开"的预期不一致且没有任何提示。
    // 补建失败只记日志：规则标点仍可用，不阻断识别。
    if (this.usePunct && !(window as any).__punctuator && (window as any).Module) {
      try {
        (window as any).__punctuator = new (window as any).OfflinePunctuation({
          model: { ctTransformer: 'model.punct.int8.onnx', numThreads: 1, provider: 'cpu' },
        }, (window as any).Module);
        this.log('标点模型已就绪（会话中开启）');
      } catch (e) {
        this.log('标点模型初始化失败，暂时使用规则标点: ' + e);
      }
    }
  }

  // 端点阈值只在建 recognizer 时一次性烘焙，运行时改不了；此处仅记录日志
  logEndpoint(rule1: number, rule2: number, rule3: number) {
    this.log(`端点阈值 saved: ${rule1}/${rule2}/${rule3} (重启生效)`);
  }

  resendCurrentText() {
    if (this.lastText || this.prevSentence) {
      const display = displayCase(this.lastText);
      this.sink.toDisplay({ type: 'OVERLAY_TEXT', prev: this.prevSentence, current: display });
      this.sink.toDisplay({ type: 'TEXT_CHANGED', text: display });
      this.sink.toPanel({ type: 'TEXT_CHANGED', text: display });
    }
  }

  // ================= 识别结果处理 =================

  private handleTextChanged(text: string) {
    this.lastText = text;
    if (this.usePunct) {
      const display = displayCase(this.lastPunctText || text);
      this.sink.toDisplay({ type: 'TEXT_CHANGED', text: display });
      this.sink.toPanel({ type: 'TEXT_CHANGED', text: display });
      this.sink.toDisplay({ type: 'OVERLAY_TEXT', prev: this.prevSentence, current: display });
      if (!this.punctPending) {
        // ponytail: setTimeout(0) 推迟标点推理，避免同步阻塞 audio pump 丢帧
        this.punctPending = true;
        const epoch = this.punctEpoch;
        setTimeout(() => {
          if (epoch !== this.punctEpoch) return;
          this.punctPending = false;
          this.lastPunctText = displayCase(addPunctuation(this.lastText));
          this.sink.toDisplay({ type: 'OVERLAY_TEXT', prev: this.prevSentence, current: this.lastPunctText });
          this.sink.toDisplay({ type: 'TEXT_CHANGED', text: this.lastPunctText });
          this.sink.toPanel({ type: 'TEXT_CHANGED', text: this.lastPunctText });
          // 坑（实测"实时译文反复横跳"根因）：流式翻译必须喂带标点的文本。
          // opus-mt 对无标点的长串中文输出极不稳定——同一句每次前缀增长后重翻，
          // 时而只翻第一分句、时而多翻、措辞漂移，屏幕上来回跳；带标点输入
          // 结构清晰、输出稳定得多（定稿路径一直用带标点文本，效果对比明显）。
          this.translateStream(this.lastPunctText);
        }, 0);
      }
    } else {
      const display = displayCase(text);
      this.sink.toDisplay({ type: 'OVERLAY_TEXT', prev: this.prevSentence, current: display });
      this.sink.toDisplay({ type: 'TEXT_CHANGED', text: display });
      this.sink.toPanel({ type: 'TEXT_CHANGED', text: display });
      this.translateStream(text);
    }
  }

  private handleSentenceDone(text: string) {
    // ponytail: addPunctuation 同步调 CT-Transformer 模型推理，会阻塞主线程；
    // AudioWorklet 在音频线程持续缓冲，解阻塞后 pipeline 处理积压帧
    this.prevSentence = this.usePunct ? displayCase(addPunctuation(text)) : displayCase(text);
    this.lastText = '';
    this.lastPunctText = '';
    const seq = this.sentenceSeq;
    // 坑（丢译文修复）：上一句（seq-1）若已有流式译文但定稿任务还没轮到跑，
    // 旧实现会因"中间态过期"把它整个丢掉，且不再补翻——该句译文永久丢失。
    // 现在把它的"最终文本"以最低优先级（backlog）排队补翻。
    if (seq - 1 >= 1 && !this.bestBySeq.has(seq - 1)) {
      const prevFinal = this.lastFinalTexts.get(seq - 1);
      if (prevFinal) this.translateBacklog(seq - 1, prevFinal);
    }
    this.lastFinalTexts.set(seq, this.prevSentence);
    for (const k of this.lastFinalTexts.keys()) {
      if (k < seq - AsrEngine.BACKLOG_MAX - 2) this.lastFinalTexts.delete(k);
    }
    this.sink.toDisplay({ type: 'OVERLAY_TEXT', prev: this.prevSentence, current: '' });
    this.sink.toDisplay({ type: 'SENTENCE_DONE', text: this.prevSentence, isFinal: true, seq });
    this.sink.toPanel({ type: 'SENTENCE_DONE', text: this.prevSentence, seq });
    this.translateFinal(this.prevSentence);
    this.sentenceSeq = seq + 1;
  }

  // ================= 翻译 =================

  private dropStaleBest() {
    const minAlive = this.sentenceSeq - AsrEngine.BACKLOG_MAX - 2;
    for (const k of this.bestBySeq.keys()) {
      if (k < minAlive) this.bestBySeq.delete(k);
    }
  }

  private createTranslateWorker() {
    this.translateWorker = new Worker(this.resolveUrl('translation-worker.js'));
    // worker 脚本本身加载失败（部署漏文件/MIME 错/模块求值期抛错）时不会有人回包：
    // 在途任务永远挂着、队列持续堆积、用户只看到"开了翻译却永远没译文"且没有任何提示。
    // 这里必须**放弃本场翻译**而不是重试：脚本加载失败时 postMessage 无人接收、也不会
    // 再触发 onerror，重试只会让 inFlight 再次卡住；translateWarned 这个一次性告警门
    // 正好用来止住后续入队（导入翻译模型时会经 notifyTranslationModelImported 复位）。
    this.translateWorker.onerror = (e: any) => {
      this.inFlight = null;
      this.transQueue.length = 0;
      this.streamSlot = null;
      this.finishTranslateTest({ ok: false, error: 'worker-error' });
      if (!this.translateWarned) {
        this.translateWarned = true;
        this.log('翻译不可用：翻译 worker 加载/运行失败（' + (e?.message || e?.filename || '未知错误') +
          '）。请检查 translation-worker.js 是否随构建一起部署。');
      }
    };
    this.translateWorker.onmessageerror = () => {
      this.log('翻译 worker 消息解析失败（已跳过该条）');
      this.inFlight = null;
    };
    this.translateWorker.onmessage = (e) => {
      const m = (e.data || {}) as any;
      if (m.type !== 'TRANSLATION') return;
      if (m.test) {
        this.finishTranslateTest({
          ok: !!m.ok && !!m.text,
          text: m.text || '',
          error: m.reason === 'no-model' ? 'no-model' : (m.error || ''),
          debug: m.debug,
        });
        return;
      }
      // 坑：回包按 seq + 会话代次对账。实测发现 opus-mt 的 tokenizer/生成会对文本做
      // 规范化改写（大小写/标点/空格），按 text 全等比对会让几乎所有回包对不上号而被
      // 整体丢弃（表现为一条译文都出不来）。worker 原样回传 seq/gen：串行单在途下，
      // 同 seq 的回包只可能来自当前请求；gen 挡住跨会话的撞号回包。
      if (e.target !== this.translateWorker) return;
      if (this.inFlight && m.seq === this.inFlight.seq && m.gen === this.transGen) {
        const done = this.inFlight;
        this.inFlight = null;
        this.onTranslationResult(done, m);
      } else if (this.inFlight) {
        this.log(`[译] 回包对不上号：在途 seq=${this.inFlight.seq}/${this.inFlight.kind}，回包 seq=${m.seq}/${m.kind}，丢弃`);
      }
      this.pumpTranslate();
    };
  }

  // 一条翻译请求完成：按优先级语义交付结果。
  //   - FINAL：定稿译文写 bestBySeq 并立即下发（SENTENCE_DONE 之后显示端都在等它）；
  //   - STREAM：中间态译文只在"该句尚未定稿"时下发，且绝不覆盖更优的定稿；
  //   - BACKLOG：以往句的补译定稿，写 bestBySeq + 下发，顺序无所谓。
  private onTranslationResult(job: { kind: 'final' | 'stream'; seq: number; text: string }, m: any) {
    const prev = this.bestBySeq.get(job.seq);
    if (m.ok && m.text) {
      if (job.kind !== 'stream' || prev == null) this.bestBySeq.set(job.seq, m.text);
      const text = m.text;
      if (job.kind === 'stream') {
        if (job.seq === this.sentenceSeq) this.sink.toDisplay({ type: 'TRANSLATION', text, seq: job.seq });
      } else {
        this.sink.toDisplay({ type: 'TRANSLATION_FINAL', text, seq: job.seq });
        this.sink.toPanel({ type: 'TRANSLATION_FINAL', text, seq: job.seq });
      }
      this.log(`[译] 交付 seq=${job.seq}/${job.kind} → "${String(text).slice(0, 30)}"`);
    } else if (m.reason === 'no-model' && !this.translateWarned) {
      this.translateWarned = true;
      // 保留发布页地址：用户没有其它自助恢复途径，日志是唯一告知渠道（扩展侧原文如此）
      this.log('翻译不可用：未检测到翻译模型。请在面板"实时翻译"中点击"选择模型"安装官方模型包（github.com/easysub-org/easysub/releases）');
    } else if (m.error && !this.translateWarned) {
      this.translateWarned = true;
      this.log('翻译出错: ' + m.error);
    }
    this.dropStaleBest();
  }

  // —— 队列泵：worker 空闲时按优先级取下一个任务 ——
  private pumpTranslate() {
    if (!this.translateWorker || !this.translateEnabled || this.inFlight) return;
    let job: TransJob | null = null;
    let idx = -1;
    let fromSlot = false;
    // 优先级 1：定稿（上一句）——最高优先，绝不被流式跟句或积压拖延
    for (let i = 0; i < this.transQueue.length; i++) {
      if (this.transQueue[i].kind === 'final') { job = this.transQueue[i]; idx = i; break; }
    }
    // 优先级 2：实时流式——无人工延迟：worker 空闲且槽里有最新中间态就立即提交。
    if (!job && this.streamSlot && this.translationTiming === 'stream') {
      job = { kind: 'stream', seq: this.streamSlot.seq, text: this.streamSlot.text, at: Date.now() };
      fromSlot = true;
    }
    // 优先级 3：以往积压补译（当前句无待翻文本时的空档里跑，worker 不空转）。
    // 坑：同句的 final 可能已交付（bestBySeq 有记录）而 backlog 还排在队列里
    // （入队时它尚无结果）——不在这里拦截就会二次下发同一句定稿，面板的
    // "末条无译文"兜底会把它挂到更新的句子上（审查发现的实际错挂路径）。
    if (!job) {
      for (let i = 0; i < this.transQueue.length; i++) {
        const j = this.transQueue[i];
        if (j.kind !== 'backlog') continue;
        if (this.bestBySeq.has(j.seq)) { this.transQueue.splice(i, 1); i--; continue; }
        job = j; idx = i; break;
      }
    }
    if (!job) return;
    if (fromSlot) this.streamSlot = null;
    else if (idx >= 0) this.transQueue.splice(idx, 1);
    this.inFlight = { kind: job.kind === 'backlog' ? 'final' : job.kind, seq: job.seq, text: job.text };
    this.log(`[译] 提交 seq=${job.seq}/${job.kind} "${job.text.slice(0, 24)}" 队列余=${this.transQueue.length}${this.streamSlot ? ' 槽有货' : ''}`);
    this.translateWorker.postMessage({
      type: 'TRANSLATE',
      text: job.text,
      seq: job.seq,
      direction: this.translateDirection,
      kind: job.kind === 'backlog' ? 'final' : job.kind,
      gen: this.transGen,
      wasmPaths: this.resolveUrl('ort-wasm/'),
    });
  }

  private ensureTranslateWorker() {
    if (this.translateWorker || !this.translateEnabled) return;
    try {
      this.createTranslateWorker();
    } catch (e) {
      this.log('翻译 worker 创建失败: ' + e);
    }
  }

  testTranslate(text: string, direction: string): Promise<TranslateTestResult> {
    return new Promise((resolve) => {
      // 测试不依赖"启用翻译"开关：翻译未启用也创建 worker 实测（模型加载失败会因记忆化只跑一次）
      if (!this.translateWorker) {
        try {
          this.createTranslateWorker();
          this.testOwnedWorker = true;
        } catch (e) {
          resolve({ ok: false, error: 'worker-create-fail' });
          return;
        }
      } else {
        // 复用会话自己的 worker：它不属于测试，取消测试时绝不能 terminate 掉
        // （否则正在跑的会话从此静默丢译，且没有任何报错）。
        this.testOwnedWorker = false;
      }
      this.translateTestResolver = resolve;
      // 测试用 24 个 token 上限：短句足够验证模型可用，避免单线程生成跑满 128 token 久久不返回
      this.translateWorker!.postMessage({
        type: 'TRANSLATE', text, direction, kind: 'final',
        wasmPaths: this.resolveUrl('ort-wasm/'), test: true, maxNewTokens: 24,
      });
      this.translateTestTimer = setTimeout(() => this.finishTranslateTest({ ok: false, error: 'timeout' }), 120000);
    });
  }

  cancelTranslateTest() {
    if (this.testOwnedWorker && this.translateWorker) {
      this.resetTranslationState();
      this.translateWorker.terminate();
      this.translateWorker = null;
    }
    this.finishTranslateTest({ ok: false, error: 'cancelled' });
  }

  private finishTranslateTest(r: TranslateTestResult) {
    if (this.translateTestTimer) { clearTimeout(this.translateTestTimer); this.translateTestTimer = null; }
    if (this.translateTestResolver) {
      const cb = this.translateTestResolver;
      this.translateTestResolver = null;
      cb(r);
    }
  }

  // —— 翻译状态整体复位：会话停止 / 测试取消 / worker 重建时调用，防上一场任务串场 ——
  private resetTranslationState() {
    this.inFlight = null;
    this.transQueue.length = 0;
    this.streamSlot = null;
    this.bestBySeq.clear();
    this.lastFinalTexts.clear();
    this.sentenceSeq = 1;
    this.transGen++;
  }

  private destroyTranslateWorker() {
    this.resetTranslationState();
    this.translateWorker?.terminate();
    this.translateWorker = null;
    this.translateWarned = false;
    // 测试若还在途（worker 已 terminate，onmessage 永远不会回来），立刻收敛——
    // 否则面板的"测试翻译"按钮要卡满 120s 超时才解开。无在途测试时是空操作。
    this.finishTranslateTest({ ok: false, error: 'cancelled' });
  }

  // 翻译模型（重新）导入后由宿主调用：解除两处"缺模型"的记忆，让正在运行的会话
  // 不重启就能开始出译文。
  //   ① translateWarned —— 一次性告警门，立起后 translateStream/translateFinal 直接
  //      早退，不再入队；
  //   ② worker 里的加载缓存 —— 缺模/加载失败的结果都被记忆化，转发 RESET_MODEL_CACHE
  //      让下一句重新检查 IndexedDB（模型导入后立即生效）。
  // 若翻译本身没开（worker 不存在），仅复位告警门：下次 INIT 带上翻译开关时自会建 worker。
  // 坑：还要处理"会话开着、翻译 worker 也建好了，但用户此刻才勾上实时翻译开关"的情况——
  // 翻译开关只在 INIT 时定格（translateEnabled=false 就不建 worker），运行中勾选如果什么都不做，
  // 用户会以为"开了没反应"。这里补上：开关打开且尚无 worker 就建一个，本场立即开始出译文。
  notifyTranslationModelImported() {
    this.translateWarned = false;
    if (this.translateEnabled) this.ensureTranslateWorker();
    this.translateWorker?.postMessage({ type: 'RESET_MODEL_CACHE' });
  }

  // 运行中改实时翻译设置（面板在会话进行中切换开关/方向/时机时调用）。
  // 为什么需要它：翻译开关/方向/时机原本只在 INIT 时定格，运行中改了不生效、也没有任何
  // 反馈，用户会以为"开了没反应、改了没用"。这里把三个字段更新到当前会话并补齐 worker，
  // 当场生效（扩展侧同一份实现，两端行为一致）。
  // 注意方向/时机只影响后续请求：在途那条仍按发出时的方向返回，回包按 seq+gen 对账，
  // 不会错位；切到 final 只是不再入队中间态。
  setTranslationLive(enabled: boolean, direction: 'auto' | 'zh-en' | 'en-zh', timing: 'stream' | 'final') {
    this.translateEnabled = enabled;
    this.translateDirection = direction;
    this.translationTiming = timing;
    this.log(`实时翻译（本场生效）: ${enabled ? '开' : '关'} 方向=${direction} 时机=${timing}`);
    if (!enabled) {
      // 关掉就停掉在途与积压，不再占用 CPU；worker 留着下次秒开
      this.inFlight = null;
      this.transQueue.length = 0;
      this.streamSlot = null;
      return;
    }
    this.translateWarned = false;
    this.ensureTranslateWorker();
    // 刚打开时把"当前这一句"补进去：否则要等到下一句才有译文，用户以为没生效
    if (this.prevSentence) this.translateBacklog(this.sentenceSeq - 1, this.prevSentence);
  }

  private translateStream(text: string) {
    // 仅定稿模式：中间态不翻译，译文只随 SENTENCE_DONE 出
    if (this.translationTiming === 'final') return;
    if (!this.translateEnabled || !this.translateWorker || this.translateWarned || !text) return;
    text = normalizeForTranslate(text);
    if (this.inFlight?.kind === 'stream' && this.inFlight.seq === this.sentenceSeq && this.inFlight.text === text) return;
    if (this.streamSlot && this.streamSlot.seq === this.sentenceSeq && this.streamSlot.text === text) return;
    this.streamSlot = { text, seq: this.sentenceSeq };
    this.pumpTranslate();
  }

  // 定稿：句子结束翻一次并记录。定稿只是"最高优先级入队"：在途的中间态跑完后，
  // worker 下一条立即翻本定稿；同时该句积压的流式任务全部作废。
  private translateFinal(text: string) {
    if (!this.translateEnabled || !this.translateWorker || this.translateWarned || !text) return;
    const seq = this.sentenceSeq;
    // 坑：不能清 inFlight！worker 里那条 stream 请求还在跑，清了之后泵会把 final
    // 提交上去，stream 回包先到时按 seq 会撞上 final 的在途记账——半截译文被误当
    // 定稿交付，真正的 final 回包反而对不上号被丢。
    for (let i = this.transQueue.length - 1; i >= 0; i--) {
      if (this.transQueue[i].kind === 'stream' && this.transQueue[i].seq === seq) this.transQueue.splice(i, 1);
    }
    if (this.streamSlot && this.streamSlot.seq === seq) this.streamSlot = null;
    this.transQueue.push({ kind: 'final', seq, text: normalizeForTranslate(text), at: Date.now() });
    this.pumpTranslate();
    this.log(`[译] final 入队 seq=${seq} 队列=${this.transQueue.length} 在途=${this.inFlight ? this.inFlight.kind + '#' + this.inFlight.seq : '无'}`);
  }

  private translateBacklog(seq: number, text: string) {
    if (!this.translateEnabled || !this.translateWorker || this.translateWarned || !text) return;
    if (this.bestBySeq.get(seq) === normalizeForTranslate(text)) return;
    const existing = this.transQueue.find(j => j.seq === seq && j.kind === 'backlog');
    if (existing) { existing.text = normalizeForTranslate(text); return; }
    this.transQueue.push({ kind: 'backlog', seq, text: normalizeForTranslate(text), at: Date.now() });
    // backlog 容量钳制：丢最老（seq 最小）的超出部分
    const bl = this.transQueue.filter(j => j.kind === 'backlog').sort((a, b) => a.seq - b.seq);
    if (bl.length > AsrEngine.BACKLOG_MAX) {
      const victim = bl[0];
      const vi = this.transQueue.indexOf(victim);
      if (vi >= 0) this.transQueue.splice(vi, 1);
    }
    this.pumpTranslate();
  }

  // ================= 延迟 / 电平测量 =================

  // 指标口径：latEmaMs = 「flush 往返延迟 RTT + 本块同步处理耗时」的指数滑动平均（α=0.2）。
  // RTT 主要反映主线程被标点推理等任务阻塞造成的音频消费滞后；处理耗时反映识别器积压。
  // 局限：不含识别器内部流式缓冲与端点检测的固有等待（如尾静音 0.8s 停顿），所以这是
  // "处理链路延迟"的近似，不是严格的音频→字幕端到端时延。
  private recordLatency(rttMs: number, procMs: number) {
    const sample = rttMs + procMs;
    this.latEmaMs = this.latEmaMs === 0 ? sample : this.latEmaMs * 0.8 + sample * 0.2;
    // 节流坑：≥2 秒最多一条。先查节流窗口再决定是否发，避免每 60ms 都做消息序列化。
    if (Date.now() - this.lastLatencySentAt < 2000) return;
    if (!this.pipeline || this.pipeline.getStatus() !== JobStatus.Running) return;
    this.lastLatencySentAt = Date.now();
    this.sink.toDisplay({ type: 'LATENCY_UPDATE', ms: Math.round(this.latEmaMs) });
  }

  // 电平口径：复用 60ms flush 回包路径的音频帧算 RMS，"慢攻击快释放"包络平滑后
  // 归一化到 [0,1]；rms×4 后截断（正常语音块 RMS 约 0.05~0.25）。纯固定增益无 AGC。
  private recordLevel(buf: Float32Array) {
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
    const rms = Math.sqrt(sumSq / Math.max(1, buf.length));
    const target = Math.min(1, rms * 4);
    // 坑：攻击/释放不对称是刻意的——对称平滑会在语音起音时明显滞后、静音时又拖尾。
    this.levelEnv = target > this.levelEnv ? this.levelEnv * 0.8 + target * 0.2 : this.levelEnv * 0.4 + target * 0.6;
    // 节流坑：≥120ms 一条（约 8 条/秒足够指示器流畅）
    if (Date.now() - this.lastLevelSentAt < 120) return;
    if (!this.pipeline || this.pipeline.getStatus() !== JobStatus.Running) return;
    this.lastLevelSentAt = Date.now();
    this.sink.toPanel({ type: 'LEVEL', v: Math.round(this.levelEnv * 100) / 100 });
  }

  // ================= 音频采集 =================

  // —— 采集流的提前看护 ——
  // 登记一条"已经拿到手、但还没接到管道上"的采集流，**取到流的那一刻**就挂 ended 监听。
  //
  // 坑（Web 版系统音频"启动有概率静默失败 / 莫名其妙收到 STOP"的根因）：
  // Web 版的屏幕共享流是在用户手势里先取好的（web/panel.ts → web/host.ts 的 preAcquireAudio），
  // 之后还要穿过「读会话配置 → 建识别器（实测数秒）→ pipeline.start」才在 pipeCaptureStream
  // 里接线。而 MediaStreamTrack 的 ended **只发一次**：
  //   ① 音频轨若在这段间隙里就结束了（Chromium 的系统音频环回有"共享仍在、音频轨先 ended"
  //      的已知缺陷，蓝牙耳机 / 音频设备切换下概率触发），等接线时才挂监听就永远收不到——
  //      会话以"运行中却永远没有声音"的幽灵态一直挂着，正是用户看到的"静默失败"；
  //   ② 事件若恰好赶在挂上监听之后才到，又会被当成"用户停止了共享"上报 ERROR，宿主
  //      （web/host.ts 的 toPanel 对任何 ERROR 都 stopSession）据此收敛整场会话——
  //      用户什么都没动却"莫名其妙收到 STOP"。
  // 两种表现同一个根因：轨道生命周期没有从"拿到流"那一刻开始看护。
  // 这里登记并挂监听，把"音频轨已死"的事实记在 adoptedAudioDead 上，接线时核对它，
  // 就能把静默失败变成一条说得清的错误。**未接线期间不上报**：那时会话可能还没被受理
  // （用户正停在模型引导卡上），报错只会打扰人；事实照记，接线时自然会判定。
  adoptCaptureStream(stream: MediaStream) {
    if (this.captureStream === stream) return;
    if (this.adoptedStream !== stream) {
      this.adoptedStream = stream;
      this.adoptedAudioDead = false;
      // 坑："装完就已死"：登记时轨道可能**已经** ended（事件早就发过了，监听挂得再早也
      // 收不到）。判死活只认音频轨——画面轨是我们主动 stop 的（见 acquireSystemAudioStream），
      // 它的 readyState 恒为 ended，拿它判会把每一场都误判成死流。
      const audio = stream.getAudioTracks()[0] ?? null;
      if (audio && audio.readyState === 'ended') this.adoptedAudioDead = true;
    }
    this.watchCaptureTracks(stream);
  }

  // 给一条采集流的轨道挂 ended 监听（幂等：同一轨道只挂一次；adopt 与接线两条路都会调到）。
  // 监听体只做三件事：① 记账（音频轨死了，供接线时核对）；② 这条流已经在喂管道时上报
  // "来源结束"，由宿主收敛会话（原行为）；③ 同一条流只收敛一次（多轨同时 ended 不发两条）。
  private watchCaptureTracks(stream: MediaStream) {
    stream.getTracks().forEach((track) => {
      if (this.watchedTracks.has(track)) return;
      this.watchedTracks.add(track);
      // 注意：自己调 track.stop() **不会**触发本事件，所以 stopAudio() 的清理不会误报。
      track.addEventListener('ended', () => {
        if (track.kind === 'audio') {
          if (this.adoptedStream === stream) this.adoptedAudioDead = true;
          if (this.captureStream !== stream) return; // 还没接线：只记账（见 adoptCaptureStream）
          this.reportSourceEnded(stream, 'sourceAudioTrackLost', '音频轨已结束，上报停止');
          return;
        }
        // 画面轨：system 模式下它由我们主动 stop（主动 stop 不触发本事件）；tab 音源没有
        // 画面轨。真走到这里只可能是被捕获的屏幕/窗口被关闭 —— 沿用"来源已结束"文案。
        if (this.captureStream !== stream) return;
        this.reportSourceEnded(stream, 'sourceEnded', '画面轨已结束，上报停止');
      });
    });
  }

  // "来源结束"的统一上报口：同一条流只发一次（音+画同时 ended 时不重复报），
  // 文案按音源选——tab 音源的轨道结束就是"标签页/共享结束"，别报成"系统音频轨中断"。
  private reportSourceEnded(stream: MediaStream, key: 'sourceEnded' | 'sourceAudioTrackLost', logMsg: string) {
    if (this.endedReported.has(stream)) return;
    this.endedReported.add(stream);
    const useKey = key === 'sourceAudioTrackLost' && this.captureSource !== 'system' ? 'sourceEnded' : key;
    this.log(logMsg);
    this.sink.toPanel({ type: 'ERROR', message: tSync(this.currentLang, useKey) });
  }

  // 接线时认领提前看护的记账，返回"这条流的音频轨在接入管道前是否已经死了"。
  private consumeAdopted(stream: MediaStream): boolean {
    const dead = (this.adoptedStream === stream && this.adoptedAudioDead)
      || stream.getAudioTracks()[0]?.readyState === 'ended';
    if (this.adoptedStream === stream) { this.adoptedStream = null; this.adoptedAudioDead = false; }
    return dead;
  }

  stopAudio() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.workletNode) { this.workletNode.port.postMessage('stop'); this.workletNode.disconnect(); this.workletNode = null; }
    if (this.audioCtx) { this.audioCtx.close().catch(() => {}); this.audioCtx = null; }
    this.fallbackCleanup?.();
    this.fallbackCleanup = null;
    if (this.audioEl) { this.audioEl.pause(); this.audioEl.srcObject = null; this.audioEl = null; }
    if (this.captureStream) { this.captureStream.getTracks().forEach(t => t.stop()); this.captureStream = null; }
  }

  // tab 模式：tabCapture 在 SW 侧签发 streamId，这里消费。system/mic 模式不走此函数。
  async startTabCapture(streamId: string) {
    // 记下 streamId：端口断开重连时随 RECONNECT 上报，bg 据此自愈会话
    this.reconnectStreamId = streamId || null;
    const constraints: any = {
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    };
    // 坑："Error starting tab capture" 常见于上一次捕获刚被销毁就立刻开新流——
    // Chrome 侧旧流的释放是异步的，立即申请会被拒绝。失败后稍等重试一次。
    let stream: MediaStream;
    try {
      stream = await (navigator.mediaDevices.getUserMedia as any)(constraints);
    } catch (e) {
      this.log('tab capture 启动失败，400ms 后重试一次: ' + e);
      await new Promise(r => setTimeout(r, 400));
      stream = await (navigator.mediaDevices.getUserMedia as any)(constraints);
    }
    await this.pipeCaptureStream(stream, 'tab');
  }

  // 系统音频（整机环回）：MV3 的 desktopCapture 两条路都被 Chrome 堵死，唯一可行组合
  // 是在文档内直接 getDisplayMedia——选择器本身即授权，无 OS 级权限弹窗。
  // 只取音频轨返回，不接管道——调用方决定何时开始喂音频。Web 版同样是这条路。
  async acquireSystemAudioStream(): Promise<MediaStream> {
    const media = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    media.getVideoTracks().forEach((t) => t.stop());
    const audio = media.getAudioTracks()[0];
    if (!audio) throw new Error('未获取到系统音频轨道');
    const out = new MediaStream([audio]);
    // 坑：取到流的那一刻就交给引擎看护（见 adoptCaptureStream）。Web 版这条流要跨过
    // 模型加载/建识别器才接线（数秒），这期间音频轨的 ended 事件必须有人接着，否则
    // 事件一丢就是"运行中却永远没声音"，等接线时才挂监听已经晚了。
    this.adoptCaptureStream(out);
    return out;
  }

  // 麦克风：Chrome 禁止扩展 offscreen 文档做 getUserMedia 音频采集，扩展侧由可见页采集后
  // 经 feedMicChunk 送入；Web 版宿主可直接 getUserMedia 后同样走 feedMicChunk。
  feedMicChunk(audio: ArrayBuffer | ArrayBufferView | number[], sampleRate?: number) {
    if (!audio || !this.pipeline) return;
    const buf = Array.isArray(audio)
      ? Float32Array.from(audio as number[])
      : new Float32Array(audio as any);
    if (!buf.length) return;
    this.recordLevel(buf);
    const sr = sampleRate || 16000;
    this.pipeline.feedAudio(sr === 16000 ? buf : resample(buf, sr, 16000));
  }

  async pipeCaptureStream(stream: MediaStream, source: EngineSource) {
    // 坑：同一条流被重复投递时直接早退。否则下面的 stopAudio() 会把"上一份采集"——也就是
    // 它自己的轨道——主动 stop 掉（主动 stop 不触发 ended，全程没有任何报错），随后又照常
    // 建 worklet，留下"运行中却永远没声音"的幽灵会话。adoptCaptureStream 开头有同样的守卫。
    if (this.captureStream === stream) return;
    // 先认领提前看护（见 adoptCaptureStream）：从"取到流"到"接上管道"之间隔着读会话配置、
    // 建识别器（实测数秒）等步骤，音频轨可能早就结束了；不核对就会挂成一场没有声音的
    // 幽灵会话（界面运行中、永远不出字幕）。
    const audioDeadBeforePipe = this.consumeAdopted(stream);
    // 坑：换流前必须先释放上一份采集。INIT 有两条投递路径（bg 的 checkPendingInit 与直投），
    // 同一次启动可能触发两次，两条 async 链会各自走到这里 —— 不先停机就会出现两个
    // AudioContext 并存：旧的从不 close（Chrome 单文档 AudioContext 有数量上限），
    // 旧 worklet 的缓冲只进不出，约 192KB/s 无上限增长，长会话必 OOM。
    this.stopAudio();
    this.captureStream = stream;
    this.captureSource = source;
    // 坑：此前完全没有 track ended 检测。system 模式用户点"停止共享"、被捕获标签页被关闭、
    // 音频设备拔出时，MediaStreamAudioSourceNode 只会输出静音 —— worklet 照常送全零帧，
    // pipeline 保持 Running，界面"正常"但永远不会再出字幕，且没有任何错误提示。
    // 现在统一由 watchCaptureTracks 挂监听（与 adoptCaptureStream 共用、幂等），并把
    // "音频轨丢失"与"画面轨/来源被关"分成两条文案上报。
    this.watchCaptureTracks(stream);
    // 坑：监听挂得再早也救不回"事件已经发过"的情况（ended 只发一次）。接线前就已经死掉的
    // 流必须在这里就地判掉：否则 worklet 会开出一条只送全零帧的采集，界面停在"识别中"、
    // 一个字都不出，用户只能靠刷新页面自救 —— 这正是"系统音频启动有概率静默失败"。
    // 判掉时给的是"轨道中断"的文案（而不是旧的"停止共享/标签页被关闭"），并把用户能做的
    // 下一步（重新点开始，此时模型已常驻预热，重开很快）说清楚。
    if (audioDeadBeforePipe) {
      this.reportSourceEnded(stream, 'sourceAudioTrackLost', '音频轨在接入管道前已结束（浏览器/音频设备层面的中断），不再挂一场没有声音的会话');
      this.sink.requestStop();
      return;
    }
    // 坑：tab 模式必须建 <audio> 回放——被捕获标签页的声音经捕获流转发，不回放就是静音；
    // system 模式是系统环回（loopback），原声照常出扬声器，回放反而造成回声，绝不能开；
    // mic 模式同理——回放麦克风=外放回声啸叫，也绝不能开。
    if (source === 'tab') {
      this.audioEl = document.createElement('audio');
      this.audioEl.srcObject = stream;
      this.audioEl.play().catch(() => {});
    }

    if ((self as any).AudioWorklet) {
      try {
        await this.startWorkletCapture(stream);
        return;
      } catch (e) {
        this.log('AudioWorklet 启动失败，降级: ' + e);
      }
    }
    this.startFallbackCapture(stream);
  }

  private async startWorkletCapture(stream: MediaStream) {
    // ponytail: AudioWorklet 在独立音频线程持续读帧，主线程标点阻塞时照常缓冲
    const ctx = new AudioContext();
    this.audioCtx = ctx;
    const source = ctx.createMediaStreamSource(stream);
    await ctx.audioWorklet.addModule(this.resolveUrl('audio-worklet-processor.js'));
    // 坑：await 之后必须核对 audioCtx 是否仍是自己。await 期间可能已有更新的一次初始化
    // 接管；继续往下就会在"已不是当前"的 ctx 上建节点，而旧 ctx 无人 close。
    if (this.audioCtx !== ctx) { ctx.close().catch(() => {}); return; }

    const node = new AudioWorkletNode(ctx, 'audio-buffer', {
      processorOptions: { pushMs: this.pushMs },
    });
    this.workletNode = node;
    source.connect(node);
    // 坑：AudioWorkletNode 在"只有上游连接、自身不接下游"时 process() 是否仍被渲染图拉取，
    // 依赖实现与版本细节。用 gain=0 桥接到 destination：链路保持活跃且完全静音。
    const muteGain = ctx.createGain();
    muteGain.gain.value = 0;
    node.connect(muteGain);
    muteGain.connect(ctx.destination);

    // 坑：文档冷启动时可能没有用户激活，AudioContext 会以 suspended 启动；此时渲染图不推进、
    // worklet 永不回包 —— "无音频、无字幕、无报错，界面停在运行中"。运行中被系统挂起
    // （休眠、音频设备切换）是同一类故障，所以 statechange 一并监听。
    let everRunning = false;
    ctx.onstatechange = () => {
      if (this.audioCtx !== ctx) return;
      this.log('AudioContext 状态: ' + ctx.state);
      if (ctx.state === 'running') { everRunning = true; return; }
      if (everRunning) {
        everRunning = false;
        this.sink.toPanel({ type: 'ERROR', message: `音频输出被系统挂起（${ctx.state}），识别已停止` });
      }
    };
    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch (e) { this.log('AudioContext resume 失败: ' + e); }
    }
    if (this.audioCtx !== ctx) { ctx.close().catch(() => {}); return; }
    if (ctx.state !== 'running') {
      this.log('AudioContext 未能进入 running: ' + ctx.state);
      this.sink.toPanel({ type: 'ERROR', message: `音频输出未启动（AudioContext ${ctx.state}），请重新开始识别` });
      return;
    }

    node.port.onmessage = (e: MessageEvent) => {
      // 坑：旧采集链的迟到回包必须丢弃，否则被接管后旧 worklet 仍会把音频喂给当前
      // pipeline（两份音频交错），表现为识别结果抖动/串音。
      if (this.audioCtx !== ctx) return;
      if (e.data && e.data.audio) {
        const buf = new Float32Array(e.data.audio);
        if (buf.length > 0) {
          this.recordLevel(buf);
          // 坑：采样率取本地 ctx 而不是类字段!——后者在停机/接管后为 null，
          // 会在迟到回包里抛未捕获 TypeError。
          const sr = e.data.sampleRate || ctx.sampleRate;
          const t0 = performance.now();
          this.pipeline?.feedAudio(sr === 16000 ? buf : resample(buf, sr, 16000));
          // 口径随出块模式切换（见 scheduleFlush 的注释）：
          //   pull：回包由我们发的 flush 触发，RTT 有意义（t0 - lastFlushSentAt）。
          //   push：回包由音频线程自己发出，与任何一次 flush 都没有因果关系，
          //         那个差值只会是"距上次 flush 的陈旧时间"，数值系统性失真——
          //         所以 push 下只统计本块的同步处理耗时。
          const rtt = this.pushMs > 0 || this.lastFlushSentAt <= 0
            ? 0
            : Math.max(0, t0 - this.lastFlushSentAt);
          this.recordLatency(rtt, performance.now() - t0);
        }
      }
    };

    // 只在 pull 模式下跑 flush 定时器链。push 模式下 worklet 自己出块，这条链纯属多余，
    // 而且它写下的 lastFlushSentAt 会让延迟指示显示出虚假的 RTT（见上面的口径说明）。
    if (this.pushMs > 0) return;

    const scheduleFlush = () => {
      this.flushTimer = setTimeout(() => {
        // 坑：本定时器链必须能自杀。stopAudio() 会 clearTimeout 停掉当前链，但若期间已有
        // 更新的一次初始化接管（audioCtx 换人），这条旧链会被自己重新续上，导致两个 60ms
        // 循环向同一节点重复发 flush（音频被切成碎片块）。每轮先核对代次再续。
        if (this.audioCtx !== ctx) return;
        this.lastFlushSentAt = performance.now();
        node.port.postMessage('flush');
        scheduleFlush();
      }, 60);
    };
    scheduleFlush();
  }

  private startFallbackCapture(stream: MediaStream) {
    // 坑（同 mic-capture 的去 16k 改动）：不能强制 `new AudioContext({ sampleRate: 16000 })`。
    // Firefox 在 createMediaStreamSource 发现上下文采样率与轨道原生采样率不一致时直接抛
    // NotSupportedError（"Connecting AudioNodes from AudioContexts with different sample-rate
    // is currently not supported."），系统音频一旦降级到这条路径就必挂；Chrome 只告警，
    // 但源节点是否真的重采样没有保证（静默无声）。下面本来就按 ctx.sampleRate 重采样到 16k。
    const ctx = new AudioContext();
    this.audioCtx = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(16384, 1, 1);
    node.onaudioprocess = (e) => {
      const buf = new Float32Array(e.inputBuffer.getChannelData(0));
      this.recordLevel(buf);
      const t0 = performance.now();
      this.pipeline?.feedAudio(ctx.sampleRate === 16000 ? buf : resample(buf, ctx.sampleRate, 16000));
      this.recordLatency(0, performance.now() - t0);
    };
    source.connect(node);
    // 坑：ScriptProcessorNode 只有被下游拉取时才会驱动；但绝不能直连 destination——
    // 宿主页/回放端已在播放该流，直连会造成声音双重播放。经 gain=0 桥接：活跃且静音。
    const muteGain = ctx.createGain();
    muteGain.gain.value = 0;
    node.connect(muteGain);
    muteGain.connect(ctx.destination);
    ctx.resume().catch(() => {});
    this.fallbackCleanup = () => {
      node.disconnect();
      muteGain.disconnect();
      source.disconnect();
      ctx.close().catch(() => {});
    };
  }

  // ================= 消息 / wasm =================

  // 状态文案（"正在加载模型" / "正在等待音频" / "请选择要共享的屏幕"）走**独立通道**，
  // 不借用 TEXT_CHANGED。各音源的真实阶段顺序并不统一（tab：先加载模型后取权限；
  // system：先取权限后加载模型），所以由每个分支在自己的真实转换点调用。
  // key 为空表示清除状态文案。
  private sendStatus(key: string) {
    const payload = { type: 'STATUS_TEXT', key };
    this.sink.toDisplay(payload);
    this.sink.toPanel(payload);
  }

  private createRecognizer(msg: InitOptions) {
    const r1 = msg.endpointRule1 ?? 0.8;
    const r2 = msg.endpointRule2 ?? 0.6;
    const r3 = msg.endpointRule3 ?? 15;
    const recCfg: any = {
      rule1MinTrailingSilence: r1,
      rule2MinTrailingSilence: r2,
      rule3MinUtteranceLength: Math.round(r3),
    };
    // 热词：仅当非空才切 modified_beam_search 并烘焙 hotwordsBuf（wasm 一次性嵌入配置，
    // 无 per-stream 热更新；空列表完全不改默认 greedy 行为）。
    // 坑：: # @ 是 sherpa 热词保留语法前缀，@ 会 std::stof 抛异常导致 recognizer 创建崩溃
    // （C++ std::invalid_argument 以裸指针形式透出），这里直接丢弃这类 token。
    if (Array.isArray(msg.hotwords) && msg.hotwords.length) {
      const buf = msg.hotwords
        .filter((w) => !!w.trim() && !/^[:#@]/.test(w.trim()))
        .map((w) => w.trim())
        .join(' ');
      if (buf) {
        recCfg.decodingMethod = 'modified_beam_search';
        recCfg.hotwordsBuf = buf;
        recCfg.hotwordsBufSize = new TextEncoder().encode(buf).length;
        recCfg.hotwordsScore = 1.5;
      }
    }
    // 坑：模型是逐字词表（cjkchar），英文整词查不到 ID 时 wasm 会为每个失败词刷屏打日志
    // （"Cannot find ID for token"）——大表里几个英文词就能灌爆 console 卡死页面。
    const origErr = console.error;
    const origLog = console.log;
    const swallow = (...a: unknown[]) => {
      const s = String(a[0] ?? '');
      if (s.includes('Cannot find ID for token') || s.includes('Failed to encode some hotwords')) return;
      origErr(...a);
    };
    console.error = swallow as typeof console.error;
    console.log = swallow as typeof console.log;
    try {
      (window as any).__recognizer = createOnlineRecognizer((window as any).Module, recCfg);
    } finally {
      console.error = origErr;
      console.log = origLog;
    }
  }

  // 脚本注入只做一次（INIT 重启不重复注入，WASM 无法二次加载模型）。
  // 坑：失败必须复位实例字段，否则会永久缓存一个 rejected promise——纯 Web 版首次点
  // 「开始」时模型还没装（注入被门卫拦下），用户按引导导入模型后再点开始时，
  // ensureScripts 会直接返回那个旧的 rejected promise，永远加载不起来。
  // 模块级 wasmScriptsReady 同样会复位（见 injectWasmScripts），两处都要清。
  private ensureScripts(): Promise<void> {
    if (!this.scriptsReady) {
      this.scriptsReady = injectWasmScripts(this.resolveUrl).catch((e) => {
        this.scriptsReady = null;
        throw e;
      });
    }
    return this.scriptsReady;
  }

  // 坑：preload.js 只在 onRuntimeInitialized 成功时置 __wasmReady，失败时没有任何信号，
  // 所以这里只能靠超时兜底。超时即认定 WASM 初始化失败，抛错走 INIT 的异常通道；
  // 否则轮询永不退出，会话永远停在"等待识别"且无任何错误上报。
  private async waitForWasm(): Promise<void> {
    await this.ensureScripts();
    if ((window as any).__wasmReady) return;
    this.log('等待 WASM 加载...');
    const deadline = Date.now() + 30_000;
    while (!(window as any).__wasmReady) {
      if (Date.now() > deadline) {
        throw new Error('WASM 初始化超时（30s），模型可能加载失败');
      }
      await new Promise(r => setTimeout(r, 200));
    }
    this.log('WASM 已就绪');
  }

  // 坑：该 wasm 构建没编 getExceptionMessage，C++ throw 会变成 emscripten 抛出的裸指针
  // （__cxa_exception 对象地址，就是个数字）。按 libc++/emscripten 布局手动解码：
  //   excPtr 指向异常对象的开头；-20 处是 typeinfo*；对象体是 { vptr, std::string }，
  //   with 字段是 libc++ long-mode std::string（首 4 字节即字符串堆指针）。
  async describeWasmException(e: any): Promise<string> {
    if (typeof e !== 'number') return String(e?.message || e);
    try {
      const M = (window as any).Module;
      const read32 = (p: number) => M.HEAPU32[p >> 2];
      const typeinfo = read32(e - 20);
      const type = typeinfo ? M.UTF8ToString(read32(typeinfo + 4)) : '(no typeinfo)';
      let msg = '';
      for (const off of [4, 8, 12, 16]) {
        const w = read32(e + off);
        if (w > 0 && w < M.HEAPU8.length) {
          const s = M.UTF8ToString(w);
          if (s) { msg = s; break; }
        }
      }
      if (!msg) {
        const b: number[] = [];
        let i = 0;
        while (i < 128) {
          const c = M.HEAPU8[e + 4 + i];
          if (!c) break;
          b.push(c); i++;
        }
        msg = String.fromCharCode(...b);
      }
      return `WASM C++ 异常: ${type} | ${msg || '(无消息)'}`;
    } catch (err) {
      return `WASM 异常指针 ${e}（解码失败: ${err}）`;
    }
  }
}

// ================= 宿主无关的纯函数 =================

// —— wasm 脚本注入：**文档级一次性** ——
// 坑：必须放在模块作用域而不是实例字段里。注入状态若挂在实例上，出现第二个实例
// （未来的重连/多会话策略）就会把 sherpa-onnx-wasm-main-asr.js 再求值一遍——
// 那个加载器用 `var Module = typeof Module != "undefined" ? Module : {}` 复用已有
// Module，二次求值会重新注册运行时、撞上"模型二次加载导致 WASM 堆崩溃"。
// 如今扩展 offscreen 与 Web 面板页都持有模块级单例引擎，这条防线是按最坏情况设防的。
let wasmScriptsReady: Promise<void> | null = null;

// 当前 window.__recognizer 是按哪套配置（端点阈值 + 热词）建出来的。null = 尚未建过。
// 配置在 createOnlineRecognizer 时一次性烘焙，配置变了必须 free 重建（见 init 里的比对）；
// 没有它的话，Web 版页面常驻时第二场会话起改阈值/热词永不生效。
let recognizerCfgKey: string | null = null;

function injectWasmScripts(resolveUrl: (p: string) => string): Promise<void> {
  if (wasmScriptsReady) return wasmScriptsReady;
  wasmScriptsReady = (async () => {
    // 坑：wasm 目录基址必须在 preload.js **求值前**挂好。preload.js 的 locateFile
    // 依赖它拼 .wasm/.data 的 URL；抽成宿主无关后由这里显式提供
    // （扩展=chrome-extension://…/wasm/，Web=同目录绝对 URL）。
    (window as any).__easysubWasmBase = resolveUrl('wasm/');
    let imported = false;
    try {
      const blob = await getModelFile(ASR_DB_KEY);
      if (blob && blob.size > 0) {
        (window as any).__asrDataUrl = URL.createObjectURL(blob);
        imported = true;
      }
    } catch { /* IndexedDB 不可用：按"没有导入过"处理，下面还有包内探测兜底 */ }

    // 门卫（纯 Web 版必需）：既没有包内 .data、也没有用户导入的模型时**不要注入 wasm 脚本**。
    // 坑：这个 wasm 是 pthreads 构建，main loader 一求值就会 new WebAssembly.Memory({shared:true})
    // 并拉起 4 个 em-pthread worker；模型缺失时它先 fetch 一个 404 的 .data，再在
    // worker 池初始化上抛 DataCloneError（要 crossOriginIsolated）——运行时会落在半初始化
    // 状态，用户随后即使导入模型也难恢复。宁可不加载，直接抛一条宿主能识别的错误，
    // 由面板弹"下载/导入模型"引导（扩展 full/lite 版包内自带，走不到这里）。
    // 坑：必须用三态探测，只有明确 absent 才算缺模型；unknown 一律照旧注入，
    // 让加载器去给出真实错误。三态只在 Web 托管场景生效——扩展侧 probeBundledResource
    // 保持 master 的布尔语义（chrome-extension:// 取不存在的资源是 fetch 抛错而非 404），
    // 所以 full/lite 版恒为 present，nomodel 版缺模型时在这里干净地抛 ERR_MODEL_MISSING
    // （由宿主弹下载/导入引导），不会像旧实现那样先起 pthread 运行时再炸在半路。
    if (!imported && (await probeBundledResource(ASR_DATA_PATH)) === 'absent') {
      throw new Error(ERR_MODEL_MISSING);
    }
    // preload.js 只在宿主没自带时注入（扩展的 offscreen.html 静态加载了它，
    // 重复注入会把已初始化的 Module 整个换掉）
    const inject = (src: string) => new Promise<void>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = resolveUrl(src);
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`加载 ${src} 失败`));
      document.body.appendChild(el);
    });
    if (typeof (window as any).Module === 'undefined') await inject('wasm/preload.js');
    for (const src of WASM_SCRIPTS) await inject(src);
  })().catch((e) => {
    // 注入失败必须允许重试（网络/路径问题修好后重开会话应能恢复），
    // 否则一次失败会被永久记忆化，用户只能刷新页面。
    wasmScriptsReady = null;
    throw e;
  });
  return wasmScriptsReady;
}


interface TransJob {
  kind: 'final' | 'stream' | 'backlog';
  seq: number;
  text: string;
  at: number;
}

export interface TranslateTestResult {
  ok: boolean;
  text?: string;
  error?: string;
  debug?: any;
}

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

// 坑：ASR 输出全大写，标点模型对英文句也常给中文全角标点——这种"全大写+中文标点"
// 形态远超出翻译模型的训练分布，质量掉得厉害。翻译前规范化：全角标点→半角，英文
// 按句转"句首大写其余小写"（中文句子无大小写概念，原样放行）。
// 句子边界：半角/全角句号问号叹号后跟空白（标点归属前一句，保留原样不断章取义）
export function sentenceCase(text: string): string {
  return text.split(/(?<=[.!?。！？])\s+/).map((sentence) => {
    if (CJK_RE.test(sentence)) return sentence;
    const mi = sentence.search(/[A-Za-z]/);
    if (mi === -1) return sentence;
    const head = sentence.slice(0, mi);
    const rest = sentence.slice(mi);
    return head + rest.charAt(0).toUpperCase() + rest.slice(1).toLowerCase().replace(/(^|\s)i(\s|$)/g, '$1I$2');
  }).join(' ');
}

// 显示用：只去全大写，保留标点模型打的中文标点断句
export function displayCase(text: string): string {
  return sentenceCase(text);
}

export function normalizeForTranslate(text: string): string {
  const full = /[\uFF0C\u3002\uFF1F\uFF01\uFF1B\uFF1A\u201C\u201D\u2018\u2019\uFF08\uFF09\u3010\u3011]/;
  const half = {
    '\uFF0C': ',', '\u3002': '.', '\uFF1F': '?', '\uFF01': '!', '\uFF1B': ';', '\uFF1A': ':',
    '\u201C': '"', '\u201D': '"', '\u2018': "'", '\u2019': "'", '\uFF08': '(', '\uFF09': ')',
    '\u3010': '[', '\u3011': ']',
  } as Record<string, string>;
  const t = text.replace(full, (ch) => half[ch] ?? ch);
  return sentenceCase(t);
}
