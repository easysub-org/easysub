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
 *   探测到但**协议版本太旧**（没有 api 字段 / 低于最低版本）→ 'too_old'：
 *     说清"该更新助手"，而不是让他去找一个"没运行"的问题（可用性审查 S4）。
 *
 * 分界线 =「有没有连上（探测到）」，不是「有没有声音」。
 */

/** 探测 `/api/pair/info` 得到的、门卫关心的最小字段 */
export interface HelperGateProbe {
  /** 探测时带的令牌是否被助手认可（与"这个浏览器配过没有"同义） */
  paired: boolean;
  /** 助手的协议版本；老版本助手没有这个字段 → undefined */
  api?: number;
}

/** 门卫的裁决：offline=说明框；too_old=引导更新；pair=配对框；start=放行 */
export type HelperGateAction = 'offline' | 'too_old' | 'pair' | 'start';

/** 最低可用的助手协议版本（protocol.API_VERSION=1）。比它低/缺字段都算"该更新了" */
export const HELPER_MIN_API = 1;

/**
 * @param probe 探测结果；**null = 没探测到助手**（没运行/没安装/端口不在范围）
 * @param hasSession 本浏览器是否已持有配对换来的设备令牌
 */
export function evaluateHelperGate(
  probe: HelperGateProbe | null,
  hasSession: boolean,
): HelperGateAction {
  if (!probe) return 'offline';
  if (!probe.api || probe.api < HELPER_MIN_API) return 'too_old';
  if (!hasSession) return 'pair';
  return 'start';
}
