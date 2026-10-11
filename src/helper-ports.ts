// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
/**
 * 助手的端口探测规划（**纯函数**，无 DOM / 无 chrome.* ），单独成文件是为了能测。
 *
 * 为什么值得单独抽出来（复审抓到的真 bug）：探测列表的"优先端口"以前只接受**一个**数字，
 * 调用方写的是 `helperPorts((await storedPort()) ?? (await storedPreferredPort()), full)` ——
 * `??` 让"旧会话里记的端口"（已配对用户的常态）**整个吃掉**用户在离线框里手填的端口。
 * 于是"填 9000 → 探到 → 存下 → 重新开始 → 又只探 8790–8810 → 同一个离线框弹回来"，
 * 页内无限循环。现在优先端口是**列表**，两者都会被探测。
 */

// 与 easysub-helper 的 config.PORT_SCAN_RANGE 对齐：默认端口被占时助手会自动顺延
export const HELPER_DEFAULT_PORT = 8790;
export const HELPER_PORT_SCAN = 20;
//: quick 模式在默认端口之外**多**探几个（含 8790 一共 3 个：8790/8791/8792）。
//: 面板一打开就扫 21 个端口会在控制台刷一屏失败请求（用户实测吐槽过），
//: 完整扫描留给"用户主动选了这个音源 / 点了开始"的时刻。
export const HELPER_PROBE_QUICK_PORTS = 2;
//: 助手**全部可能**的端口（含边界）：页面离线框里那句"助手端口"说的就是这一个范围
export const HELPER_PORT_MIN = HELPER_DEFAULT_PORT;
export const HELPER_PORT_MAX = HELPER_DEFAULT_PORT + HELPER_PORT_SCAN;

/**
 * 要探测的端口列表（优先端口在前，去重）。
 *
 * @param preferred 优先探测的端口：**可以给多个**（旧会话记住的端口 + 用户手填的端口）。
 *                  传单个数字或 undefined 也兼容（老调用方）。
 * @param full 是否扫满整个范围（false = 只扫开头几个，避免刷一屏失败请求）
 */
export function helperPorts(
  preferred?: number | Array<number | undefined> | undefined,
  full = false,
): number[] {
  const out: number[] = [];
  const list = Array.isArray(preferred) ? preferred : [preferred];
  for (const port of list) {
    if (typeof port === 'number' && Number.isFinite(port) && port > 0 && !out.includes(port)) {
      out.push(port);
    }
  }
  const last = full ? HELPER_PORT_SCAN : HELPER_PROBE_QUICK_PORTS;
  for (let i = 0; i <= last; i++) {
    const port = HELPER_DEFAULT_PORT + i;
    if (!out.includes(port)) out.push(port);
  }
  return out;
}

/**
 * **调用点**用的端口规划（纯函数，专门为了能被测）。
 *
 * 复审的教训：上游 bug 是调用点写错了（`(await storedPort()) ?? (await storedPreferredPort())`），
 * 而只测 `helperPorts` 的用例**护不住**那一行 —— 把调用点改回去，测试照样全绿。
 * 所以把"给两个候选端口、按什么顺序拼成探测列表"这件事本身抽出来：
 *
 *   - 用户**手填/记住的**端口排第一（他刚明确指定过它，命中时只发一个请求）；
 *   - 旧会话端口**也要**在里面（`??` 的写法就是把它当成了"有它就不要手填的"）；
 *   - 两者都没有时退回默认段。
 *
 * @param sessionPort 旧会话里记的端口（已配对用户几乎必然有）
 * @param preferredPort 用户手填并成功探到过的端口
 * @param full 是否扫满整个默认段
 */
export function probePortsFor(
  sessionPort: number | undefined,
  preferredPort: number | undefined,
  full = false,
): number[] {
  return helperPorts([preferredPort, sessionPort], full);
}
