// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
// 离线翻译 worker：被 offscreen 文档创建，专门跑 transformers.js 推理，
// 把耗时的句级翻译从主线程（音频泵/ASR 所在线程）隔离出去，不阻塞识别。
// 模型文件由用户在面板用 <input type=file> 选目录读入 IndexedDB（见 model-db.ts），
// 这里重写 fetch 把 transformers.js 的本地模型请求映射到 IndexedDB，全程零网络零权限。
import { pipeline, env } from '@huggingface/transformers';
import { getModelFile, listModelKeys } from './model-db';

type Pipe = any;

// 方向 → 模型目录名（与发布到 GitHub Releases 的模型包目录一一对应）
const MODEL_PAIRS: Record<string, string> = {
  'en-zh': 'opus-mt-en-zh',
  'zh-en': 'opus-mt-zh-en',
};

let setupDone = false;
let setupError: string | null = null;
let wasmPaths: string | undefined;

function isCJK(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(text);
}

function modelIdFor(direction: 'auto' | 'zh-en' | 'en-zh', text: string): string {
  const dir = direction === 'auto' ? (isCJK(text) ? 'zh-en' : 'en-zh') : direction;
  return MODEL_PAIRS[dir];
}

// 坑：transformers.js 请求的本地 URL 形如 `tmspeech://opus-mt-en-zh/config.json`，
// 但路径可能带 revision 段（`opus-mt-en-zh/main/config.json`），去掉 revision 再查。
// 兼容旧数据：历史版本可能把 `<选中文件夹>/opus-mt-en-zh/...` 整段存进库，按后缀兜底。
async function resolveFile(key: string): Promise<Blob | null> {
  const exact = await getModelFile(key);
  if (exact) return exact;
  const parts = key.split('/');
  if (parts.length > 2) {
    const short = parts[0] + '/' + parts[parts.length - 1];
    const hit = await getModelFile(short);
    if (hit) return hit;
  }
  const keys = await listModelKeys();
  const suffix = '/' + key;
  for (const k of keys) {
    if (k.endsWith(suffix)) {
      const found = await getModelFile(k);
      if (found) return found;
    }
  }
  return null;
}

function setup() {
  if (setupDone || setupError) return;
  try {
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.useBrowserCache = false;
    env.localModelPath = 'tmspeech://';
    // 只跑 wasm 单线程，避免 onnxruntime-web 起 worker/proxy 撞上 MV3 CSP。
    // 坑：dedicated worker 没有 chrome.* API，wasmPaths 必须由 offscreen（有 chrome）解析后随消息传入。
    const wasmCfg = env.backends.onnx.wasm;
    if (wasmCfg && wasmPaths) {
      wasmCfg.numThreads = 1;
      wasmCfg.proxy = false;
      wasmCfg.wasmPaths = wasmPaths;
    }

    const origFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input?.url ?? '');
      if (url.startsWith('tmspeech://')) {
        const key = url.slice('tmspeech://'.length).replace(/^\/+/, '');
        const t0 = Date.now();
        return resolveFile(key).then(blob => {
          if (!blob) throw new Error('翻译模型文件缺失: ' + key);
          // 诊断：观察加载是否在推进（逐文件打印，可判断"真加载"还是"卡死"）
          console.log('[translation-worker] fetch', key, blob.size, (Date.now() - t0) + 'ms');
          return new Response(blob, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
        });
      }
      return origFetch(input, init);
    };
    setupDone = true;
  } catch (e: any) {
    setupError = e?.message || String(e);
  }
}

// 模型加载结果全部记忆化：成功/失败/缺失都只尝试一次。
// 否则 pipeline() 一旦抛错，每句/每次流式变化都会重试整包加载
// （反复读 50-100MB + wasm 会话初始化，重 CPU），用户配错模型时直接拖垮电脑。
type LoadResult = { pipe?: Pipe; missing?: boolean; error?: string };
const loadCache: Record<string, LoadResult> = {};
let lastNoModelDebug: any = null;

