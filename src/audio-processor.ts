// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
const SAMPLE_RATE = 16000;

export type AudioDataCallback = (samples: Float32Array) => void;

export interface AudioSource {
  start(): Promise<void>;
  stop(): void;
  setCallback(cb: AudioDataCallback): void;
  onStopped?: () => void;
}

function designLowpass(cutoff: number, numTaps: number): Float32Array {
  const taps = new Float32Array(numTaps);
  const half = (numTaps - 1) / 2;
  for (let i = 0; i < numTaps; i++) {
    const n = i - half;
    if (n === 0) taps[i] = 2 * Math.PI * cutoff;
    else taps[i] = Math.sin(2 * Math.PI * cutoff * n) / n;
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (numTaps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (numTaps - 1));
    taps[i] *= w;
  }
  const sum = taps.reduce((a, b) => a + b, 0);
  for (let i = 0; i < numTaps; i++) taps[i] /= sum;
  return taps;
}

// 滤波器系数只由 (srcRate, dstRate) 决定，而整个会话里这对组合固定
// （tab capture 每 60ms 一块），按采样率对缓存，避免每个音频块都重新设计一遍低通。
const lowpassCache = new Map<string, Float32Array>();

export function resample(src: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return src;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(src.length / ratio);
  const out = new Float32Array(outLen);
  const cutoff = 0.45 / ratio;
  const numTaps = Math.min(65, Math.max(9, Math.ceil(ratio * 6) | 1));
  const cacheKey = srcRate + '>' + dstRate;
  let filter = lowpassCache.get(cacheKey);
  if (!filter) {
    filter = designLowpass(cutoff, numTaps);
    lowpassCache.set(cacheKey, filter);
  }
  const half = (numTaps - 1) / 2;
  for (let i = 0; i < outLen; i++) {
    const center = i * ratio;
    let sum = 0;
    for (let j = 0; j < numTaps; j++) {
      const srcIdx = Math.floor(center) + j - half;
      if (srcIdx >= 0 && srcIdx < src.length) sum += src[srcIdx] * filter[j];
    }
    out[i] = sum;
  }
  return out;
}

function processStream(
  stream: MediaStream,
  callback: AudioDataCallback,
  onStopped?: () => void
): { stop: () => void } {
  const track = stream.getAudioTracks()[0];
  let stopped = false;
  let ended = false;
  let reader: ReadableStreamDefaultReader<any> | null = null;

  function onSourceEnd() {
    if (ended) return;
    ended = true;
    onStopped?.();
  }

  let log = (...args: any[]) => console.log('[TM Audio]', ...args);

  track.onended = () => { log('track.onended 触发'); stopped = true; onSourceEnd(); };

  let stop = () => {
    if (ended) return;
    stopped = true;
    reader?.cancel();
    track.stop();
    ended = true;
  };

  log('processStream start, hasMSTP=', 'MediaStreamTrackProcessor' in window, 'track.readyState=', track.readyState, 'track.id=', track.id);

  let retryCount = 0;

  if ('MediaStreamTrackProcessor' in window) {
    startReader();
  } else {
    log('MSTP 不支持，降级到 AudioContext');
    audioContextFallback();
  }

  async function startReader() {
    log('startReader 启动');
    while (!stopped) {
      try {
        retryCount++;
        log('创建 MSTProcessor #', retryCount);
        const processor = new (window as any).MediaStreamTrackProcessor({ track });
        const r = processor.readable.getReader();
        reader = r;
        retryCount = 0;
        await pump(r);
        reader = null;
        if (!stopped) { log('pump 结束(done), 准备重新连接'); await new Promise(r => setTimeout(r, 50)); }
      } catch (e) {
        log('startReader 创建失败:', e);
        if (stopped) { log('startReader: 已停止, 退出'); return; }
        log('500ms 后重试...');
        await new Promise(r => setTimeout(r, 500));
      }
    }
    log('startReader 退出');
  }

  async function pump(r: ReadableStreamDefaultReader<any>) {
    log('pump 开始读取');
    while (!stopped) {
      try {
        const { value, done } = await r.read();
        if (done) { log('pump: 可读流返回 done'); return; }
        const data = value as AudioData;
        const srcRate = data.sampleRate;
        const srcBuf = new Float32Array(data.numberOfFrames);
        data.copyTo(srcBuf, { planeIndex: 0, format: 'f32-planar' });
        data.close();
        const resampled = srcRate === SAMPLE_RATE ? srcBuf : resample(srcBuf, srcRate, SAMPLE_RATE);
        callback(resampled);
      } catch (e) {
        log('pump 错误:', e);
        return;
      }
    }
    log('pump 退出');
  }

  function audioContextFallback() {
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    } catch {
      ctx = new AudioContext();
    }
    const source = ctx.createMediaStreamSource(stream);
    // ponytail: ScriptProcessorNode 已废弃，主线程阻塞时会丢帧
    // 仅在 AudioWorklet 不可用时作为降级（最终会被 Chrome 移除）
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      if (!stopped) callback(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    source.connect(node);
    // offscreen 文档可能无法自动 resume，用 message 驱动
    const tryResume = () => ctx.resume().catch(() => {});
    tryResume();

    const stopFallback = () => {
      if (ended) return;
      stopped = true;
      node.disconnect();
      source.disconnect();
      ctx.close().catch(() => {});
      ended = true;
      track.stop();
    };

    stop = stopFallback;
  }

  return { stop: () => stop() };
}

export class MicrophoneSource implements AudioSource {
  private stream: MediaStream | null = null;
  private cleanup: (() => void) | null = null;
  private callback: AudioDataCallback = () => {};
  onStopped?: () => void;

  setCallback(cb: AudioDataCallback) { this.callback = cb; }

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: { ideal: SAMPLE_RATE }, channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.stream = stream;
    const p = processStream(stream, this.callback, this.onStopped);
    this.cleanup = p.stop;
  }

  stop() {
    this.cleanup?.();
    this.cleanup = null;
    this.stream = null;
  }
}

export class TabCaptureStreamSource implements AudioSource {
  private stream: MediaStream | null = null;
  private cleanup: (() => void) | null = null;
  private callback: AudioDataCallback = () => {};
  private streamId: string;
  onStopped?: () => void;

  constructor(streamId: string) { this.streamId = streamId; }

  setCallback(cb: AudioDataCallback) { this.callback = cb; }

  async start(): Promise<void> {
    const stream: MediaStream = await (navigator.mediaDevices.getUserMedia as any)({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: this.streamId,
        },
      },
    });
    this.stream = stream;

    // Chrome capture tab 时会静音原标签页，需要 playback 恢复听觉
    const el = document.createElement('audio');
    el.srcObject = stream;
    el.play().catch(() => {});

    const p = processStream(stream, this.callback, this.onStopped);
    this.cleanup = () => { el.pause(); el.srcObject = null; p.stop(); };
  }

  stop() {
    this.cleanup?.();
    this.cleanup = null;
    this.stream = null;
  }
}
