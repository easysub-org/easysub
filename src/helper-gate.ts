// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
/**
 * 桌面助手音源的**启动门卫**（纯函数：无 DOM、无 chrome.*、无异步）。
 *
 * 为什么要单独抽出来（全盲审查 m4）：这条门卫的规则在六轮审查里翻转过一次（我最初把
 * "助手没运行"也当成了"可以静音开始"），全靠人工审查回归——这正是最需要自动化测试钉住的
 * 地方。抽成纯函数后用 `npm test`（node --test 直跑 TS）钉住，见 tests/helper-gate.test.mjs。
 *
 * 规则（用户原话，别再改回去）：
 *   「我都没打开音频助手软件，都没有连接，点击启动还能给我启动？？？？？」
 *     → **没连上就不许开始**：探测不到助手（没运行/没安装/端口在范围外）→ 'offline'。
 *   「helper 没有启动捕获音频也允许启动 / 因为 helper 是活着的，那个开关是控制音频的」
 *     → **活着但暂停可以开始**：探测到 + 有会话 → 'start'（此刻收静音帧，识别照常；
 *       用户在助手窗口点「启动」后 server 直接续推真实 PCM，无需重开）。
 *   探测到但还没配对 → 'pair'（弹配对框；「取消」= 放弃这次启动）。
 *
 * 分界线 =「有没有连上（探测到）」，不是「有没有声音」。
 */

/** 探测 `/api/pair/info` 得到的、门卫关心的最小字段 */
export interface HelperGateProbe {
  /** 探测时带的令牌是否被助手认可（与"这个浏览器配过没有"同义） */
  paired: boolean;
}

/** 门卫的裁决：offline=弹"助手没在运行"说明框；pair=弹配对框；start=放行 */
export type HelperGateAction = 'offline' | 'pair' | 'start';

/**
 * @param probe 探测结果；**null = 没探测到助手**（没运行/没安装/端口不在范围）
 * @param hasSession 本浏览器是否已持有配对换来的设备令牌
 */
export function evaluateHelperGate(
  probe: HelperGateProbe | null,
  hasSession: boolean,
): HelperGateAction {
  if (!probe) return 'offline';
  if (!hasSession) return 'pair';
  return 'start';
}
