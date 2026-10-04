#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
//
// 发行版本号 → manifest.json / package.json 的"翻译器"。
//
// 为什么需要它（真 bug）：发布工作流原来是 `sed -i 's/"version": ".*"/"version": "1.8.0beta.1"/'`，
// 把 dispatch 输入**原样**塞进 manifest.json。而 Chrome 对 manifest 的 `version` 有硬约束：
// **1~4 段以点分隔的整数，每段 0~65535，非零段不能有前导零**。`1.8.0beta.1` 非法 →
// 插件直接加载失败（用户实测）。Firefox 侧同样是"数字点分"的规则。
//
// 本项目的发行版本只有两种写法（其它一律报错，宁可 CI 红也不产出一个装不上的包）：
//   稳定版   x.x.x          → manifest.version = x.x.x
//   Beta 版  x.x.xbeta.x    → manifest.version = x.x.x.x（第 4 段就是 beta 序号）
// 原始写法另外写进 `version_name`（Chrome 的"显示用版本号"，不参与版本比较），
// 这样商店/扩展管理页里看到的仍然是 `1.8.0beta.1`。
//
// 用法：
//   node scripts/bump-version.mjs 1.8.0beta.1     # 写 manifest.json + package.json
//   node scripts/bump-version.mjs --dry-run 1.8.0 # 只打印，不落盘
//   node scripts/bump-version.mjs --check         # 校验现有版本号（CI 每次构建都跑）

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const MANIFEST = path.join(ROOT, 'manifest.json');
const PKG = path.join(ROOT, 'package.json');

const ACCEPTED = 'x.x.x 或 x.x.xbeta.x（例如 1.8.0 / 1.8.0beta.1）';

/** 把发行写法解析成各字段；不合规就抛错（带人话原因）。 */
export function parseVersion(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error(`版本号为空；只接受 ${ACCEPTED}`);

  let m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (m) {
    const parts = [m[1], m[2], m[3]];
    assertParts(parts, text);
    return { raw: text, numeric: parts.join('.'), display: null, semver: parts.join('.'), beta: false };
  }

  m = /^(\d+)\.(\d+)\.(\d+)beta\.(\d+)$/.exec(text);
  if (m) {
    const base = [m[1], m[2], m[3]];
    const ordinal = m[4];
    assertParts(base.concat([ordinal]), text);
    return {
      raw: text,
      numeric: base.concat([ordinal]).join('.'),   // 1.8.0beta.1 → 1.8.0.1
      display: text,                               // 给人看/给 version_name 的原始写法
      semver: `${base.join('.')}-beta.${ordinal}`, // package.json 要合法 semver
      beta: true,
    };
  }

  throw new Error(`版本号 "${text}" 不是本项目允许的写法；只接受 ${ACCEPTED}`);
}

function assertParts(parts, raw) {
  parts.forEach((p) => {
    if (!/^\d+$/.test(p)) throw new Error(`版本号 "${raw}" 含有非整数段`);
    if (p.length > 1 && p[0] === '0') throw new Error(`版本号 "${raw}" 的段 "${p}" 有前导零（浏览器不接受）`);
    const n = Number(p);
    if (n > 65535) throw new Error(`版本号 "${raw}" 的段 "${p}" 超过 65535（浏览器不接受）`);
  });
  if (parts.length > 4) throw new Error(`版本号 "${raw}" 超过 4 段（浏览器不接受）`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj, dryRun) {
  const text = JSON.stringify(obj, null, 2) + '\n';
  if (!dryRun) fs.writeFileSync(file, text);
}

/** 把 version / version_name 写进 manifest，把 semver 写进 package.json。 */
export function applyVersion(parsed, { dryRun = false } = {}) {
  const manifest = readJson(MANIFEST);
  const pkg = readJson(PKG);

  manifest.version = parsed.numeric;
  if (parsed.display) manifest.version_name = parsed.display;
  else delete manifest.version_name;               // 稳定版不留 version_name，免得和 number 打架

  // 让 version/version_name 挨在一起（可读性）；JSON.parse 保留键序，这里只做一次搬迁
  if (parsed.display) {
    const entries = Object.entries(manifest).filter(([k]) => k !== 'version_name');
    const at = entries.findIndex(([k]) => k === 'version');
    entries.splice(at + 1, 0, ['version_name', parsed.display]);
    const reordered = {};
    entries.forEach(([k, v]) => { reordered[k] = v; });
    writeJson(MANIFEST, reordered, dryRun);
  } else {
    writeJson(MANIFEST, manifest, dryRun);
  }

  pkg.version = parsed.semver;
  writeJson(PKG, pkg, dryRun);

  return { manifest: parsed.numeric, versionName: parsed.display, packageVersion: parsed.semver };
}

/** --check：校验仓库里**现有**的版本号（防止手改出非法值） */
function check() {
  const manifest = readJson(MANIFEST);
  const pkg = readJson(PKG);
  const problems = [];

  const num = String(manifest.version || '');
  if (!/^\d+(\.\d+){0,3}$/.test(num)) problems.push(`manifest.json 的 version "${num}" 不是 1~4 段整数`);
  else {
    num.split('.').forEach((p) => {
      if (p.length > 1 && p[0] === '0') problems.push(`manifest.json 的 version "${num}" 段 "${p}" 有前导零`);
      if (Number(p) > 65535) problems.push(`manifest.json 的 version "${num}" 段 "${p}" 超过 65535`);
    });
  }
  if (manifest.version_name !== undefined && !/^\d+\.\d+\.\d+(beta\.\d+)?$/.test(String(manifest.version_name))) {
    problems.push(`manifest.json 的 version_name "${manifest.version_name}" 不是 ${ACCEPTED}`);
  }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(pkg.version || ''))) {
    problems.push(`package.json 的 version "${pkg.version}" 不是合法 semver`);
  }

  if (problems.length) {
    problems.forEach((p) => console.error(`::error::${p}`));
    return 1;
  }
  console.log(`✓ 版本号检查通过：manifest.version=${num}` +
    (manifest.version_name ? `，version_name=${manifest.version_name}` : '') +
    `，package.json=${pkg.version}`);
  return 0;
}

function main(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const wantCheck = args.includes('--check');
  const value = args.find((a) => !a.startsWith('--'));

  try {
    if (wantCheck) return check();
    const parsed = parseVersion(value);
    const written = applyVersion(parsed, { dryRun });
    console.log(`${dryRun ? '[dry-run] ' : ''}版本号：${parsed.raw}`);
    console.log(`  manifest.json  version      = ${written.manifest}`);
    if (written.versionName) console.log(`  manifest.json  version_name = ${written.versionName}`);
    console.log(`  package.json   version      = ${written.packageVersion}`);
    if (parsed.beta) {
      console.log(`  （beta 写法 ${parsed.raw} → 浏览器版本号 ${written.manifest}；` +
        `请确认商店里没有先发过 ${written.manifest}）`);
    }
    return 0;
  } catch (err) {
    console.error(`::error::${err.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  process.exit(main(process.argv));
}
