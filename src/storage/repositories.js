import { startOfDay, startOfWeek, startOfMonth } from '../utils/time.js';

/**
 * 消息仓储。所有写路径都收敛在这里，便于统计口径一致：
 * messages 是明细，group_members 是增量汇总，二者必须同事务写入。
 */
/**
 * 活跃口径统一排除指令消息。
 *
 * 指令是「对机器人下的操作」，不是群成员之间的交流；
 * 若计进活跃榜，管理员每查一次统计就会给自己刷一条发言，
 * 也会让「活跃榜」和「时段分布」两个视图对不上（后者本来就排除指令）。
 */
const ACTIVE_ONLY = 'is_command = 0';

export function createMessageRepo(db) {
  return {
    insert(msg) {
      return db.run(
        `INSERT INTO messages (group_id, message_id, user_id, nickname, role, text, segments, raw, is_command, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        String(msg.groupId),
        msg.messageId ? String(msg.messageId) : null,
        String(msg.userId),
        msg.nickname ?? '',
        msg.role ?? 'member',
        msg.text ?? '',
        JSON.stringify(msg.segments ?? []),
        msg.raw ? JSON.stringify(msg.raw) : null,
        msg.isCommand ? 1 : 0,
        msg.timestamp,
      );
    },

    countSince(groupId, since, until = Number.MAX_SAFE_INTEGER) {
      const row = db.get(
        `SELECT COUNT(*) AS c FROM messages
         WHERE group_id = ? AND created_at >= ? AND created_at < ? AND ${ACTIVE_ONLY}`,
        String(groupId),
        since,
        until,
      );
      return row?.c ?? 0;
    },

    /** 消息总量（含指令），用于对账与清理统计。 */
    countAllSince(groupId, since, until = Number.MAX_SAFE_INTEGER) {
      const row = db.get(
        'SELECT COUNT(*) AS c FROM messages WHERE group_id = ? AND created_at >= ? AND created_at < ?',
        String(groupId),
        since,
        until,
      );
      return row?.c ?? 0;
    },

    countByUser(groupId, since, until = Number.MAX_SAFE_INTEGER) {
      return db.all(
        `SELECT user_id, MAX(nickname) AS nickname, COUNT(*) AS count,
                MIN(created_at) AS first_at, MAX(created_at) AS last_at
         FROM messages
         WHERE group_id = ? AND created_at >= ? AND created_at < ? AND ${ACTIVE_ONLY}
         GROUP BY user_id
         ORDER BY count DESC, last_at ASC`,
        String(groupId),
        since,
        until,
      );
    },

    lastMessages(groupId, userId, limit = 5) {
      return db.all(
        `SELECT text, created_at FROM messages
         WHERE group_id = ? AND user_id = ? AND is_command = 0
         ORDER BY created_at DESC LIMIT ?`,
        String(groupId),
        String(userId),
        limit,
      );
    },

    /** 检测模块用：某用户在某群最近 N 秒内的发言，用于刷屏判定。 */
    recentByUser(groupId, userId, sinceMs, untilMs = Number.MAX_SAFE_INTEGER) {
      return db.all(
        `SELECT id, text, created_at FROM messages
         WHERE group_id = ? AND user_id = ? AND created_at >= ? AND created_at <= ?
         ORDER BY created_at DESC`,
        String(groupId),
        String(userId),
        sinceMs,
        untilMs,
      );
    },

    recentInGroup(groupId, sinceMs, limit = 500) {
      return db.all(
        `SELECT id, user_id, nickname, text, created_at FROM messages
         WHERE group_id = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT ?`,
        String(groupId),
        sinceMs,
        limit,
      );
    },

    /** 按小时/星期聚合活跃时段，返回原始计数由上层换算。 */
    activityBuckets(groupId, since, until = Number.MAX_SAFE_INTEGER) {
      return db.all(
        `SELECT created_at FROM messages
         WHERE group_id = ? AND created_at >= ? AND created_at < ? AND ${ACTIVE_ONLY}`,
        String(groupId),
        since,
        until,
      );
    },

    distinctActiveUsers(groupId, since, until = Number.MAX_SAFE_INTEGER) {
      const row = db.get(
        `SELECT COUNT(DISTINCT user_id) AS c FROM messages
         WHERE group_id = ? AND created_at >= ? AND created_at < ? AND ${ACTIVE_ONLY}`,
        String(groupId),
        since,
        until,
      );
      return row?.c ?? 0;
    },

    prevPeriodStats(groupId, since, until) {
      const span = until - since;
      const row = db.get(
        `SELECT COUNT(*) AS total, COUNT(DISTINCT user_id) AS users FROM messages
         WHERE group_id = ? AND created_at >= ? AND created_at < ? AND ${ACTIVE_ONLY}`,
        String(groupId),
        since - span,
        until - span,
      );
      return { total: row?.total ?? 0, users: row?.users ?? 0 };
    },

    purgeBefore(ts) {
      const res = db.run('DELETE FROM messages WHERE created_at < ?', ts);
      return Number(res.changes ?? 0);
    },
  };
}

export function createMemberRepo(db) {
  return {
    upsert({ groupId, userId, nickname, timestamp }) {
      db.run(
        `INSERT INTO group_members (group_id, user_id, nickname, first_seen, last_seen, message_count)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT (group_id, user_id) DO UPDATE SET
           nickname = excluded.nickname,
           last_seen = excluded.last_seen,
           message_count = group_members.message_count + 1`,
        String(groupId),
        String(userId),
        nickname ?? '',
        timestamp,
        timestamp,
      );
    },

    get(groupId, userId) {
      return db.get('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', String(groupId), String(userId));
    },

    list(groupId, limit = 50) {
      return db.all(
        'SELECT * FROM group_members WHERE group_id = ? ORDER BY message_count DESC LIMIT ?',
        String(groupId),
        limit,
      );
    },

    remove(groupId, userId) {
      db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', String(groupId), String(userId));
    },
  };
}

export function createGroupRepo(db) {
  const parse = (row) =>
    row && {
      groupId: row.group_id,
      name: row.name,
      enabled: row.enabled === 1,
      settings: JSON.parse(row.settings || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

  return {
    ensure(groupId, name = null) {
      const now = Date.now();
      db.run(
        `INSERT INTO groups (group_id, name, enabled, settings, created_at, updated_at)
         VALUES (?, ?, 1, '{}', ?, ?)
         ON CONFLICT (group_id) DO UPDATE SET
           name = COALESCE(excluded.name, groups.name),
           updated_at = excluded.updated_at`,
        String(groupId),
        name,
        now,
        now,
      );
      return this.get(groupId);
    },

    get(groupId) {
      return parse(db.get('SELECT * FROM groups WHERE group_id = ?', String(groupId)));
    },

    list() {
      return db.all('SELECT * FROM groups ORDER BY group_id').map(parse);
    },

    setEnabled(groupId, enabled) {
      this.ensure(groupId);
      db.run('UPDATE groups SET enabled = ?, updated_at = ? WHERE group_id = ?', enabled ? 1 : 0, Date.now(), String(groupId));
      return this.get(groupId);
    },

    setSetting(groupId, key, value) {
      const group = this.ensure(groupId);
      const settings = { ...group.settings, [key]: value };
      db.run('UPDATE groups SET settings = ?, updated_at = ? WHERE group_id = ?', JSON.stringify(settings), Date.now(), String(groupId));
      return this.get(groupId);
    },

    isEnabled(groupId) {
      const group = this.get(groupId);
      // 未登记过的群按「开启但仅统计」处理，避免机器人进群后静默失效。
      return group ? group.enabled : true;
    },
  };
}

export function createRuleRepo(db) {
  const parse = (row) =>
    row && {
      id: row.id,
      groupId: row.group_id,
      type: row.type,
      pattern: row.pattern,
      action: row.action,
      note: row.note,
      enabled: row.enabled === 1,
      hitCount: row.hit_count,
      createdAt: row.created_at,
    };

  return {
    add({ groupId = null, type, pattern, action = 'warn', note = null }) {
      const res = db.run(
        'INSERT INTO rules (group_id, type, pattern, action, note, enabled, hit_count, created_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?)',
        groupId ? String(groupId) : null,
        type,
        pattern,
        action,
        note,
        Date.now(),
      );
      return this.get(Number(res.lastInsertRowid));
    },

    get(id) {
      return parse(db.get('SELECT * FROM rules WHERE id = ?', id));
    },

    list(groupId = null, { type = null } = {}) {
      const clauses = [];
      const params = [];
      if (groupId !== null) {
        clauses.push('(group_id = ? OR group_id IS NULL)');
        params.push(String(groupId));
      }
      if (type) {
        clauses.push('type = ?');
        params.push(type);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return db.all(`SELECT * FROM rules ${where} ORDER BY id`, ...params).map(parse);
    },

    remove(id) {
      return Number(db.run('DELETE FROM rules WHERE id = ?', id).changes ?? 0);
    },

    toggle(id, enabled) {
      db.run('UPDATE rules SET enabled = ? WHERE id = ?', enabled ? 1 : 0, id);
      return this.get(id);
    },

    bumpHit(id) {
      db.run('UPDATE rules SET hit_count = hit_count + 1 WHERE id = ?', id);
    },
  };
}

export function createViolationRepo(db) {
  return {
    add({ groupId, userId, ruleId = null, kind, detail = null, action = null }) {
      const res = db.run(
        'INSERT INTO violations (group_id, user_id, rule_id, kind, detail, action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        String(groupId),
        String(userId),
        ruleId,
        kind,
        detail,
        action,
        Date.now(),
      );
      return Number(res.lastInsertRowid);
    },

    /** 全部命中记录数（含同一违规的重复命中），用于审计展示。 */
    countByUser(groupId, userId, since) {
      const row = db.get(
        'SELECT COUNT(*) AS c FROM violations WHERE group_id = ? AND user_id = ? AND created_at >= ?',
        String(groupId),
        String(userId),
        since,
      );
      return row?.c ?? 0;
    },

    /**
     * 已实际执行处罚的次数 —— 这是升级阶梯该用的口径。
     *
     * 一次刷屏会连命中好几条消息（第 8 条、第 9 条各触发一次），
     * 若按命中条数升级，一次灌水就能把处罚顶到踢出，明显不合预期。
     */
    countPunished(groupId, userId, since) {
      const row = db.get(
        "SELECT COUNT(*) AS c FROM violations WHERE group_id = ? AND user_id = ? AND created_at >= ? AND kind = 'punish'",
        String(groupId),
        String(userId),
        since,
      );
      return row?.c ?? 0;
    },

    /**
     * 距上次实际处罚过去了多久（毫秒）；从未被处罚过返回 null。
     * 用于把「一次刷屏」折叠成一次违规，而不是按消息条数计数。
     */
    msSinceLastPunish(groupId, userId) {
      const row = db.get(
        "SELECT created_at FROM violations WHERE group_id = ? AND user_id = ? AND kind = 'punish' ORDER BY created_at DESC LIMIT 1",
        String(groupId),
        String(userId),
      );
      return row ? Date.now() - row.created_at : null;
    },

    recent(groupId, limit = 20) {
      return db.all('SELECT * FROM violations WHERE group_id = ? ORDER BY created_at DESC LIMIT ?', String(groupId), limit);
    },

    purgeBefore(ts) {
      return Number(db.run('DELETE FROM violations WHERE created_at < ?', ts).changes ?? 0);
    },
  };
}

export function createKvRepo(db) {
  return {
    get(key, fallback = null) {
      const row = db.get('SELECT value FROM kv WHERE key = ?', key);
      if (!row) return fallback;
      try {
        return JSON.parse(row.value);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      db.run(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key,
        JSON.stringify(value),
        Date.now(),
      );
      return value;
    },
    delete(key) {
      db.run('DELETE FROM kv WHERE key = ?', key);
    },
  };
}

/**
 * AI 会话仓储。上下文只保留最近 N 条，超出的在写入时顺手裁掉，
 * 否则长期运行的群会让这张表无限膨胀。
 */
export function createConversationRepo(db) {
  return {
    append(scopeKey, role, content, maxKeep = 40) {
      db.transaction(() => {
        db.run('INSERT INTO ai_conversations (scope_key, role, content, created_at) VALUES (?, ?, ?, ?)', scopeKey, role, content, Date.now());
        db.run(
          `DELETE FROM ai_conversations
           WHERE scope_key = ? AND id NOT IN (
             SELECT id FROM ai_conversations WHERE scope_key = ? ORDER BY id DESC LIMIT ?
           )`,
          scopeKey,
          scopeKey,
          maxKeep,
        );
      });
    },

    history(scopeKey, limit = 12) {
      const rows = db.all(
        'SELECT role, content FROM ai_conversations WHERE scope_key = ? ORDER BY id DESC LIMIT ?',
        scopeKey,
        limit,
      );
      return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
    },

    clear(scopeKey) {
      return Number(db.run('DELETE FROM ai_conversations WHERE scope_key = ?', scopeKey).changes ?? 0);
    },
  };
}

export function createStorage({ db, logger } = {}) {
  if (!db) throw new Error('createStorage 需要传入已打开的数据库实例');
  return {
    db,
    logger,
    messages: createMessageRepo(db),
    members: createMemberRepo(db),
    groups: createGroupRepo(db),
    rules: createRuleRepo(db),
    violations: createViolationRepo(db),
    kv: createKvRepo(db),
    conversations: createConversationRepo(db),
    close: () => db.close(),
  };
}
