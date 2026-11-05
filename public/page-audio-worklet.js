// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
//
// 页面媒体采音 worklet（AudioWorklet，跑在**音频线程**）。
//
// 职责只有两件：
//   ① **旁路**：把输入原样送到 output，让用户照常听见声音（我们不改音量、不加延迟）；
//   ② **分帧回传**：把输入按 ≈40–90ms 攒成一帧 Float32 发回主线程，供内容脚本转发给
//      识别引擎（16k 重采样在引擎侧做，见 asr-engine 的 feedPageChunk）。
//
// 为什么放 public/ 而不是走 webpack：AudioWorklet 必须是**经典脚本**（不能 import、
// 不能是 ES module），与 public/audio-worklet-processor.js 同一处理方式；它同时要列在
// manifest 的 web_accessible_resources 里，内容脚本才能用 chrome.runtime.getURL() 加载。
//
// 为什么在音频线程分帧：后台标签页的计时器会被节流（1s 级），而音频线程的 process()
// 仍然按 128 帧稳定回调 —— 这是"切到别的标签页也不断流"的关键（同一手法见
// vantezzen/skip-silence，MIT）。

class PageAudioTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    // 一帧的样本数：48k 下 2048 ≈ 43ms（16k 下 ≈ 128ms 的等价时长，引擎侧会重采样）
    this._target = Math.max(128, opts.frameSamples || 2048);
    this._buf = new Float32Array(this._target);
    this._filled = 0;
    this._sumSq = 0;
    this._count = 0;
    this._stopped = false;
    this.port.onmessage = (e) => {
      if (e && e.data && e.data.type === 'stop') this._stopped = true;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;

    // ① 旁路：保证用户仍能听见声音（只读不改）
    for (let c = 0; c < output.length; c++) {
      const src = input[c] || input[0];
      if (src && output[c]) output[c].set(src);
    }

    if (this._stopped) return true;

    // ② 攒帧 → 回传（附带这一帧的 RMS，供内容脚本判断"是不是被 DRM/跨域静音了"）
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      if (this._filled < this._target) this._buf[this._filled++] = ch[i];
      this._sumSq += ch[i] * ch[i];
      this._count++;
    }
    if (this._filled >= this._target) {
      const rms = Math.sqrt(this._sumSq / Math.max(1, this._count));
      this.port.postMessage({ samples: this._buf.slice(0), rms });
      this._buf = new Float32Array(this._target);
      this._filled = 0;
      this._sumSq = 0;
      this._count = 0;
    }
    return true;
  }
}

registerProcessor('page-audio-tap', PageAudioTap);
