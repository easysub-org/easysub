// OpenAI 兼容翻译后端的回归测试（node --test 直跑 src/translate-api.ts）。
//
// 为什么值得单测：这台用户自己的 API 有两种输入（地址 + 附加 Headers/请求体字段），
// 解析错一个字符就是"连不上/401/模型名不存在"这类没法自查的报错；
// 而"同名覆盖"和两条护栏（messages/stream 不许覆盖）是明确的产品语义，必须钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  API_TIMEOUT_MS, DEFAULT_API_BASE, apiSettingsFromPrefs, buildApiRequest, buildSystemPrompt,
  describeApiError, extractTranslation, normalizeChatUrl, originPatternFor, parseHeaders,
  parseKeyValueLines, targetLangFor,
} from '../src/translate-api.ts';

// —— Origin 规则的范围（扩展版用它去掉 Origin，好让本地模型服务接受扩展请求）——
// 必须**只**匹配用户填的那个 origin：多匹配一个字符就等于给别的站点开洞。
test('originPatternFor：只产出该地址的 origin 匹配串', () => {
  assert.equal(originPatternFor('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/*');
  assert.equal(originPatternFor('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/*');
  assert.equal(originPatternFor('http://127.0.0.1:11434/v1/chat/completions'), 'http://127.0.0.1:11434/*');
  assert.equal(originPatternFor('https://api.example.com/v1'), 'https://api.example.com/*');
  assert.equal(originPatternFor(''), null);
  assert.equal(originPatternFor('not a url'), null);
  assert.equal(originPatternFor('ftp://x/v1'), null, '只允许 http/https');
});

const baseCfg = {
  base: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5:7b',
  key: '',
  headersText: '',
  bodyText: '',
  reasoning: '',
};

test('默认地址是用户指定的 Ollama /v1', () => {
  assert.equal(DEFAULT_API_BASE, 'http://127.0.0.1:11434/v1');
});

test('normalizeChatUrl：host:port / …/v1 / 完整端点 / 尾斜杠 都归一化到 chat/completions', () => {
  assert.equal(normalizeChatUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(normalizeChatUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(normalizeChatUrl('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(normalizeChatUrl('http://127.0.0.1:11434/v1/chat/completions'),
               'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(normalizeChatUrl('https://api.openai.com/v1/chat/completions'),
               'https://api.openai.com/v1/chat/completions');
  // 有些网关只到 /completions
  assert.equal(normalizeChatUrl('http://x/v1/completions'), 'http://x/v1/chat/completions');
  assert.throws(() => normalizeChatUrl('   '), /为空/);
});

test('parseKeyValueLines：JSON 值按类型解析、其余当字符串、坏行进 problems', () => {
  const { values, problems } = parseKeyValueLines([
    '# 注释',
    'x: false',
    'y: 123',
    'top_p: 0.9',
    'response_format: {"type":"json_object"}',
    'name: qwen2.5',
    'empty:',
    '这行没有冒号',
    '',
  ].join('\n'));
  assert.equal(values.x, false);
  assert.equal(values.y, 123);
  assert.equal(values.top_p, 0.9);
  assert.deepEqual(values.response_format, { type: 'json_object' });
  assert.equal(values.name, 'qwen2.5');
  assert.equal(values.empty, '');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /没有冒号/);
});

test('值里带冒号：只在第一个冒号处切分（例如 URL / 提示词）', () => {
  const { values } = parseKeyValueLines('stop: ["a:b", "c"]');
  assert.deepEqual(values.stop, ['a:b', 'c']);
});

test('parseHeaders：头值一律字符串（HTTP 头不允许布尔/数字）', () => {
  const { headers, problems } = parseHeaders('x-debug: false\napi-key: abc123');
  assert.equal(headers['x-debug'], 'false');
  assert.equal(headers['api-key'], 'abc123');
  assert.equal(problems.length, 0);
});

test('buildApiRequest：附加字段**覆盖**默认值（这就是用户要的语义）', () => {
  const req = buildApiRequest({ ...baseCfg, bodyText: 'temperature: 0.7\ntop_p: 0.9\nnum_ctx: 8192' },
                              '你好', 'zh-en');
  assert.equal(req.body.temperature, 0.7);   // 被覆盖（默认 0）
  assert.equal(req.body.top_p, 0.9);
  assert.equal(req.body.num_ctx, 8192);
  assert.equal(req.body.model, 'qwen2.5:7b');
  assert.equal(req.body.stream, false);
  assert.equal(req.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(req.headers['Content-Type'], 'text/plain;charset=UTF-8');  // 无鉴权头 → 免预检（见下）
});

test('两条护栏：messages / stream 不允许被用户覆盖，但会回报 ignored', () => {
  const req = buildApiRequest({
    ...baseCfg,
    bodyText: 'stream: true\nmessages: [{"role":"user","content":"hack"}]',
  }, 'hi', 'auto');
  assert.equal(req.body.stream, false, 'stream 必须固定 false（本页按非流式解析）');
  assert.equal(req.body.messages[1].content, 'hi', '正文必须是我们给的句子');
  assert.deepEqual(req.ignored.sort(), ['messages', 'stream']);
});

test('key 非空 → 默认带上 Authorization；用户可用附加头覆盖（例如 Azure 的 api-key）', () => {
  const withKey = buildApiRequest({ ...baseCfg, key: 'sk-123' }, 'hi', 'auto');
  assert.equal(withKey.headers.Authorization, 'Bearer sk-123');
  const overridden = buildApiRequest({ ...baseCfg, key: 'sk-123', headersText: 'Authorization: Api-Key abc' },
                                     'hi', 'auto');
  assert.equal(overridden.headers.Authorization, 'Api-Key abc');
  const noKey = buildApiRequest(baseCfg, 'hi', 'auto');
  assert.equal(noKey.headers.Authorization, undefined);
});

test('缺少模型名 / 附加字段格式错 → 明确抛错（别静默发一个坏请求）', () => {
  assert.throws(() => buildApiRequest({ ...baseCfg, model: '  ' }, 'hi', 'auto'), /模型名/);
  assert.throws(() => buildApiRequest({ ...baseCfg, bodyText: '坏行没有冒号' }, 'hi', 'auto'),
                /格式不对/);
});

test('max_tokens 跟随调用方（与内置模型同一个参数），非法值回落到 128', () => {
  assert.equal(buildApiRequest(baseCfg, 'hi', 'auto', 24).body.max_tokens, 24);
  assert.equal(buildApiRequest(baseCfg, 'hi', 'auto', 0).body.max_tokens, 128);
});

test('targetLangFor / buildSystemPrompt：方向与自动判定（与内置模型同口径）', () => {
  assert.equal(targetLangFor('zh-en', '你好'), 'en');
  assert.equal(targetLangFor('en-zh', 'hello'), 'zh');
  assert.equal(targetLangFor('auto', '你好'), 'en');   // 中文 → 译成英文
  assert.equal(targetLangFor('auto', 'hello'), 'zh');  // 英文 → 译成中文
  assert.match(buildSystemPrompt('auto', '你好'), /into English/);
  assert.match(buildSystemPrompt('auto', 'hello'), /into Simplified Chinese/);
  assert.match(buildSystemPrompt('auto', 'hi'), /ONLY the translation/);
});

test('提示词必须交代"原文是识别结果、可能有错"（用户明确要求）', () => {
  const p = buildSystemPrompt('zh-en', '你好');
  assert.match(p, /speech recognition/);
  assert.match(p, /typos|homophones/i);
  assert.match(p, /meant|meaning/i);
  assert.match(p, /do NOT translate obvious recognition errors literally/);
});

test('extractTranslation：choices[0].message.content / text / 空 / 垃圾', () => {
  assert.equal(extractTranslation({ choices: [{ message: { content: ' Hello ' } }] }), 'Hello');
  assert.equal(extractTranslation({ choices: [{ text: 'Hi' }] }), 'Hi');
  assert.equal(extractTranslation({ choices: [{ message: { content: '   ' } }] }), null);
  assert.equal(extractTranslation({}), null);
  assert.equal(extractTranslation(null), null);
});

test('describeApiError：常见状态码给人话，网络失败提示 CORS', () => {
  assert.match(describeApiError(401, ''), /认证失败/);
  assert.match(describeApiError(404, ''), /地址或模型不存在/);
  assert.match(describeApiError(429, ''), /限流/);
  assert.match(describeApiError(500, 'boom'), /服务端错误.*boom/);
  assert.match(describeApiError(null, 'Failed to fetch'), /跨源|CORS/);
});

test('无鉴权头时用 text/plain：**避免 CORS 预检**（本地服务不处理 OPTIONS，实测 405）', () => {
  const clean = buildApiRequest(baseCfg, 'hi', 'auto');
  assert.equal(clean.headers['Content-Type'], 'text/plain;charset=UTF-8');
  // 用户自己写了 Content-Type 时按用户的来（覆盖语义）
  const forced = buildApiRequest({ ...baseCfg, headersText: 'Content-Type: application/json' }, 'hi', 'auto');
  assert.equal(forced.headers['Content-Type'], 'application/json');
});

test('带 Key 或自定义头时只能用 application/json（预检不可避免）', () => {
  assert.equal(buildApiRequest({ ...baseCfg, key: 'sk-1' }, 'hi', 'auto').headers['Content-Type'],
               'application/json');
  assert.equal(buildApiRequest({ ...baseCfg, headersText: 'api-key: abc' }, 'hi', 'auto').headers['Content-Type'],
               'application/json');
  // 安全名单里的头不算（Accept 不会触发预检）
  assert.equal(buildApiRequest({ ...baseCfg, headersText: 'Accept: application/json' }, 'hi', 'auto')
                 .headers['Content-Type'], 'text/plain;charset=UTF-8');
});

test('超时是有界的（慢模型不能把整条翻译队列堵死）', () => {
  assert.ok(Number.isFinite(API_TIMEOUT_MS) && API_TIMEOUT_MS > 0 && API_TIMEOUT_MS <= 60000);
});

// —— 推理控制（用户要求）——
// 语义：默认空 → **完全不注入**该字段（不认识它的服务会 400）；填 none → 注入
// "reasoning_effort": "none"；仍可被附加请求体字段覆盖。

test('推理控制为空时不注入 reasoning_effort', () => {  const req = buildApiRequest({ ...baseCfg, reasoning: '' }, 'hi', 'auto');
  assert.equal('reasoning_effort' in req.body, false);
});

test('推理控制填 none → 注入 "reasoning_effort": "none"', () => {
  const req = buildApiRequest({ ...baseCfg, reasoning: 'none' }, 'hi', 'auto');
  assert.equal(req.body.reasoning_effort, 'none');
});

test('推理控制去掉首尾空白，且非 none 的值原样透传（low/medium/high…）', () => {
  assert.equal(buildApiRequest({ ...baseCfg, reasoning: '  high ' }, 'hi', 'auto').body.reasoning_effort, 'high');
});

test('附加请求体字段仍可覆盖推理控制（覆盖语义一致）', () => {
  const req = buildApiRequest({ ...baseCfg, reasoning: 'none', bodyText: 'reasoning_effort: low' },
                              'hi', 'auto');
  assert.equal(req.body.reasoning_effort, 'low');
});

test('删除语法 !key：去掉默认注入的字段（o 系/gpt-5 拒绝 max_tokens 与 temperature:0）', () => {
  const req = buildApiRequest({
    ...baseCfg,
    bodyText: '!max_tokens\n!temperature\nmax_completion_tokens: 128',
  }, 'hi', 'auto');
  assert.equal('max_tokens' in req.body, false);
  assert.equal('temperature' in req.body, false);
  assert.equal(req.body.max_completion_tokens, 128);
  // 护栏仍然钉死：messages / stream 删不掉
  const guarded = buildApiRequest({ ...baseCfg, bodyText: '!messages\n!stream' }, 'hi', 'auto');
  assert.equal(guarded.body.stream, false);
  assert.equal(guarded.body.messages.length, 2);
});

test('apiSettingsFromPrefs：默认地址 / 来源 / 六项设置都从持久化偏好里取', () => {  const s = apiSettingsFromPrefs({
    translateSource: 'api', translateApiBase: '', translateApiModel: 'qwen2.5:7b',
    translateApiKey: 'sk-x', translateApiHeaders: 'api-key: abc', translateApiBody: 'top_p: 0.9',
    translateApiReasoning: 'none',
  });
  assert.equal(s.source, 'api');
  assert.equal(s.base, DEFAULT_API_BASE, '留空要用默认地址');
  assert.equal(s.model, 'qwen2.5:7b');
  assert.equal(s.key, 'sk-x');
  assert.equal(s.headersText, 'api-key: abc');
  assert.equal(s.bodyText, 'top_p: 0.9');
  assert.equal(s.reasoning, 'none');
  assert.equal(apiSettingsFromPrefs({}).source, 'builtin', '默认走内置模型');
});
