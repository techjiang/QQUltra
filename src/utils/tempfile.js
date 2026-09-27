import { mkdirSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

/**
 * 出图用的临时文件生命周期管理。
 *
 * 为什么需要这个模块：/wordcloud 与 /panel --img 每次都要在 tmpdir 写一个 SVG，
 * 而协议端是**异步**读取这个文件的（OneBot 收到 file:// 之后才去读），
 * 所以不能在发送后立刻删——删早了协议端起出来就是破图。
 * 但旧实现压根不删：机器人挂上几个月，tmpdir 里会攒下几十万个 SVG，
 * 直到把分区写满。这属于「跑得越久越危险」的缺陷，本地测试发现不了。
 *
 * 采用「延时删除 + 写入前回收 + 总量兜底」三层：
 * 1. 每个文件登记 TTL（默认 10 分钟），到点删除
 * 2. 每次写入前回收超龄残留——进程重启会丢定时器，靠这层兜住
 * 3. 单目录文件数超上限时按修改时间删到安全水位
 */
const PREFIX = 'qqu-';
export const DEFAULT_TTL_MS = 10 * 60_000;
export const DEFAULT_DIR = tmpdir();
const MAX_FILES = 500;

const timers = new Map();

/** 清理目录里超龄的 qqu-* 残留，返回删除数量。 */
export function sweepStale({ dir = DEFAULT_DIR, maxAgeMs = DEFAULT_TTL_MS, now = Date.now(), logger } = {}) {
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(PREFIX));
  } catch {
    return 0;
  }

  let removed = 0;
  const survivors = [];
  for (const name of names) {
    const full = join(dir, name);
    try {
      const mtime = statSync(full).mtimeMs;
      if (now - mtime > maxAgeMs) {
        rmSync(full, { force: true });
        removed += 1;
      } else {
        survivors.push({ full, mtime });
      }
    } catch {
      // 文件可能在扫描途中被协议端读走或被系统清理，忽略竞态
    }
  }

  if (survivors.length > MAX_FILES) {
    survivors.sort((a, b) => a.mtime - b.mtime);
    for (const item of survivors.slice(0, survivors.length - MAX_FILES)) {
      try {
        rmSync(item.full, { force: true });
        removed += 1;
      } catch {
        /* 竞态，忽略 */
      }
    }
  }
  if (removed > 0) logger?.debug(`已清理过期出图临时文件 ${removed} 个`);
  return removed;
}

/**
 * 写入临时文件并登记到期删除。
 * @returns {string} 可直接交给适配器的绝对路径
 */
export function writeTempFile({ dir = DEFAULT_DIR, name, content, ttlMs = DEFAULT_TTL_MS, logger } = {}) {
  mkdirSync(dir, { recursive: true });
  sweepStale({ dir, maxAgeMs: ttlMs, logger });
  const file = join(dir, `${PREFIX}${basename(String(name))}`);
  writeFileSync(file, content, 'utf8');

  const existing = timers.get(file);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    timers.delete(file);
    rmSync(file, { force: true });
  }, ttlMs);
  timer.unref?.(); // 不让定时器拖住进程退出
  timers.set(file, timer);
  return file;
}

/** 立刻删除所有已登记文件并清除定时器，供进程退出时调用。 */
export function disposeTempFiles() {
  let removed = 0;
  for (const [file, timer] of timers) {
    clearTimeout(timer);
    try {
      rmSync(file, { force: true });
      removed += 1;
    } catch {
      /* 已被删除 */
    }
  }
  timers.clear();
  return removed;
}
