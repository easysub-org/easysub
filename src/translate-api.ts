// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
/**
 * OpenAI 兼容 API 的翻译后端（纯函数，便于单测；实际 fetch 在 translation-worker 里）。
 *
 * 为什么要单独一个模块：翻译有两条来源（内置离线模型 / 用户自己的 OpenAI 兼容 API），
 * 二者必须**共用同一条调度与显示链路**（队列、跟句重译、定稿、seq/epoch 对账、延迟显示）。
 * 所以这里只做"把一次翻译变成一次 HTTP 请求、再把响应变回一段译文"，
 * 调度一律不动。
 *
 * 用户可控性（按用户要求）：可以自己补 Headers 与请求体字段，**同名覆盖**默认值。
 * 格式是一行一条 `key: value`：
 *   x: false          → 布尔
 *   y: 123            → 数字
 *   top_p: 0.9        → 数字
 *   response_format: {"type":"json_object"}   → 对象（值按 JSON 解析，解析不了就当字符串）
 * 两条护栏（会写进 UI 文案）：
 *   · `messages` 不允许覆盖 —— 那是本轮要翻译的正文；
 *   · `stream` 固定 false —— 本页按非流式 JSON 解析，开了 stream 反而收不到译文。
 */

export interface ApiConfig {
  /** 用户填的地址：`host:port`、`…/v1`、完整 `…/v1/chat/completions` 都接受。 */
  base: string;
  model: string;
  /** 可空：本地模型通常不需要。 */
  key: string;
  /** 附加 Headers（多行 `key: value`），同名覆盖默认头。 */
  headersText: string;
  /** 附加请求体字段（多行 `key: value`），同名覆盖默认字段。 */
  bodyText: string;
  /**
   * 推理控制（`reasoning_effort` 的值，例如 none / low / medium / high）。
   * **默认空 = 完全不注入这个字段**——很多模型/网关不认识它，注入了会直接报 400。
   * 填了就注入 `"reasoning_effort": <填的值>`；想控制别的键请用上面的附加请求体字段。
   */
  reasoning: string;
}

/** 两个宿主（扩展 background / Web 宿主）与面板共用的配置对象。 */
export interface TranslateApiSettings extends ApiConfig {
  source: 'builtin' | 'api';
}

/** 从面板偏好里取出翻译来源与 API 配置（三个调用点必须用同一份，别各写一遍）。 */
export function apiSettingsFromPrefs(prefs: any): TranslateApiSettings {
  const p = prefs || {};
  const base = String(p.translateApiBase ?? '').trim() || DEFAULT_API_BASE;
  return {
    source: p.translateSource === 'api' ? 'api' : 'builtin',
    base,
    model: String(p.translateApiModel ?? '').trim(),
    key: String(p.translateApiKey ?? '').trim(),
    headersText: String(p.translateApiHeaders ?? ''),
    bodyText: String(p.translateApiBody ?? ''),
    reasoning: String(p.translateApiReasoning ?? '').trim(),
  };
}

/** 默认地址：Ollama 的 OpenAI 兼容入口（用户指定用它做默认值）。 */
export const DEFAULT_API_BASE = 'http://127.0.0.1:11434/v1';

/** 单次请求的超时（毫秒）。调度不改，但新来源必须自己"有界"：慢模型不能把整条队列堵死。 */
export const API_TIMEOUT_MS = 15000;

/** 非流式解析下不允许用户覆盖的请求体字段（见文件头说明）。 */
export const LOCKED_BODY_KEYS = ['messages', 'stream'];

/** 把用户填的地址归一化成 chat/completions 的完整 URL。 */
export function normalizeChatUrl(base: string): string {
  const raw = String(base || '').trim();
  if (!raw) throw new Error('API 地址为空');
  // 允许用户直接粘完整端点；也允许只填 host:port
  let url = raw.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(url)) return url;
  if (/\/completions$/i.test(url)) return url.replace(/\/completions$/i, '/chat/completions');
  if (!/\/v\d+$/i.test(url)) url += '/v1';
  return url + '/chat/completions';
}

export interface ParsedLines {
  values: Record<string, any>;
  /** 解析不了的行（原样回报给用户，别静默丢掉）。 */
  problems: string[];
}

