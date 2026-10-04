// 麦克风采集（跨宿主共用）：16k 单声道定长出块，交调用方决定怎么送给识别引擎。
//
// 为什么不是识别引擎自己采：
//   - 扩展侧 Chrome 禁止 offscreen 文档做 getUserMedia 音频采集（NotAllowedError），
//     必须由可见页（悬浮字幕窗）采集后经 bg 转发；
//   - Web 侧页面本身就是可见窗口，可直接采。
// 两者"谁来调 getUserMedia"不同，但"怎么采、怎么出块"完全一样，故只抽这一层。
import { resolveUrl } from './platform';
import { tSync } from './i18n';
import { resample } from './audio-processor';

// getUserMedia 失败名 → 用户可读文案（两端共用）。NotAllowedError 之外要特别留意
// NotFoundError：系统里没有可用麦克风（设备未接 / Windows 隐私设置禁用）时 Chrome
// **不弹授权框直接拒**——用户看到的"没弹框就闪退"多半是它。
export function micErrorText(lang: string, name: string, message: string): string {
  if (name === 'NotAllowedError') return tSync(lang, 'micDenied');
  if (name === 'NotFoundError') return tSync(lang, 'micNotFound');
  if (name === 'NotReadableError' || name === 'AbortError') return tSync(lang, 'micNotReadable');
  if (name === 'TrackEnded') return tSync(lang, 'micTrackEnded');
  return `${tSync(lang, 'micFailFallback')}: ${message || ''}`.trim();
}

// 等 AudioContext.resume() 的上限（单次）与总时长：无用户激活时它可能一直挂着
// （既不成功也不失败），无限等待会让 start() 永不返回、宿主一直以为"正在启动采集"。
const CTX_RESUME_WAIT_MS = 1200;
const CTX_RESUME_TOTAL_MS = 4000;

export interface MicCaptureOptions {
  // 每约 60ms 回调一块 16k 单声道 PCM
  onChunk: (samples: Float32Array, sampleRate: number) => void;
  // 采集失败/设备中途断开。name 是 DOMException.name（NotAllowedError / TrackEnded 等）
  onError: (name: string, message: string) => void;
  // 采集方所在的页面可能被隐藏时传 60（毫秒）：改成由 worklet 在音频线程主动出块。
  // 隐藏页面（后台标签页/被盖住的窗口）的 setTimeout 会被 Chrome 节流到分钟级，
  // pull 模式下音频只进不出、识别静默停摆。扩展悬浮窗与 Web 面板页都属于这种，
  // 故两端都传 60；不传则保持"主线程 60ms 主动 flush"的原行为。
  pushMs?: number;
}

export class MicCapture {
  private opts: MicCaptureOptions;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private timer: any = null;
  private active = false;
  // 代次守卫：start() 里有多个 await（getUserMedia / addModule），期间外部可能已 stop()
  // （停止 / 出错收敛 / 用户再点开始）。代次不匹配就放弃装配并释放已到手的资源——否则
  // 麦克风指示灯常亮、旧采集的 onChunk 继续往新会话里喂音频（幽灵采集，双重采集）。
  // 扩展悬浮窗靠"整页销毁"掩盖了这个竞态；Web 面板页是常驻宿主，它真实落地。
  private gen = 0;

  constructor(opts: MicCaptureOptions) {
    this.opts = opts;
  }  get isActive() { return this.active; }

  // 失败上报统一出口：面板侧的模态/状态栏可能被用户错过（popup 随焦点关闭、整页被
  // 浮窗盖住），控制台是排障的可靠出口——错误名（NotAllowedError/NotFoundError…）
  // 直接决定"为什么没弹授权框"，必须留痕。
  private fail(name: string, message: string) {
    console.log('[EasySub] 麦克风采集失败:', name, message);
    this.opts.onError(name, message);
  }

  stop() {
    this.gen++;
    this.release();
  }

