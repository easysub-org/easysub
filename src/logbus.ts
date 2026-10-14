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
  /**
   * **跨上下文稳定身份**。同一条日志在"面板本地 → 宿主缓冲 → 回播给面板"这三跳里必须
   * 携带同一个 id，否则去重键（原来用"时间+来源+内容"）永远不会命中 —— 时间戳每一跳都被
   * 重新盖章，结果日志窗里每行都出现两三遍（独立审查 B1，实测必现）。
   */
  id: string;
  /** 毫秒时间戳（外部传入，便于测试；同一 id 必须沿用同一个 t）。 */
  t: number;
  level: LogLevel;
  /** 来源：panel / background / offscreen / helper / floating … */
  source: string;
  message: string;
}

/** 消息归一化：换行会毁掉"一行一条"与复制，统一压平（面板与宿主必须用同一套规则）。 */
export function normalizeMessage(message: unknown): string {
  return String(message == null ? '' : message).replace(/\s*\n\s*/g, ' ⏎ ');
}

//: 进程内自增序号，与时间戳一起构成 id（同一毫秒内的多条也不会撞）。
let idSeq = 0;
//: 每个 JS 上下文一份的随机前缀。**必须要有**：面板(popup)每次打开都会重置 idSeq，
//: 而面板与宿主是两个上下文 —— 只靠 `时间戳+序号` 会撞车，而 `dedupeLogs` 按 id 去重、
//: 后传优先，撞车意味着**另一条不同内容的日志被静默丢掉**（盲审 P3-3）。
const idPrefix = Math.random().toString(36).slice(2, 8);

/** 生成一个日志 id（调用方只在**产生**日志时生成一次，之后一路沿用）。 */
export function nextLogId(): string {
  idSeq += 1;
  return `${idPrefix}-${Date.now().toString(36)}-${idSeq.toString(36)}`;
}

/**
 * 合并多份日志列表：**按 id 去重**、按时间排序、保留最后 `limit` 条。
 *
 * 这是"日志窗每行重复两三遍"那个 bug（独立审查 B1）的守门函数：以前按"时间+来源+内容"去重，
 * 而时间戳在"面板本地 → 宿主缓冲 → 回播"每一跳都被重新盖章，键永远不同 → 一条都去不掉。
 * 后传的列表优先（面板本地那份覆盖宿主那份，因为它可能记录了宿主还没收到的早期日志）。
 */
export function dedupeLogs(lists: LogEntry[][], limit: number = DEFAULT_LIMIT): LogEntry[] {
  const byId = new Map<string, LogEntry>();
  for (const list of lists) {
    for (const entry of list) {
      if (!entry) continue;
      // 没有 id 的（外部/旧数据）退化成"时间+来源+内容"，至少不会因缺字段而整条丢掉
      const key = entry.id || `${entry.t}|${entry.source}|${entry.message}`;
      byId.set(key, entry);
    }
  }
  const rows = Array.from(byId.values()).sort((a, b) => (a.t || 0) - (b.t || 0));
  return rows.length > limit ? rows.slice(rows.length - limit) : rows;
}

//: 默认上限。用户要"所有日志"，但内存不能无限涨：500 条足够回溯一整场会话，
//: 而且环形保留**最新**的（出问题时用户需要的是刚刚发生了什么）。
export const DEFAULT_LIMIT = 500;

export interface LogBuffer {
  /** 追加一条。`meta.id`/`meta.t` 用于**沿用调用方的身份**（跨上下文回播时别重新盖章）。 */
  append(level: LogLevel, source: string, message: string, meta?: { t?: number; id?: string }): LogEntry;
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
    append(level, source, message, meta) {
      const t = meta && typeof meta.t === 'number' ? meta.t : Date.now();
      const entry: LogEntry = {
        // 身份：调用方给了就沿用（跨上下文回播必须沿用，否则去重永远命中不了）
        id: (meta && meta.id) || nextLogId(),
        t,
        level,
        source: source || 'app',
        message: normalizeMessage(message),
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
