#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
//
// CLA 工作流的**本地**逻辑测试：不需要 GitHub、不需要 Docker、不需要联网。
//
//   node scripts/test-cla-workflow.mjs
//
// 做法：从 .github/workflows/cla.yml 里抽出内嵌的 github-script 代码，喂给它一套假的 GitHub API，
// 跑 10 个场景（免签名单 / 未签 / 已提醒 / 签署落库 / 姓名注入 / 库里已有 / 签名库不存在 /
// 别人评论 / 大小写 / 已关闭的 PR）并断言标签、评论、签名库写入与 setFailed 行为。
// 改工作流之后跑一遍，能挡住"机器人把未签的 PR 当已签"这类最贵的事故。
//
// 注意：它测的是**脚本逻辑**，不测 GitHub 的事件投递与权限；那部分要用真 PR 验（见 CONTRIBUTING.md）。

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/cla.yml');

/** 从 YAML 里抠出 `script: |` 块（不引第三方 YAML 解析器，保持零依赖）。 */
function extractScript(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'script: |');
  if (start < 0) throw new Error('在 cla.yml 里找不到 script: | 块');
  const baseIndent = lines[start].search(/\S/);
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') { body.push(''); continue; }
    if (line.search(/\S/) <= baseIndent) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(indent)).join('\n');
}

/** 一套假的 GitHub：记录所有写操作，供断言。 */
function makeWorld(opts = {}) {
  const author = opts.author ?? 'octocat';
  const existingLabels = (opts.labels ?? []).slice();
  const pull = {
    number: opts.number ?? 7,
    user: { login: author },
    state: opts.prState ?? 'open',
    labels: existingLabels.map((name) => ({ name })),
  };
  const calls = { added: [], removed: [], comments: [], writes: [], created: [], failed: [] };
  const comments = opts.comments ?? [];
  const store = opts.store === undefined ? null : opts.store;

  const github = {
    paginate: async () => comments,
    rest: {
      pulls: { get: async () => ({ data: pull }) },
      issues: {
        getLabel: async ({ name }) => {
          if (!calls.created.some((l) => l.name === name)) {
            const err = new Error('Not Found');
            err.status = 404;
            throw err;
          }
          return { data: { name } };
        },
        createLabel: async ({ name, color, description }) => {
          calls.created.push({ name, color, description });
        },
        addLabels: async ({ labels }) => {
          calls.added.push(...labels);
          labels.forEach((name) => {
            if (!pull.labels.some((l) => l.name === name)) pull.labels.push({ name });
          });
        },
        removeLabel: async ({ name }) => {
          calls.removed.push(name);
          pull.labels = pull.labels.filter((l) => l.name !== name);
        },
        createComment: async ({ body }) => {
          calls.comments.push(body);
        },
        listComments: async () => comments,
      },
      repos: {
        getContent: async () => {
          if (store === null) {
            const err = new Error('Not Found');
            err.status = 404;
            throw err;
          }
          return {
            data: { sha: opts.sha ?? 'sha-1', content: Buffer.from(JSON.stringify(store)).toString('base64') },
          };
        },
        createOrUpdateFileContents: async (body) => {
          calls.writes.push(body);
        },
      },
    },
  };

  const context = {
    repo: { owner: 'easysub-org', repo: 'easysub' },
    payload: {
      repository: { default_branch: 'master' },
      ...(opts.noPr ? {} : { pull_request: { number: pull.number } }),
      inputs: opts.inputs ?? {},
    },
    issue: { number: pull.number },
  };
  const core = { info: () => {}, warning: () => {}, setFailed: (m) => calls.failed.push(m) };
  return { github, context, core, calls, pull };
}

const script = extractScript(fs.readFileSync(WORKFLOW, 'utf8'));
const runner = new Function(
  'github', 'context', 'core',
  `return (async () => {\n${script}\n})();`,
);

const PHRASE = 'I have read the CLA Document and I hereby sign the CLA.';
const botReminder = { user: { login: 'github-actions[bot]' }, body: '<!-- cla-bot:reminder --> 请签 CLA' };

function commentBy(login, body, extra = {}) {
  return {
    user: { login },
    body,
    created_at: '2026-10-05T00:00:00Z',
    html_url: `https://github.com/easysub-org/easysub/pull/7#issuecomment-${login}`,
    ...extra,
  };
}

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

test('维护者在免签名单里 → 什么都不做', async () => {
  const w = makeWorld({ author: 'Huchangzhi', comments: [commentBy('Huchangzhi', PHRASE)] });
  await runner(w.github, w.context, w.core);
  assert.deepEqual(w.calls.added, []);
  assert.deepEqual(w.calls.comments, []);
  assert.deepEqual(w.calls.writes, []);
  assert.deepEqual(w.calls.failed, []);
});

test('免签名单大小写不敏感', async () => {
  const w = makeWorld({ author: 'huchangzhi' });
  await runner(w.github, w.context, w.core);
  assert.deepEqual(w.calls.failed, []);
});

