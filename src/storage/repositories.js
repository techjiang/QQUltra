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

    /**
     * 群内最近消息（默认排除指令）。
     *
     * 默认排除 is_command 的原因：这个接口的消费方是「给成员看的语料」
     * ——/history 的发言回顾、/wordcloud 的词云、AI 的群上下文，
     * 指令属于「对机器人下的操作」，混进去会让 /history 的第一行一直是
     * 刚打完的那条 /history，词云里出现「wordcloud」「--top」这类词。
     *
     * 需要包含指令的场景（对账、完整回放）显式传 includeCommands。
     */
    recentInGroup(groupId, sinceMs, limit = 500, { includeCommands = false } = {}) {
      const filter = includeCommands ? '' : ` AND ${ACTIVE_ONLY}`;
      return db.all(
        `SELECT id, user_id, nickname, text, is_command, created_at FROM messages
         WHERE group_id = ? AND created_at >= ?${filter}
         ORDER BY created_at DESC LIMIT ?`,
        String(groupId),
        sinceMs,
        limit,
      );
    },

    /** 群内最近语料，带上 until 上界过滤，供词云与 AI 上下文复用，避免各处重复拼条件。 */
    recentWindow(groupId, since, until, limit, { includeCommands = false } = {}) {
      const filter = includeCommands ? '' : ` AND ${ACTIVE_ONLY}`;
      return db.all(
        `SELECT id, user_id, nickname, text, is_command, created_at FROM messages
         WHERE group_id = ? AND created_at >= ? AND created_at < ?${filter}
         ORDER BY created_at DESC LIMIT ?`,
        String(groupId),
        since,
        until,
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

    /**
     * 清理「明细已被删除、汇总却还在」的成员行。
     *
     * 汇总表是增量维护的：/purge 只删 messages 明细时，group_members 不会跟着缩，
     * 于是 /whois、成员列表会继续展示已经没有任何明细的「幽灵成员」，
     * 而它的累计发言数又对不上任何一条明细——对账时无从判断谁是对的。
     *
     * cutoff 之前的成员：把 last_seen 落在 cutoff 之前的行删掉，
     * 因为它已经不可能再代表一个活跃成员。
     */
    purgeBefore(cutoff) {
      return Number(db.run('DELETE FROM group_members WHERE last_seen < ?', cutoff).changes ?? 0);
    },

    /** 明细为空且从未入群登记的成员行（例如只发过指令的人），用于一致性修复。 */
    removeEmpty(groupId = null) {
      const where = groupId === null ? '' : ' AND group_id = ?';
      const params = groupId === null ? [] : [String(groupId)];
      return Number(
        db
          .run(
            `DELETE FROM group_members WHERE message_count = 0 AND user_id NOT IN (SELECT DISTINCT user_id FROM messages WHERE 1=1${where})${where}`,
            ...params,
            ...params,
          ).changes ?? 0,
      );
    },

    /**
     * 登记「入群」事件。
     *
     * 必须独立于 upsert：upsert 是「发过言」才会调用的，只在发言时写 first_seen
     * 会让「入群时间」变成「第一次发言时间」，新人广告检测（依赖入群 24h 内）
     * 从此再也命中不了——而且不报错，只是静默失效。
     *
     * message_count 保持不动：入群本身不是发言。
     */
    markJoined({ groupId, userId, nickname = null, timestamp }) {
      db.run(
        `INSERT INTO group_members (group_id, user_id, nickname, first_seen, last_seen, message_count)
         VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT (group_id, user_id) DO UPDATE SET
           first_seen = excluded.first_seen,
           nickname = COALESCE(excluded.nickname, group_members.nickname)`,
        String(groupId),
        String(userId),
        nickname,
        timestamp,
        timestamp,
      );
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
    /**
     * 确保群记录存在，并可选补充群名。
     *
     * 关键约束：没有实际变更时**不写库**。
     * 旧实现用 `ON CONFLICT DO UPDATE SET updated_at = excluded.updated_at`，
     * 于是每条群消息（handleMessage 与 collector 各调一次）都会产生一次 UPDATE——
     * 既是纯写放大（WAL 下每次提交都要落日志页），
     * 也让 updated_at 失去意义：它本该表示「配置何时改过」，
     * 被消息刷成每秒都在变，运维再也无法判断配置是什么时候动的。
     */
    ensure(groupId, name = null) {
      const id = String(groupId);
      const existing = this.get(id);
      if (existing) {
        // 只在需要补名且确有变化时写一次
        if (name && existing.name !== name) {
          db.run('UPDATE groups SET name = ?, updated_at = ? WHERE group_id = ?', name, Date.now(), id);
          return this.get(id);
        }
        return existing;
      }
      const now = Date.now();
      db.run(
        `INSERT INTO groups (group_id, name, enabled, settings, created_at, updated_at)
         VALUES (?, ?, 1, '{}', ?, ?)
         ON CONFLICT (group_id) DO NOTHING`,
        id,
        name,
        now,
        now,
      );
      return this.get(id);
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
    /**
     * 写入一条命中记录。
     *
     * @param {number} [createdAt] 显式时间戳，默认 now()。检测链路里传入
     *   message.timestamp，让「事件窗口」按消息发生时间而不是落库时间判断——
     *   补发/延迟到达的消息否则会被算成「刚刚发生」，把升级阶梯顶满。
     * @param {boolean} [exempt] 是否属于「豁免命中」（白名单角色 / 仅记录不处置）。
     *   豁免命中仍要留痕供审计，但不该被计入预警与简报的「风控命中」，
     *   否则管理员自己说一句广告口径的话就会把群预警打到触发。
     */
    add({ groupId, userId, ruleId = null, kind, detail = null, action = null, createdAt = Date.now(), exempt = false }) {
      const res = db.run(
        'INSERT INTO violations (group_id, user_id, rule_id, kind, detail, action, exempt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        String(groupId),
        String(userId),
        ruleId,
        kind,
        detail,
        exempt ? 'exempt' : action,
        exempt ? 1 : 0,
        createdAt,
      );
      return Number(res.lastInsertRowid);
    },

    /**
     * 指定时间窗内的「有效命中」数（排除豁免命中与 punish 摘要）。
     * 供异常预警与每日简报使用：这两个功能的作用是「提醒有人正在捣乱」，
     * 把豁免命中算进去会让它们变成噪音源，最终被管理员整体关掉。
     */
    countHitsInWindow(groupId, since, until = Number.MAX_SAFE_INTEGER) {
      const row = db.get(
        `SELECT COUNT(*) AS c FROM violations
         WHERE group_id = ? AND created_at >= ? AND created_at < ?
           AND kind != 'punish' AND exempt = 0`,
        String(groupId),
        since,
        until,
      );
      return row?.c ?? 0;
    },

    /** 时间窗内的有效命中明细（排除豁免与 punish 摘要），上限由 SQL 保证而不是先取最近 N 条再过滤。 */
    hitsInWindow(groupId, since, until = Number.MAX_SAFE_INTEGER, limit = 500) {
      return db.all(
        `SELECT * FROM violations
         WHERE group_id = ? AND created_at >= ? AND created_at < ?
           AND kind != 'punish' AND exempt = 0
         ORDER BY created_at DESC LIMIT ?`,
        String(groupId),
        since,
        until,
        limit,
      );
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
     * 已「落地」的处罚次数 —— 这是升级阶梯该用的口径。
     *
     * 一次刷屏会连命中好几条消息（第 8 条、第 9 条各触发一次），
     * 若按命中条数升级，一次灌水就能把处罚顶到踢出，明显不合预期。
     *
     * degraded（机器人权限不足、动作被协议端拒绝）不计入：
     * 那是执行失败，不是威慑成功，计入等于「罚不成功也升级」。
     */
    countPunished(groupId, userId, since) {
      const row = db.get(
        `SELECT COUNT(*) AS c FROM violations
         WHERE group_id = ? AND user_id = ? AND created_at >= ?
           AND kind = 'punish' AND action != 'degraded'`,
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

    /**
     * 按「事件」聚合的近期违规，供 /violations 展示。
     *
     * 一次违规会在 violations 里留多条痕迹：每个命中的检测器一条（如 ad + newbie_shill），
     * 外加一条 kind='punish' 的处置摘要。直接按 kind 折叠仍然会留下「摘要」那一行，
     * 而且跟明细在同一时间戳上重复显示，管理员看到的是「一次违规=3 行」。
     *
     * 这里以 kind='punish' 作为事件锚点（它只在真正走完处置流程时写入），
     * 把同一用户在紧邻时间内的命中明细合并成一条事件，
     * 未走到处置的命中（warn / 处罚关闭 / 白名单）没有 punish 锚点，单独作为一条。
     *
     * 合并窗口而不是「时间戳完全相等」：命中行在 commit 事务里逐条写入，
     * punish 摘要在其后写入，两者跨毫秒是常态（实测约 1/6 的概率落后 1ms）。
     * 用相等判断会让同一次违规时而合并、时而拆成两条，表现为 /violations 偶发多一行。
     *
     * @param {number} mergeWindowMs 命中行与处置摘要的最大时间差，默认 1 秒
     * @returns {{ userId:string, createdAt:number, kinds:string[], action:string, detail:string }[]}
     */
    incidents(groupId, limit = 20, { mergeWindowMs = 1000 } = {}) {
      // 多取一些原始行：一次事件最多占 3 行，避免 limit 被明细行吃掉
      const rows = db.all(
        'SELECT * FROM violations WHERE group_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
        String(groupId),
        Math.max(limit * 4, 60),
      );
      const incidents = [];
      const used = new Set();

      // 先按 punish 锚点聚事件（punish 只写一次，代表「这次真的处置了」）
      for (const anchor of rows.filter((r) => r.kind === 'punish')) {
        if (used.has(anchor.id)) continue;
        // 命中行可能比 punish 摘要早一两毫秒，按窗口而不是相等来判断
        const sameEvent = rows.filter(
          (r) =>
            !used.has(r.id) &&
            r.kind !== 'punish' &&
            r.user_id === anchor.user_id &&
            Math.abs(anchor.created_at - r.created_at) <= mergeWindowMs,
        );
        for (const r of sameEvent) used.add(r.id);
        used.add(anchor.id);
        incidents.push({
          userId: anchor.user_id,
          createdAt: anchor.created_at,
          kinds: sameEvent.map((r) => r.kind),
          // 处置摘要里 action 就是实际执行的动作；punish 行永不豁免
          action: anchor.action ?? 'none',
          exempt: false,
          detail: anchor.detail ?? '',
        });
        if (incidents.length >= limit) break;
      }

      // 剩下的命中没有处置流程（仅记录/告警），按用户 + 邻近时间折叠成事件
      if (incidents.length < limit) {
        for (const r of rows) {
          if (used.has(r.id)) continue;
          const existing = incidents.find(
            (i) => i.userId === r.user_id && Math.abs(i.createdAt - r.created_at) <= mergeWindowMs,
          );
          if (existing) {
            if (!existing.kinds.includes(r.kind)) existing.kinds.push(r.kind);
            existing.detail ||= r.detail ?? '';
            // 同一事件里只要有一条是真实命中，就不算「纯豁免」
            existing.exempt = existing.exempt && r.exempt === 1;
            used.add(r.id);
            continue;
          }
          used.add(r.id);
          incidents.push({
            userId: r.user_id,
            createdAt: r.created_at,
            kinds: [r.kind],
            action: r.action ?? 'none',
            exempt: r.exempt === 1,
            detail: r.detail ?? '',
          });
          if (incidents.length >= limit) break;
        }
      }

      return incidents.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
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
