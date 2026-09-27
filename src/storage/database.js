import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { StorageError } from '../utils/errors.js';

/**
 * 单文件 SQLite 存储。选用内置 node:sqlite 而非第三方 ORM：
 * 群聊统计是典型的「单机、写入密集、按群+时间聚合」负载，
 * 一张消息表 + 合理索引足够，不引入依赖换取的复杂度。
 */
export function openDatabase({ file = ':memory:', logger } = {}) {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }

  let db;
  try {
    db = new DatabaseSync(file);
  } catch (err) {
    throw new StorageError(`无法打开数据库 ${file}`, { cause: err });
  }

  // WAL 让读（统计查询）不被写（消息入库）阻塞；NORMAL 在断电下最坏丢最后几秒统计。
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  db.exec('PRAGMA foreign_keys = ON');

  // node:sqlite 的绑定参数不接受 undefined（会抛 "cannot be bound"），
  // 而业务层到处用可选字段，因此统一在入口把 undefined 归一为 null。
  const bind = (params) => (params.some((p) => p === undefined) ? params.map((p) => (p === undefined ? null : p)) : params);

  const api = {
    raw: db,
    file,
    exec: (sql) => db.exec(sql),
    run(sql, ...params) {
      try {
        return db.prepare(sql).run(...bind(params));
      } catch (err) {
        throw new StorageError(`SQL 执行失败: ${sql}`, { cause: err });
      }
    },
    get(sql, ...params) {
      try {
        return db.prepare(sql).get(...bind(params)) ?? null;
      } catch (err) {
        throw new StorageError(`SQL 查询失败: ${sql}`, { cause: err });
      }
    },
    all(sql, ...params) {
      try {
        return db.prepare(sql).all(...bind(params));
      } catch (err) {
        throw new StorageError(`SQL 查询失败: ${sql}`, { cause: err });
      }
    },
    transaction(fn) {
      db.exec('BEGIN');
      try {
        const result = fn(api);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => db.close(),
  };

  logger?.debug(`数据库已打开: ${file}`);
  return api;
}
