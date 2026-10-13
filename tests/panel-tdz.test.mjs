// 模块级状态的 TDZ 回归门（用户实测踩过）：
//
// 症状：`Uncaught ReferenceError: can't access lexical declaration 'Yo' before initialization`，
// 整个 panel 模块初始化中断 → **面板所有按钮点不动**，而且类型检查抓不到（tsc 不会为
// "函数体里用到后面才声明的 let" 报错，因为能否安全取决于运行时执行顺序）。
//
// 规则：预加载偏好那段代码在文件中部**就会执行**，所以它用到的模块级状态
// （例如 translateSource）必须声明在那之前。这条测试把顺序钉死。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/panel.ts', import.meta.url), 'utf8');
const lines = src.split('\n');

// 只认**代码行**：注释里提到函数名（本文件自己的注释就提到了）不该算"使用点"。
function lineOf(pattern) {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    if (pattern.test(lines[i])) return i;
  }
  return -1;
}

test('translateSource 的模块级声明早于第一次使用（防 TDZ 让整个面板失效）', () => {
  const decl = lineOf(/^let translateSource\b/);
  const firstUse = lineOf(/applyTranslateSource\(/);
  assert.ok(decl >= 0, '必须有模块级 `let translateSource` 声明');
  assert.ok(firstUse >= 0, '应当存在 applyTranslateSource 调用点');
  assert.ok(
    decl < firstUse,
    `声明在第 ${decl + 1} 行、第一次使用在第 ${firstUse + 1} 行：模块执行到使用点时变量还在 TDZ，会抛 ReferenceError`,
  );
});

test('translateSource 声明在"预加载偏好"那段之前（那段会在文件中部就执行）', () => {
  // 这一条比"前 1/3"更准：真正的执行点是 applyPrefs/初始化里调用 applyTranslateSource 的那几行。
  const decl = lineOf(/^let translateSource\b/);
  const prefsLoad = lineOf(/chkShowTs\.checked = prefs\.showTimestamps/);
  assert.ok(decl >= 0 && prefsLoad >= 0);
  assert.ok(decl < prefsLoad,
    `声明在第 ${decl + 1} 行、预加载偏好在第 ${prefsLoad + 1} 行：会先用到后声明 → TDZ`);
});
