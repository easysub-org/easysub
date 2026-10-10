// 桌面助手启动门卫的回归测试（node --test 直跑，规则原文见 src/helper-gate.ts）。
//
// 背景：这条门卫的规则在六轮审查里翻转过一次——最初"助手没运行"也允许开始（静音跑），
// 用户明确纠正：「我都没打开音频助手软件，都没有连接，点击启动还能给我启动？？？」。
// 这组用例把正确的裁决钉死：改门卫先跑 `npm test`。
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateHelperGate, HELPER_MIN_API } from '../src/helper-gate.ts';

const probe = (paired, api = HELPER_MIN_API) => ({ paired, api });

test('助手没运行/没装/探测不到 → offline（不启动）', () => {
  assert.equal(evaluateHelperGate(null, false), 'offline');
  assert.equal(evaluateHelperGate(null, true), 'offline', '有旧令牌也一样拦：连不上就是连不上');
});

test('协议版本太旧 → too_old（引导更新助手，而不是说"没在运行"）', () => {
  // 老助手没有 api 字段：用户窗口就摆在眼前，说"没运行"是误导（可用性审查 S4）
  assert.equal(evaluateHelperGate({ paired: true }, true), 'too_old');
  assert.equal(evaluateHelperGate({ paired: false }, false), 'too_old');
  assert.equal(evaluateHelperGate(probe(true, HELPER_MIN_API - 1), true), 'too_old');
});

test('探测到但未配对 → pair（弹配对框）', () => {
  assert.equal(evaluateHelperGate(probe(false), false), 'pair');
});

test('已配对 + 助手处于暂停 → start（用户明确要求的例外：开关控制音频，不控制连接）', () => {
  // 注意：门卫只看"探测到 + 有会话"，paused 不参与裁决 —— 暂停与否都放行，
  // 暂停期间页面收静音帧，用户在助手窗口点「启动」后 server 直接续推真实 PCM。
  assert.equal(evaluateHelperGate(probe(true), true), 'start');
});

test('裁决只有四种，不出现别的状态', () => {
  for (const p of [null, { paired: false }, { paired: true }, probe(true, HELPER_MIN_API + 5)]) {
    for (const s of [false, true]) {
      const v = evaluateHelperGate(p, s);
      assert.ok(['offline', 'too_old', 'pair', 'start'].includes(v), `意外裁决: ${String(v)}`);
    }
  }
});