  // 释放资源（不动代次）：stop() 与 start() 的中途弃装共用
  private release() {
    this.active = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.node) { try { this.node.port.onmessage = null; this.node.disconnect(); } catch { /* 已断开 */ } this.node = null; }
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
  }

  async start(): Promise<void> {
    // 重复指令（启动直发 + 端口重连补发双入口）幂等跳过：已在采就不重开
    if (this.active) return;
    this.stop();
    const myGen = this.gen;
    const stale = () => myGen !== this.gen;
    // 装配期的资源全部走局部变量，全部就绪后才一次性提交到实例字段。
    // 坑：若边装边写实例字段，两次 start 重叠时，先发起那次在 stale 分支里的清理
    // 会按实例字段误杀新一代已经接管的活采集（麦克风灯灭、识别静默、无报错）。
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let node: AudioWorkletNode | null = null;
    let timer: any = null;
    // 弃装：只释放"本次装配拿到手"的局部资源，绝不碰实例字段
    const abandon = () => {
      if (timer) clearInterval(timer);
      if (node) { try { node.port.onmessage = null; node.disconnect(); } catch { /* 已断开 */ } }
      if (ctx) ctx.close().catch(() => {});
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e: any) {
      if (stale()) return; // 已被外部停止：会话自有收敛路径，不再上报错误
      this.fail(e?.name || '', e?.message || String(e));
      return;
    }
    if (stale()) { abandon(); return; }
    try {
      // 坑：这里**不能**强制 16k（曾经的 `new AudioContext({ sampleRate: 16000 })`）：
      //   - Firefox：`createMediaStreamSource` 在上下文采样率与轨道原生采样率不一致时直接抛
      //     NotSupportedError（"Connecting AudioNodes from AudioContexts with different
      //     sample-rate is currently not supported."）——麦克风模式在 FF 上必挂，
      //     且失败路径是 ERROR → 宿主收敛会话，用户看到的是"点开始就莫名其妙停了"；
      //   - Chrome：不抛，但同样打这条警告，且 16k 与设备原生（多为 48k）不一致时源节点
      //     究竟有没有重采样并无保证（静默出不了声）。
      // 用设备默认采样率最稳：16k 的契约改由**出块口**重采样兑现（见下面 onmessage）。
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      await ctx.audioWorklet.addModule(resolveUrl('audio-worklet-processor.js'));
      if (stale()) { abandon(); return; }
      // pushMs 交给宿主决定（见 MicCaptureOptions.pushMs）：采集端页面在后台时
      // 主线程定时器会被节流，必须由音频线程自己出块。
      node = new AudioWorkletNode(ctx, 'audio-buffer', {
        processorOptions: { pushMs: this.opts.pushMs || 0 },
      });
      src.connect(node);
      node.port.onmessage = (ev: MessageEvent) => {
        if (!ev.data?.audio) return;
        const raw = new Float32Array(ev.data.audio);
        if (!raw.length) return;
        // 本类契约是"16k 单声道出块"（见文件头），但上下文**不再**强制 16k（见上方 AudioContext
        // 的坑），所以在出块口按实际采样率重采样一次，把契约真正落在这一层：
        //   · 扩展侧：PCM 要经 floating → bg → offscreen 三跳，且走 Port 的 JSON 结构化克隆
        //     （Array.from 成普通数组），48k 原样搬会把消息量与序列化开销放大 3 倍；
        //   · Web 侧：反正也要 resample，放在这里不额外增加一次。
        // 下游 feedMicChunk 见到 sampleRate=16000 便不再重复重采样。
        const sr = Number(ev.data.sampleRate) || 16000;
        this.opts.onChunk(sr === 16000 ? raw : resample(raw, sr, 16000), 16000);
      };
      // pull 模式（pushMs=0）才需要主线程定时催 flush；push 模式下音频线程自己出块，
      // 再挂一条定时器只会把同一次 flush 拆成不齐整的小块（两条路各自清一遍缓冲）。
      // 与识别引擎本地采集（asr-engine 的 scheduleFlush）保持同一取舍。
      if (!this.opts.pushMs) {
        timer = setInterval(() => { try { node!.port.postMessage('flush'); } catch { /* 节点已销毁 */ } }, 60);
      }
      if (stale()) { abandon(); return; }
      // 装配完成，一次性提交
      this.stream = stream;
      this.ctx = ctx;
      this.node = node;
      this.timer = timer;
      this.active = true;
      const track = stream.getAudioTracks()[0];
      // 设备中途被拔：轨道 ended 即断粮，必须上报结束会话（无音频的 Running 是幽灵态）
      track?.addEventListener('ended', () => {
        if (!this.active) return;
        this.stop();
        this.fail('TrackEnded', '麦克风设备已断开');
      });
      // 坑：设备在 getUserMedia 与 addModule 之间的 await 里被拔掉时，ended 事件早已
      // 发出、监听器是刚挂上的，永远收不到——会话会停在"采集正常"的假象里，永远没有音频。
      // 提交后补一次状态核对，把这种"装完就已死"的采集如实报成设备断开。
      if (track && track.readyState === 'ended') {
        this.stop();
        this.fail('TrackEnded', '麦克风设备已断开');
        return;
      }
      const actx = ctx;
      let everRunning = false;
      actx.onstatechange = () => {
        if (this.ctx !== actx || !this.active) return;
        if (actx.state === 'running') { everRunning = true; return; }
        // 起步时的那次 suspended（resume 之前）不算故障，见下方状态判定；
        // 跑起来之后再被挂起（休眠/设备切换）才是真故障——没有音频进管道，界面却停在运行中。
        if (everRunning) {
          this.stop();
          this.fail('AudioContextSuspended', `麦克风音频输出已挂起（${actx.state}）`);
        }
      };
      // 上下文可能因自动播放策略以 suspended 启动（页面还没有用户激活，或激活已被权限
      // 弹窗消耗掉）：此时渲染图不推进、worklet 永不回包，表现为"运行中但永远没字幕"。
      // resume 可能既不成功也不失败（浏览器挂着等手势），所以带超时重试几轮，而不是傻等。
      const deadline = Date.now() + CTX_RESUME_TOTAL_MS;
      // 用取值函数读状态：直接读 actx.state 会被 TS 的控制流分析在循环里窄化
      // （进去过一次非 running 分支后，它就把后续的 'running' 比较判成不可能）。
      const ctxState = () => actx.state as string;
      while (ctxState() !== 'running' && Date.now() < deadline) {
        try {
          await Promise.race([actx.resume(), new Promise((r) => setTimeout(r, CTX_RESUME_WAIT_MS))]);
        } catch { /* 被拒：下一轮重试，或最终按状态如实上报 */ }
        if (this.ctx !== actx || !this.active) return; // 期间被 stop
        if (ctxState() === 'running') break;
        await new Promise((r) => setTimeout(r, 200));
        if (this.ctx !== actx || !this.active) return;
      }
      if (ctxState() !== 'running') {
        // 音频上下文起不来 = 渲染图不推进 = 一点音频都收不到。如实上报并收敛，
        // 不要留下"界面在跑、其实没有声音进来"的幽灵会话。
        this.stop();
        this.fail('AudioContextSuspended', `麦克风音频未能启动（AudioContext ${ctxState()}）`);
        return;
      }
      everRunning = true;
    } catch (e: any) {
      abandon();
      if (stale()) return;
      this.fail(e?.name || '', e?.message || String(e));
    }
  }
}
