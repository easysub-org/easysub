// 日志缓冲区的回归测试（node --test 直跑 src/logbus.ts）。
//
// 为什么值得单测：用户明确要求"面板底部有个按钮能看**所有**日志、能复制全部/清空全部"，
// 而这个缓冲是那条功能唯一的真相源（面板状态栏只有一行）。环形上限、清空、订阅、
// 导出格式都得钉住，否则"日志看着少了/复制出来是乱的"这类问题没人能查。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLogBuffer, dedupeLogs, formatEntry, formatTime, nextLogId, normalizeMessage, DEFAULT_LIMIT } from '../src/logbus.ts';

test('按顺序记录，list() 返回副本（外部改不动内部）', () => {
  const buf = createLogBuffer(10);
  buf.append('info', 'panel', '第一条', 1000);
  buf.append('warn', 'background', '第二条', 2000);
  const list = buf.list();
  assert.deepEqual(list.map((e) => e.message), ['第一条', '第二条']);
  list.pop();
  assert.equal(buf.list().length, 2, 'list() 必须返回副本');
});

test('环形上限：只留最新的 N 条', () => {
  const buf = createLogBuffer(3);
  for (let i = 1; i <= 5; i++) buf.append('info', 'panel', 'm' + i, i);
  assert.deepEqual(buf.list().map((e) => e.message), ['m3', 'm4', 'm5']);
});

test('默认上限是一个有限的正整数（"所有日志"也不能吃光内存）', () => {
  assert.ok(Number.isInteger(DEFAULT_LIMIT) && DEFAULT_LIMIT > 0);
});

test('clear() 清空但不影响后续记录', () => {
  const buf = createLogBuffer(10);
  buf.append('info', 'panel', 'a', 1);
  buf.clear();
  assert.deepEqual(buf.list(), []);
  buf.append('error', 'helper', 'b', 2);
  assert.equal(buf.list().length, 1);
});

test('订阅能拿到新条目，取消后不再收到', () => {
  const buf = createLogBuffer(10);
  const seen = [];
  const off = buf.subscribe((e) => seen.push(e.message));
  buf.append('info', 'panel', 'x', 1);
  off();
  buf.append('info', 'panel', 'y', 2);
  assert.deepEqual(seen, ['x']);
});

test('订阅者抛异常不会影响记录本身', () => {
  const buf = createLogBuffer(10);
  buf.subscribe(() => {
    throw new Error('boom');
  });
  buf.append('info', 'panel', 'z', 1);
  assert.equal(buf.list().length, 1);
});

test('消息里的换行被压平（否则"一行一条"和复制都乱）', () => {
  const buf = createLogBuffer(10);
  const entry = buf.append('error', 'helper', '第一行\n  第二行', 1);
  assert.ok(!entry.message.includes('\n'), entry.message);
});

test('format()：时间戳 + 级别 + 来源 + 消息，一行一条', () => {
  const buf = createLogBuffer(10);
  // 用**本地时间**构造零点再断言，别用 new Date(0)（那是 UTC 零点，东八区会差 8 小时）
  const localMidnight = new Date(2026, 9, 12, 0, 0, 0, 0).getTime();
  buf.append('warn', 'helper', '采集出错', { t: localMidnight });
  const text = buf.format();
  assert.match(text, /^00:00:00\.000 WARN\s+\[helper\] 采集出错$/);
  assert.equal(buf.format([{ t: localMidnight, level: 'error', source: 'panel', message: 'x' }]).split('\n').length, 1);
  assert.equal(buf.format([]).length, 0, '显式传空数组 → 空文本（用于"没有日志"）');
});

test('时间格式固定宽度（日志能对齐看）', () => {
  assert.equal(formatTime(new Date(2026, 9, 12, 9, 5, 3, 7).getTime()), '09:05:03.007');
});

test('formatEntry 对未知级别也安全', () => {
  // @ts-expect-error 故意传非法级别，验证不会崩
  const line = formatEntry({ t: 0, level: 'debug', source: 'x', message: 'm' });
  assert.ok(line.includes('undefined') || line.includes('debug'), line);
});

// —— 去重（独立审查 B1 的守门测试）——
// 背景：同一条日志在"面板本地 → 宿主缓冲 → 回播给面板"三跳里，时间戳每一跳都会被重新盖章；
// 原来按"时间+来源+内容"去重，键永远不同 → 日志窗里每行出现两三遍、计数也是假的。
// 修法：给每条日志一个跨上下文稳定 id，去重按 id。

test('dedupeLogs：同一个 id 出现多次只留一条（哪怕时间戳/来源被重新盖章）', () => {
  const local = [{ id: 'a', t: 100, level: 'info', source: 'panel', message: 'm' }];
  const host = [{ id: 'a', t: 999, level: 'info', source: 'panel', message: 'm' }];   // 被重新盖章
  const echo = [{ id: 'a', t: 1234, level: 'info', source: 'panel', message: 'm' }];  // 回播再盖一次
  const rows = dedupeLogs([host, local, echo]);
  assert.equal(rows.length, 1, '同 id 必须只剩一条');
  assert.equal(rows[0].id, 'a');
});

test('dedupeLogs：后传的列表优先（面板本地覆盖宿主那份）', () => {
  const host = [{ id: 'a', t: 200, level: 'info', source: 'panel', message: '宿主版' }];
  const local = [{ id: 'a', t: 100, level: 'info', source: 'panel', message: '本地版' }];
  const rows = dedupeLogs([host, local]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message, '本地版');
});

test('dedupeLogs：不同 id 全留，并按时间升序', () => {
  const rows = dedupeLogs([
    [{ id: 'c', t: 300, level: 'info', source: 'engine', message: '3' }],
    [{ id: 'a', t: 100, level: 'info', source: 'panel', message: '1' },
     { id: 'b', t: 200, level: 'error', source: 'helper', message: '2' }],
  ]);
  assert.deepEqual(rows.map((e) => e.id), ['a', 'b', 'c']);
});

test('dedupeLogs：缺 id 的旧数据退化成"时间+来源+内容"，不因缺字段被丢', () => {
  const rows = dedupeLogs([[{ t: 1, level: 'info', source: 'x', message: 'm' }],
                           [{ t: 1, level: 'info', source: 'x', message: 'm' }]]);
  assert.equal(rows.length, 1, '同一内容仍应去重');
});

test('dedupeLogs：超过上限时保留最新的', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: 'i' + i, t: i, level: 'info', source: 'x', message: 'm' + i }));
  const rows = dedupeLogs([many], 3);
  assert.deepEqual(rows.map((e) => e.id), ['i7', 'i8', 'i9']);
});

test('nextLogId 不重复（同一毫秒内也不会撞）', () => {
  const ids = new Set(Array.from({ length: 200 }, () => nextLogId()));
  assert.equal(ids.size, 200);
});

test('normalizeMessage 压平换行（面板与宿主必须同一套规则，否则去重也会失败）', () => {
  assert.equal(normalizeMessage('a\n  b'), 'a ⏎ b');
  assert.equal(normalizeMessage(null), '');
});
