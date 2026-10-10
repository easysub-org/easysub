// 端口探测规划的回归测试（node --test 直跑 src/helper-ports.ts）。
//
// 为什么单独钉这一条：以前"优先端口"只接受一个数字，调用方写成
// `helperPorts((await storedPort()) ?? (await storedPreferredPort()), …)` —— 已配对用户的
// storage 里必然有旧会话端口，`??` 于是把用户在离线框里**手填的端口整个吃掉**，导致
// "填 9000 → 探到 → 重新开始 → 又只探 8790–8810 → 同一个框弹回来"的页内死循环。
// 这条测试就是钉住"两个端口都会进探测列表"。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HELPER_DEFAULT_PORT, HELPER_PORT_MAX, HELPER_PORT_MIN, HELPER_PORT_SCAN,
  HELPER_PROBE_QUICK_PORTS, helperPorts,
} from '../src/helper-ports.ts';

test('旧会话端口与手填端口**都**要被探测（曾经的页内死循环）', () => {
  const ports = helperPorts([9000, 8790], false);
  assert.ok(ports.includes(9000), `手填端口必须被探测: ${ports.join(',')}`);
  assert.ok(ports.includes(8790), `旧会话端口也要保留: ${ports.join(',')}`);
  assert.equal(ports[0], 9000, '优先端口排在前面（命中时只发一个请求）');
});

test('手填端口被记住后一定进列表，哪怕会话端口存在', () => {
  // 反向用例：只有会话端口时，默认段之外的那个端口就会丢（修复前的行为）
  assert.ok(!helperPorts(8790, false).includes(9000));
  assert.ok(helperPorts([9000, 8790], false).includes(9000));
});

test('端口去重、非法值被忽略、顺序稳定', () => {
  const ports = helperPorts([8790, 8790, undefined, 0, -1, NaN], false);
  assert.equal(ports.filter((p) => p === 8790).length, 1, '不能重复');
  assert.ok(!ports.includes(0));
  assert.ok(!ports.includes(-1));
  assert.equal(ports[0], 8790);
});

test('quick 只探开头几个，full 扫满整个范围', () => {
  assert.equal(helperPorts(undefined, false).length, HELPER_PROBE_QUICK_PORTS + 1);
  assert.equal(helperPorts(undefined, true).length, HELPER_PORT_SCAN + 1);
  const full = helperPorts(undefined, true);
  assert.equal(Math.min(...full), HELPER_PORT_MIN);
  assert.equal(Math.max(...full), HELPER_PORT_MAX);
  assert.equal(HELPER_PORT_MIN, HELPER_DEFAULT_PORT);
  assert.equal(HELPER_PORT_MAX, HELPER_DEFAULT_PORT + HELPER_PORT_SCAN);
});

test('页面探测的绝对范围与助手默认顺延一致（跨仓约定，改这里要两边一起改）', () => {
  // 助手仓 config.DEFAULT_PORT=8790 / PORT_SCAN_RANGE=20 → 只会落在 8790..8810。
  // 助手从 --port 起顺延，所以用户在助手侧改基础端口后可能落到范围外 —— 那条路靠页面
  // 离线框里的"手动填端口"兜住（见 helper-ports.ts 的注释与 helper.ts 的 preferred port）。
  assert.equal(HELPER_DEFAULT_PORT, 8790);
  assert.equal(HELPER_PORT_SCAN, 20);
  assert.equal(HELPER_PORT_MAX, 8810);
});