async function getPipeline(modelId: string): Promise<LoadResult> {
  if (loadCache[modelId]) return loadCache[modelId];
  const keys = await listModelKeys();
  if (!keys.some(k => k.includes('opus-mt'))) {
    lastNoModelDebug = { keyCount: keys.length, sample: keys.slice(0, 6) };
    console.log('[translation-worker] no-model', JSON.stringify({ modelId, ...lastNoModelDebug }));
    // 坑：缺模型**不记忆化**。用户在会话中途导入模型是正常操作，记忆化会让同一个
    // worker 永远报 no-model（只能重启会话）。每次重查一遍 IndexedDB 键表只要几毫秒；
    // 真正昂贵的 pipeline 加载成功后仍然记忆化，不受影响。
    return { missing: true };
  }
  const t0 = Date.now();
  try {
    const pipe: Pipe = await pipeline('translation', modelId, { dtype: 'q8' });
    console.log('[translation-worker] pipeline loaded', modelId, (Date.now() - t0) + 'ms');
    return (loadCache[modelId] = { pipe });
  } catch (e: any) {
    console.log('[translation-worker] load-fail', modelId, (Date.now() - t0) + 'ms', e?.message || String(e));
    // 加载失败（文件在但坏了/不兼容）保持记忆化：不记忆化的话每句都会重跑一遍
    // 216MB 的模型加载，直接拖垮机器。修好模型后由 RESET_MODEL_CACHE 解除。
    return (loadCache[modelId] = { error: e?.message || String(e) });
  }
}

async function translate(text: string, direction: 'auto' | 'zh-en' | 'en-zh', maxNewTokens = 128): Promise<string | null> {
  setup();
  if (setupError) throw new Error(setupError);
  const modelId = modelIdFor(direction, text);
  const res = await getPipeline(modelId);
  if (res.missing) return null;
  if (res.error) throw new Error(res.error);
  // num_beams:1 明确走 GreedySampler。transformers.js 的 beam search 并未实现
  // （生成循环每步只取第一个候选，候选间不分支），num_beams>1 不会改变输出，
  // 只会让每步多付一次 topk 计算——保持 1 即可。
  const t0 = Date.now();
  const out = await res.pipe!(text, { num_beams: 1, max_new_tokens: maxNewTokens });
  console.log('[translation-worker] gen done', (Date.now() - t0) + 'ms', 'max_tokens=' + maxNewTokens, JSON.stringify(text).slice(0, 40));
  // 坑：v3 TranslationPipeline 输出字段是 `translation_text`（不是 Text2Text 的 `generated_text`），
  // 之前只读 generated_text 恒为 undefined → 译文恒空 → 被误判成"模型不可用"。
  const first = (Array.isArray(out) ? out[0] : out) as any;
  const result = first?.translation_text ?? first?.generated_text ?? '';
  console.log('[translation-worker] result', JSON.stringify(result).slice(0, 120));
  return result.trim() || null;
}

let msgId = 0;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data || {};
  // 模型（重新）导入后由宿主转发：清掉失败/缺模的加载缓存，让下一句直接用上新模型，
  // 正在运行的会话无需重启。成功的 pipeline 缓存也可安全清除——下次按需重载。
  if (msg.type === 'RESET_MODEL_CACHE') {
    for (const k of Object.keys(loadCache)) delete loadCache[k];
    setupError = null;
    return;
  }
  if (msg.type !== 'TRANSLATE') return;
  if (msg.wasmPaths) wasmPaths = msg.wasmPaths;
  const id = ++msgId;
  const kind = msg.kind === 'final' ? 'final' : 'stream';
  // seq：所属句序号，原样回传让 offscreen/content 按句路由译文显示位置
  const seq = msg.seq;
  // epoch：发出时所属的流式代次，原样回传。offscreen 侧用它判断这份中间态译文
  // 是否已被"定稿/重启"作废（作废的译文继续显示会覆盖刚到的定稿译文）。
  const epoch = msg.epoch;
  // gen：offscreen 会话代次，原样回传供回包对账（挡跨会话撞号回包）。
  const gen = msg.gen;
  (async () => {
    try {
      const text = await translate(String(msg.text ?? ''), msg.direction || 'auto', msg.maxNewTokens ?? 128);
      postMessage({
        type: 'TRANSLATION', id, kind, seq, epoch, gen,
        text, ok: text != null,
        reason: text == null ? 'no-model' : null,
        error: null,
        test: msg.test,
        debug: text == null ? lastNoModelDebug : null,
      });
    } catch (err: any) {
      postMessage({ type: 'TRANSLATION', id, kind, seq, epoch, gen, text: null, ok: false, reason: 'error', error: err?.message || String(err), test: msg.test });
    }
  })();
};
