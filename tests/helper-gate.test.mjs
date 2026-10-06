// 桌面助手启动门卫的回归测试（node --test 直跑，规则原文见 src/helper-gate.ts）。
//
// 背景：这条门卫的规则在六轮审查里翻转过一次——最初"助手没运行"也允许开始（静音跑），
// 用户明确纠正：「我都没打开音频助手软件，都没有连接，点击启动还能给我启动？？？」。
// 这组用例把正确的裁决钉死：改门卫先跑 `npm test`。
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateHelperGate } from '../src/helper-gate.ts';

const probe = (paired) => ({ paired });

test('助手没运行/没装/探测不到 → offline（不启动）', () => {
  assert.equal(evaluateHelperGate(null, false), 'offline');
  assert.equal(evaluateHelperGate(null, true), 'offline', '有旧令牌也一样拦：连不上就是连不上');
});

test('探测到但未配对 → pair（弹配对框）', () => {
  assert.equal(evaluateHelperGate(probe(false), false), 'pair');
});

test('已配对 + 助手处于暂停 → start（用户明确要求的例外：开关控制音频，不控制连接）', () => {
  assert.equal(evaluateHelperGate(probe(true), true), 'start');
});

test('已配对 + 助手正在采 → start', () => {
  assert.equal(evaluateHelperGate(probe(true), true), 'start');
});

test('裁决只有三种，不出现别的状态', () => {
  // 所有可能输入的组合都落到三种裁决之一（不抛异常、不返回 undefined）
  for (const p of [null, probe(false), probe(true)]) {
    for (const s of [false, true]) {
      const v = evaluateHelperGate(p, s);
      assert.ok(['offline', 'pair', 'start'].includes(v), `意外裁决: ${String(v)}`);
    }
  }
});
