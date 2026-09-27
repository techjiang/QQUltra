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
];

export function migrate(db, { logger } = {}) {
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
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', migration.version, migration.name, Date.now());
    });
    logger?.info(`已应用迁移 v${migration.version} (${migration.name})`);
  }

  if (pending.length === 0) logger?.debug('数据库结构已是最新');
  return pending.length;
}