function looksLikeJson(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  return /^(".*"|\[.*\]|\{.*\}|true$|false$|null$|-?\d+(\.\d+)?([eE][-+]?\d+)?)$/s.test(v);
}

/**
 * 解析 `key: value` 多行文本。
 * 值优先按 JSON 解析（`false`/`123`/`{"a":1}`），否则当字符串；
 * 值为空则当空字符串（例如某些服务要 `x-empty:`）。
 */
export function parseKeyValueLines(text: string): ParsedLines {
  const values: Record<string, any> = {};
  const problems: string[] = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const at = line.indexOf(':');
    if (at <= 0) {
      problems.push(rawLine);
      continue;
    }
    const key = line.slice(0, at).trim();
    const rest = line.slice(at + 1).trim();
    if (!key) {
      problems.push(rawLine);
      continue;
    }
    if (!rest) {
      values[key] = '';
      continue;
    }
    if (looksLikeJson(rest)) {
      try {
        values[key] = JSON.parse(rest);
        continue;
      } catch {
        /* 落到字符串分支 */
      }
    }
    values[key] = rest;
  }
  return { values, problems };
}

/** Headers：值一律是字符串（HTTP 头不允许布尔/数字类型）。 */
export function parseHeaders(text: string): { headers: Record<string, string>; problems: string[] } {
  const { values, problems } = parseKeyValueLines(text);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    headers[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return { headers, problems };
}

/** 翻译指令：目标语言由 direction + 文本自身判定（与内置模型同口径）。 */
export function isCJK(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(String(text || ''));
}

export function targetLangFor(direction: 'auto' | 'zh-en' | 'en-zh', text: string): 'zh' | 'en' {
  if (direction === 'zh-en') return 'en';
  if (direction === 'en-zh') return 'zh';
  return isCJK(text) ? 'en' : 'zh';
}

/**
 * 系统指令：只输出译文本身。
 * 必须强调"原文是识别结果、可能有错"——用户明确要求：识别文本会有错别字/同音字/缺标点，
 * 模型要按**意思**翻，不要把识别错误照字面翻出来、也不要对错误本身做评论。
 */
export function buildSystemPrompt(direction: 'auto' | 'zh-en' | 'en-zh', text: string): string {
  const target = targetLangFor(direction, text);
  const name = target === 'zh' ? 'Simplified Chinese' : 'English';
  return [
    `You are a translation engine. Translate the user's text into ${name}.`,
    'Output ONLY the translation: no explanations, no quotes, no notes, no extra punctuation.',
    'IMPORTANT: the text comes from live speech recognition and often contains typos, homophones,',
    'misheard words, missing punctuation or broken grammar. Infer what the speaker most likely meant',
    'and translate that meaning naturally - do NOT translate obvious recognition errors literally,',
    'do NOT comment on them, and do NOT "fix" the sentence into a different topic.',
    'Keep numbers, names, units and technical terms accurate. Do not add or omit information.',
    'If the text is already in the target language, return it unchanged.',
  ].join(' ');
}

/** 从用户填的地址算出 DNR urlFilter 用的 origin 匹配串（`https://host:port/*`）。 */
export function originPatternFor(base: string): string | null {
  try {
    const url = new URL(normalizeChatUrl(base));
    if (!/^https?:$/.test(url.protocol)) return null;
    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

export interface ApiRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
  /** 被护栏拦下的用户字段（回报给用户，不静默忽略）。 */
  ignored: string[];
}

/** 组装一次请求：默认值 → 用户附加字段覆盖 → 核心字段（messages/stream）固定。 */
export function buildApiRequest(cfg: ApiConfig, text: string,
                                direction: 'auto' | 'zh-en' | 'en-zh',
                                maxTokens = 128): ApiRequest {
  const url = normalizeChatUrl(cfg.base);
  const model = String(cfg.model || '').trim();
  if (!model) throw new Error('模型名为空');

  const { headers: extraHeaders, problems: headerProblems } = parseHeaders(cfg.headersText);
  const { values: extraBody, problems: bodyProblems } = parseKeyValueLines(cfg.bodyText);
  if (headerProblems.length || bodyProblems.length) {
    const bad = [...headerProblems, ...bodyProblems].join(' / ');
    throw new Error(`附加字段格式不对（应为「key: value」）：${bad}`);
  }

  const ignored = Object.keys(extraBody).filter((k) => LOCKED_BODY_KEYS.includes(k));
  const reasoning = String(cfg.reasoning || '').trim();
  const body: Record<string, any> = {
    model,
    temperature: 0,
    max_tokens: Math.max(1, Number(maxTokens) || 128),
    // 推理控制：**空就不注入**（不认识该字段的服务会 400）；填了才注入。
    // 放在附加字段之前 = 它只是"默认值"，用户仍可在附加字段里写 reasoning_effort 覆盖它，
    // 与"附加字段覆盖默认值"的整体语义保持一致。
    ...(reasoning ? { reasoning_effort: reasoning } : {}),
    ...extraBody,                        // 用户字段**覆盖**上面的默认值
  };
  // 护栏：正文与解析方式固定，用户即使写了也不生效（但会在 ignored 里告诉他）
  delete body.messages;
  delete body.stream;
  body.messages = [
    { role: 'system', content: buildSystemPrompt(direction, text) },
    { role: 'user', content: String(text ?? '') },
  ];
  body.stream = false;

  const headers: Record<string, string> = {
    ...(cfg.key ? { Authorization: `Bearer ${String(cfg.key).trim()}` } : {}),
    ...extraHeaders,                     // 用户头**覆盖**默认头（例如 Azure 用 api-key、或自定义网关）
  };
  // —— Content-Type 的取值直接决定"会不会发 CORS 预检" ——
  // 坑（用户实测：Chrome 下 Web 版报 `Failed to fetch`，DevTools 里是 OPTIONS → 405）：
  // 本地服务（Ollama 实测）**不处理 OPTIONS**，而 `Content-Type: application/json` **不在
  // CORS 安全名单里** → 浏览器必发预检 → 405 → 真正的 POST 都发不出去。
  // 只要请求是"简单请求"就**不发预检**：Content-Type 用安全值 text/plain（服务端按 handler
  // 绑定 JSON，不依赖这个头；Ollama / LM Studio / llama.cpp 都如此）。
  // 若用户提供了非安全头（Authorization / 自定义头），预检无法避免 —— 那时只能靠扩展版
  // （host_permissions 绕过 CORS）或助手转发。
  const CORS_SAFELISTED = new Set(['accept', 'accept-language', 'content-language']);
  const extraNames = Object.keys(extraHeaders).map((k) => k.toLowerCase());
  const needsPreflight = !!String(cfg.key || '').trim()
    || extraNames.some((k) => k !== 'content-type' && !CORS_SAFELISTED.has(k));
  const contentType = needsPreflight ? 'application/json' : 'text/plain;charset=UTF-8';
  // 用户显式写了 Content-Type 就尊重用户（覆盖语义），否则用我们算出来的那个
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = contentType;
  }
  return { url, headers, body, ignored };
}

/** 从 OpenAI 兼容响应里取译文；取不到返回 null（由调用方报可读错误）。 */
export function extractTranslation(payload: any): string | null {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? null;
  if (typeof content !== 'string') return null;
  const text = content.trim();
  return text || null;
}

/** 把 HTTP/网络失败整理成人看得懂的一句话（含常见原因与本地服务提示）。 */
export function describeApiError(status: number | null, detail: string): string {
  if (status === 401 || status === 403) return `认证失败（HTTP ${status}）：检查 API Key / 附加 Headers${detail ? ' — ' + detail : ''}`;
  if (status === 404) return `地址或模型不存在（HTTP 404）：检查 API 地址是否以 /v1 结尾、模型名是否正确${detail ? ' — ' + detail : ''}`;
  if (status === 429) return `被限流（HTTP 429）：稍后再试或换更小的模型${detail ? ' — ' + detail : ''}`;
  if (status != null && status >= 500) return `服务端错误（HTTP ${status}）${detail ? '：' + detail : ''}`;
  if (status != null) return `请求失败（HTTP ${status}）${detail ? '：' + detail : ''}`;
  return `连不上（${detail || '网络错误'}）：确认服务在跑、地址/端口对，且服务允许跨源（本地模型需开启 CORS）`;
}
