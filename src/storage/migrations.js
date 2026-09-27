/**
 * 迁移按数组顺序执行，已执行的版本记录在 schema_migrations。
 * 迁移一旦发布就不再修改，只追加新版本。
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE IF NOT EXISTS messages (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id     TEXT    NOT NULL,
        message_id   TEXT,
        user_id      TEXT    NOT NULL,
        nickname     TEXT,
        role         TEXT,
        text         TEXT,
        segments     TEXT,
        raw          TEXT,
        is_command   INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_group_time ON messages (group_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_group_user_time ON messages (group_id, user_id, created_at);

      CREATE TABLE IF NOT EXISTS group_members (
        group_id    TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        nickname    TEXT,
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (group_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS groups (
        group_id    TEXT PRIMARY KEY,
        name        TEXT,
        enabled     INTEGER NOT NULL DEFAULT 1,
        settings    TEXT NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rules (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id    TEXT,
        type        TEXT NOT NULL,
        pattern     TEXT NOT NULL,
        action      TEXT NOT NULL,
        note        TEXT,
        enabled     INTEGER NOT NULL DEFAULT 1,
        hit_count   INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rules_group_type ON rules (group_id, type);

      CREATE TABLE IF NOT EXISTS violations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id    TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        rule_id     INTEGER,
        kind        TEXT NOT NULL,
        detail      TEXT,
        action      TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_violations_group_user ON violations (group_id, user_id, created_at);

      CREATE TABLE IF NOT EXISTS kv (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'ai-conversations',
    sql: `
      CREATE TABLE IF NOT EXISTS ai_conversations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_key   TEXT NOT NULL,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_conv_scope ON ai_conversations (scope_key, id);
    `,
  },
  {
    version: 3,
    name: 'violation-exempt',
    // 新建库直接带上 exempt 列；老库由 resolve 动态 ALTER 补齐（列检查用 PRAGMA）。
    sql: `
      CREATE TABLE IF NOT EXISTS violations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id    TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        rule_id     INTEGER,
        kind        TEXT NOT NULL,
        detail      TEXT,
        action      TEXT,
        exempt      INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_violations_group_time ON violations (group_id, created_at);
    `,
    resolve: null,
  },
  {
    version: 4,
    name: 'dedupe-message-id',
    /**
     * 同一 (group_id, message_id) 唯一。
     *
     * 为什么必须有：协议端在重连、批量拉历史、心跳抖动时会把同一条消息重放一次
     * （NapCat / Lagrange 都会）。重放的消息在业务上完全合法，
     * 所以没有任何校验会拦它，但它会让总消息数、活跃榜、时段分布整体偏大——
     * 而且偏得很均匀，看起来就像「群变活跃了」，属于最难发现的一类数据失真。
     *
     * 只对 message_id 非空的行走唯一约束：私聊/某些协议端不给 message_id，
     * 那些行（NULL）不能互相冲突。
     */
    // 建索引前必须先把历史重复行清掉，否则 CREATE UNIQUE INDEX 直接失败，
    // 整个迁移事务回滚 → 机器人起不来。老库（v3 及以前）在重放场景下
    // 必然已经有重复行，所以这是「升级路径」而不是边界情况。
    sql: `-- 见 resolve：先清理重复再建唯一索引`,
    resolve: (db) => {
      // 保留每个 (group_id, message_id) 里 id 最小的那条，其余删除
      db.run(`
        DELETE FROM messages
        WHERE message_id IS NOT NULL
          AND id NOT IN (
            SELECT MIN(id) FROM messages WHERE message_id IS NOT NULL GROUP BY group_id, message_id
          )
      `);
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedupe ON messages (group_id, message_id) WHERE message_id IS NOT NULL',
      );
    },
  },
];

export function migrate(db, { logger } = {}) {
  // 迁移是「可重复执行」的：新增列用 IF NOT EXISTS 包一层，
  // 让老库升级和全新初始化走同一段代码。
  // 列存在性检查必须用 PRAGMA，SQLite 不支持 ADD COLUMN IF NOT EXISTS。
  const hasColumn = (table, column) =>
    db.all(`PRAGMA table_info(${table})`).some((c) => c.name === column);
  MIGRATIONS.find((m) => m.version === 3).resolve = (database) => {
    if (!hasColumn('violations', 'exempt')) {
      database.exec('ALTER TABLE violations ADD COLUMN exempt INTEGER NOT NULL DEFAULT 0');
    }
  };
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const applied = new Set(db.all('SELECT version FROM schema_migrations').map((r) => r.version));
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      // resolve 处理「老库缺列」这类 DDL 差异，sqlite 没有 ADD COLUMN IF NOT EXISTS
      migration.resolve?.(db);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', migration.version, migration.name, Date.now());
    });
    logger?.info(`已应用迁移 v${migration.version} (${migration.name})`);
  }

  if (pending.length === 0) logger?.debug('数据库结构已是最新');
  return pending.length;
}
