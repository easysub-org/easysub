// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
export enum JobStatus { Stopped, Running }

export interface PipelineEvents {
  onTextChanged: (text: string) => void;
  onSentenceDone: (text: string) => void;
  onStatusChanged: (status: JobStatus) => void;
  onError: (err: Error) => void;
}

let log = (msg: string) => console.log('[TM Pipeline]', msg);

function cleanText(text: string): string {
  return text.replace(/▁/g, ' ').trim();
}

export class Pipeline {
  private status = JobStatus.Stopped;
  private events: PipelineEvents;
  private cancelled = false;
  private stream: any = null;
  private lastText = '';

  constructor(events: PipelineEvents) {
    this.events = events;
  }

  getStatus() { return this.status; }

  async start() {
    if (this.status === JobStatus.Running) return;

    const r = (window as any).__recognizer;
    if (!r || !(window as any).__wasmReady) {
      this.events.onError(new Error('WASM 识别器未就绪'));
      return;
    }

    this.status = JobStatus.Running;
    this.cancelled = false;
    // 坑：createStream 在 WASM 内存紧张/句柄创建失败时可能抛异常或返回无效句柄。
    // 若不加保护：status 已置 Running 但 stream 为 null——start() 因开头幂等短路
    // 永远无法重启，feedAudio 因守卫静默丢弃全部音频，形成无法自恢复的"假 Running"。
    // 修复：失败时回滚 status=Stopped 并向上抛出，由 offscreen 的 async INIT 链路
    // catch 后走 ERROR 通道上报（offscreen.ts 对 pipeline!.start() 已有 try/catch 包裹）；
    // 同时校验返回的流及其内部句柄真值，防止后续 wasm 调用在句柄 0 上直接 abort。
    try {
      this.stream = r.createStream();
    } catch (e) {
      this.status = JobStatus.Stopped;
      this.stream = null;
      throw e instanceof Error ? e : new Error('识别流创建失败: ' + String(e));
    }
    if (!this.stream || !this.stream.handle) {
      this.status = JobStatus.Stopped;
      this.stream = null;
      throw new Error('识别流创建失败：返回无效句柄');
    }
    this.events.onStatusChanged(JobStatus.Running);
    log('识别流已创建');
  }

  stop() {
    this.cancelled = true;
    this.status = JobStatus.Stopped;
    this.stream?.free();
    this.stream = null;
    this.lastText = '';
    this.events.onStatusChanged(JobStatus.Stopped);
    this.events.onTextChanged('');
  }

  feedAudio(samples: Float32Array) {
    if (this.status !== JobStatus.Running || !this.stream) return;

    const r = (window as any).__recognizer;
    if (!r) return;

    this.stream.acceptWaveform(16000, samples);
    // 坑：isReady 可能永不返回 false（极低概率），无迭代限制，阻塞主线程。
    // 加迭代上限兜底：宁可这一帧少解一次，也不能让主线程永久卡在这里
    // （主线程一卡，60ms flush 定时器停摆，AudioWorklet 缓冲只进不出）。
    let guard = 0;
    while (r.isReady(this.stream) && guard++ < 200) {
      r.decode(this.stream);
    }

    const isEndpoint = r.isEndpoint(this.stream);
    const result = r.getResult(this.stream).text;
    const clean = cleanText(result);

    if (clean && clean !== this.lastText) {
      this.lastText = clean;
      // 坑：显示回调必须兜住——它是同步跨进程/跨模块调用链（含 countTransform 等
      // 会在此刻触发的下游逻辑），抛错会跳过下面整段端点判定，本帧字幕丢失。
      try { this.events.onTextChanged(clean); } catch (e) { log('onTextChanged 异常: ' + e); }
    }

    if (isEndpoint && clean) {
      log('句完成: "' + clean + '"');
      // 坑：onSentenceDone 里会同步跑 WASM 标点恢复（addPunct 的异常以裸指针形式抛出）。
      // 若把它放在 r.reset() 之前且不做兜底，一次抛错就会跳过 reset —— 识别流永不重置，
      // 端点反复触发、重复出句、或后续彻底不出句（会话看似 Running 却再也不产字幕）。
      // finally 保证解码器状态无论如何都归零。
      try {
        this.events.onSentenceDone(clean);
      } catch (e) {
        log('onSentenceDone 异常: ' + e);
      } finally {
        r.reset(this.stream);
        this.lastText = '';
      }
    }
  }
}
