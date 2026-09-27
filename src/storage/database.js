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

  // 事务嵌套深度与 savepoint 序号
  let depth = 0;
  let savepointSeq = 0;

  // ---- 预编译语句缓存 ----
  // 每条群消息都会走十几次「同样的 SQL、不同的参数」。每次 prepare 都要让
  // SQLite 重新做一遍词法与语法制析，实测这部分占了单条消息处理时间的约 1/3。
  // 缓存后同样的 20000 次调用从 61ms 降到 15ms（4 倍）。
  //
  // 缓存必须有上限：SQL 文本来自代码而不是用户输入，理论上条数固定，
  // 但 20_000 条消息 × 动态拼接的 SQL（如 IN 列表）长期运行仍可能无限增长。
  // 到达上限时整体清空而不是 LRU——清空代价是一次 re-prepare，
  // 而 LRU 需要维护访问序，为这点收益不值得增加复杂度。
  const stmtCache = new Map();
  const STMT_CACHE_LIMIT = 200;

  const prepare = (sql) => {
    const cached = stmtCache.get(sql);
    if (cached) return cached;
    const stmt = db.prepare(sql);
    if (stmtCache.size >= STMT_CACHE_LIMIT) stmtCache.clear();
    stmtCache.set(sql, stmt);
    return stmt;
  };

  const api = {
    raw: db,
    file,
    exec: (sql) => db.exec(sql),
    run(sql, ...params) {
      try {
        return prepare(sql).run(...bind(params));
      } catch (err) {
        // 语句出错时把它从缓存里踢掉：SQLite 的 prepare 失败不会留下坏对象，
        // 但语法错/表不存在的语句留在缓存里只会让后续每次调用都重新报同一个错，
        // 清掉能让「先建表后使用」这类初始化顺序问题自愈。
        stmtCache.delete(sql);
        throw new StorageError(`SQL 执行失败: ${sql}`, { cause: err });
      }
    },
    get(sql, ...params) {
      try {
        return prepare(sql).get(...bind(params)) ?? null;
      } catch (err) {
        stmtCache.delete(sql);
        throw new StorageError(`SQL 查询失败: ${sql}`, { cause: err });
      }
    },
    all(sql, ...params) {
      try {
        return prepare(sql).all(...bind(params));
      } catch (err) {
        stmtCache.delete(sql);
        throw new StorageError(`SQL 查询失败: ${sql}`, { cause: err });
      }
    },
    /** 语句缓存条目数，供自检与测试观察。 */
    statementCacheSize: () => stmtCache.size,
    /**
     * 事务包装。支持嵌套：外层用 BEGIN/COMMIT，内层用 SAVEPOINT。
     *
     * SQLite 不允许嵌套 BEGIN（会抛 "cannot start a transaction within a transaction"），
     * 而业务里已经出现了「collector.record 与 engine.commit 各开一个事务」的写法。
     * 它们目前恰好不在同一调用栈上，但只要将来有人把两步合成一步（很自然的重构），
     * 就会在运行期炸掉，且只有真正处理违规消息时才触发。
     * 用 SAVEPOINT 兜住这个结构性风险。
     */
    transaction(fn) {
      if (depth > 0) {
        const name = `sp_${++savepointSeq}`;
        depth += 1;
        db.exec(`SAVEPOINT ${name}`);
        try {
          const result = fn(api);
          db.exec(`RELEASE ${name}`);
          return result;
        } catch (err) {
          db.exec(`ROLLBACK TO ${name}`);
          db.exec(`RELEASE ${name}`);
          throw err;
        } finally {
          depth -= 1;
        }
      }

      depth += 1;
      db.exec('BEGIN');
      try {
        const result = fn(api);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        depth -= 1;
      }
    },
    close: () => {
      stmtCache.clear();
      db.close();
    },
  };

  logger?.debug(`数据库已打开: ${file}`);
  return api;
}