test('未签 → cla-pending + 提醒一次 + 检查失败', async () => {
  const w = makeWorld({});
  await runner(w.github, w.context, w.core);
  assert.deepEqual(w.calls.added, ['cla-pending']);
  assert.equal(w.calls.comments.length, 1);
  assert.match(w.calls.comments[0], /I have read the CLA Document/);
  assert.equal(w.calls.failed.length, 1, '未签必须让检查失败，否则卡不住合并');
  assert.deepEqual(w.calls.writes, []);
});

test('已经提醒过 → 不重复打扰，但仍然失败', async () => {
  const w = makeWorld({ comments: [botReminder] });
  await runner(w.github, w.context, w.core);
  assert.deepEqual(w.calls.comments, []);
  assert.equal(w.calls.failed.length, 1);
});

test('签署 → 写入签名库 + cla-signed + 确认一次', async () => {
  const w = makeWorld({
    store: { version: 1, documentVersion: '1.1', signed: [] },
    labels: ['cla-pending'],
    comments: [commentBy('octocat', `${PHRASE}\nName: Zhang San`)],
  });
  await runner(w.github, w.context, w.core);
  assert.deepEqual(w.calls.added, ['cla-signed']);
  assert.deepEqual(w.calls.removed, ['cla-pending']);
  assert.equal(w.calls.writes.length, 1);
  const saved = JSON.parse(Buffer.from(w.calls.writes[0].content, 'base64').toString('utf8'));
  assert.equal(saved.signed.length, 1);
  assert.equal(saved.signed[0].username, 'octocat');
  assert.equal(saved.signed[0].name, 'Zhang San');
  assert.equal(saved.signed[0].documentVersion, '1.1');
  assert.equal(w.calls.writes[0].sha, 'sha-1', '已有签名库时要带 sha，否则并发会覆盖');
  assert.equal(w.calls.comments.length, 1, '要回一句确认');
  assert.deepEqual(w.calls.failed, []);
});

test('姓名要清洗（换行/@/反引号/尖括号/超长）', async () => {
  const evil = 'Evil\n@everyone `rm -rf` <b>Name</b> ' + 'x'.repeat(200);
  const w = makeWorld({ comments: [commentBy('octocat', `${PHRASE}\nName: ${evil}`)] });
  await runner(w.github, w.context, w.core);
  const saved = JSON.parse(Buffer.from(w.calls.writes[0].content, 'base64').toString('utf8'));
  const name = saved.signed[0].name;
  assert.ok(name.length <= 80, `名字被截断到 80 字以内，实际 ${name.length}`);
  for (const ch of ['\n', '@', '`', '<', '>']) {
    assert.ok(!name.includes(ch), `清洗后不该含 ${JSON.stringify(ch)}：${name}`);
  }
  assert.ok(!w.calls.comments[0].includes('@everyone'), '确认评论里不能出现注入的 mention');
});

test('签名库不存在 → 不带 sha 新建', async () => {
  const w = makeWorld({ store: null, comments: [commentBy('octocat', PHRASE)] });
  await runner(w.github, w.context, w.core);
  assert.equal(w.calls.writes.length, 1);
  assert.equal(w.calls.writes[0].sha, undefined);
  const saved = JSON.parse(Buffer.from(w.calls.writes[0].content, 'base64').toString('utf8'));
  assert.equal(saved.signed[0].name, null, '没写姓名时留 null，不要瞎猜');
});

test('签名库里已有（同一份 CLA 版本）→ 只补标签，不写库不评论', async () => {
  const w = makeWorld({
    store: { version: 1, documentVersion: '1.1', signed: [{ username: 'OctoCat', documentVersion: '1.1' }] },
    comments: [],
  });
  await runner(w.github, w.context, w.core);
  assert.deepEqual(w.calls.added, ['cla-signed']);
  assert.deepEqual(w.calls.writes, []);
  assert.deepEqual(w.calls.comments, []);
  assert.deepEqual(w.calls.failed, []);
});

test('别人发的签署评论不算签', async () => {
  const w = makeWorld({ comments: [commentBy('random-person', PHRASE)] });
  await runner(w.github, w.context, w.core);
  assert.deepEqual(w.calls.added, ['cla-pending']);
  assert.deepEqual(w.calls.writes, []);
  assert.equal(w.calls.failed.length, 1);
});

test('已关闭的 PR → 跳过', async () => {
  const w = makeWorld({ prState: 'closed', comments: [commentBy('octocat', PHRASE)] });
  await runner(w.github, w.context, w.core);
  assert.deepEqual(w.calls.added, []);
  assert.deepEqual(w.calls.failed, []);
});

test('workflow_dispatch 手动重跑 → 用输入的 PR 号', async () => {
  const w = makeWorld({ number: 42, noPr: true, inputs: { pr: '42' }, comments: [] });
  await runner(w.github, w.context, w.core);
  assert.equal(w.calls.failed.length, 1, '手动重跑也该给出结论');
});

let failed = 0;
for (const c of cases) {
  try {
    await c.fn();
    console.log(`  ✓ ${c.name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${c.name}\n      ${err.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
