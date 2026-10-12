// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
/**
 * 日志缓冲区（面板里那个「查看所有日志」窗的数据源）。
 *
 * 为什么要有它（用户原话："这样 easysub 的调试就更舒服了"）：
 * 面板的状态栏只有**一行**（`panel.ts` 的 `log()` 直接覆盖 `#modelStatus`），
 * 出错时用户能看到的信息在下一秒就被下一条覆盖；扩展的 popup 关掉后更是**什么都不剩**。
 * 所以这里做一个**环形缓冲**：所有模块（面板 / background / offscreen / 浮窗 / 助手消息）
 * 的日志都往这里追加，默认**不看**，只有用户点面板底部的「查看所有日志」才展开。
 *
 * 纯函数、不碰 DOM/存储，方便用 `node --test` 钉住（见 tests/logbus.test.mjs）。
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  /** 毫秒时间戳（外部传入，便于测试）。 */
  t: number;
  level: LogLevel;
  /** 来源：panel / background / offscreen / helper / floating … */
  source: string;
  message: string;
}

//: 默认上限。用户要"所有日志"，但内存不能无限涨：500 条足够回溯一整场会话，
//: 而且环形保留**最新**的（出问题时用户需要的是刚刚发生了什么）。
export const DEFAULT_LIMIT = 500;

export interface LogBuffer {
  append(level: LogLevel, source: string, message: string, t?: number): LogEntry;
  list(): LogEntry[];
  clear(): void;
  /** 订阅新增条目（返回取消订阅函数）。 */
  subscribe(fn: (entry: LogEntry) => void): () => void;
  /** 导出成可复制的纯文本（给「复制全部」用）。 */
  format(entries?: LogEntry[]): string;
}

function two(value: number): string {
  return value < 10 ? '0' + String(value) : String(value);
}

/** 时间戳 → `HH:MM:SS.mmm`（本地时区，便于和用户看到的时钟对照）。 */
export function formatTime(t: number): string {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.` +
    `${String(d.getMilliseconds()).padStart(3, '0')}`;
}

const LEVEL_TAG: Record<LogLevel, string> = { info: 'INFO ', warn: 'WARN ', error: 'ERROR' };

/** 一行一条：`12:34:56.789 ERROR [helper] 消息`（复制出去能直接贴进 issue）。 */
export function formatEntry(entry: LogEntry): string {
  return `${formatTime(entry.t)} ${LEVEL_TAG[entry.level]} [${entry.source}] ${entry.message}`;
}

export function createLogBuffer(limit: number = DEFAULT_LIMIT): LogBuffer {
  let entries: LogEntry[] = [];
  const listeners = new Set<(entry: LogEntry) => void>();
  const keep = Math.max(1, Math.floor(limit));

  return {
    append(level, source, message, t) {
      const entry: LogEntry = {
        t: typeof t === 'number' ? t : Date.now(),
        level,
        source: source || 'app',
        // 换行会把"一行一条"弄乱，复制出去也不好读 → 压成空格
        message: String(message == null ? '' : message).replace(/\s*\n\s*/g, ' ⏎ '),
      };
      entries.push(entry);
      if (entries.length > keep) entries = entries.slice(entries.length - keep);
      for (const fn of listeners) {
        try {
          fn(entry);
        } catch {
          /* 订阅者出错不该影响记录本身 */
        }
      }
      return entry;
    },
    list() {
      return entries.slice();
    },
    clear() {
      entries = [];
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    format(list) {
      // 只有**不传**才表示"全部"；显式传数组就按它来（哪怕是空数组）。
      // 坑：写成 `list && list.length ? list : entries` 时，面板按级别过滤后为空
      // 会显示**全部**日志（测试抓到过）。
      const rows = Array.isArray(list) ? list : entries;
      return rows.map(formatEntry).join('\n');
    },
  };
}
