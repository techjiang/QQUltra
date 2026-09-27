import { startOfDay, startOfWeek, startOfMonth, formatDuration, DAY } from '../../utils/time.js';
import { countWords } from './wordcloud.js';

/**
 * 群运营洞察：把「原始统计数字」翻译成「运营能直接行动的信息」。
 *
 * 与 report.js 的分工：
 * - report.js 回答「这个群有多少消息、谁在说话」（事实层）
 * - 这里回答「谁不说话了、话题在变热还是变冷、我们是不是在误伤自己人」（判断层）
 *
 * 全部基于已有的明细表实时计算，不引入新的聚合表——
 * 群消息量级（万到十万行）撑得住，而新增一张聚合表就要处理补算与口径对齐，
 * 换来的只是毫秒级查询差异。
 */

/**
 * 沉默成员：曾经活跃、最近 N 天不再发言的人。
 *
 * 这是群运营最想知道的一件事——「谁悄悄走了」。
 * 活跃榜只能看到还在说话的人，而一个群的真实流失信号在「不说话的人」身上。
 *
 * @param {object} opts
 * @param {number} [opts.silentDays] 多少天内无发言算沉默，默认 14
 * @param {number} [opts.minMessages] 历史累计发言下限，默认 10（过滤掉只冒过一两次泡的人）
 * @param {number} [opts.limit] 返回上限
 */
export function findSilentMembers(storage, groupId, { now = Date.now(), silentDays = 14, minMessages = 10, limit = 20 } = {}) {
  const rows = storage.members.list(groupId, 1000);
  const threshold = now - silentDays * DAY;
  return rows
    .filter((m) => m.message_count >= minMessages && m.last_seen < threshold)
    .map((m) => ({
      userId: m.user_id,
      nickname: m.nickname || m.user_id,
      messageCount: m.message_count,
      lastSeen: m.last_seen,
      silentMs: now - m.last_seen,
      silentText: formatDuration(now - m.last_seen),
    }))
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, limit);
}

export function renderSilentText(rows, { silentDays = 14, groupId = '' } = {}) {
  if (rows.length === 0) return `✅ ${silentDays} 天内没有「沉默的活跃成员」——大家都在正常说话`;
  return [
    `😶 沉默成员（累计发言 ≥10 条，但 ${silentDays} 天未发言）`,
    ...rows.map((r) => `· ${r.nickname} — 累计 ${r.messageCount} 条，已沉默 ${r.silentText}`),
    '',
    `共 ${rows.length} 人。沉默越久、历史发言越多，流失的可能性越高。`,
  ].join('\n');
}

/**
 * 话题趋势：对比两个等长周期的词频，给出「变热」与「变冷」的词。
 *
 * 比单张词云有用得多的地方在于「趋势」：词云只能说「排位出现 50 次」，
 * 而趋势能说「排位比上周冷了 60%」——后者才是需要有人回应的信号。
 *
 * 用「占比」而不是「绝对次数」比较：群整体消息量波动很大（节假日翻倍），
 * 直接比次数会把「群变活跃」误读成「这个话题变热」。
 */
export function compareTopicTrend(storage, groupId, { now = Date.now(), windowDays = 7, top = 8, minCount = 2 } = {}) {
  const span = windowDays * DAY;
  const currentStart = now - span;
  const previousStart = currentStart - span;

  const currentRows = storage.messages.recentWindow(groupId, currentStart, now + 1, 5000);
  const previousRows = storage.messages.recentWindow(groupId, previousStart, currentStart, 5000);

  const currentTotal = currentRows.length;
  const previousTotal = previousRows.length;

  const currentWords = new Map(countWords(currentRows.map((r) => r.text), { top: 200, minCount }).map((w) => [w.word, w.count]));
  const previousWords = new Map(countWords(previousRows.map((r) => r.text), { top: 200, minCount }).map((w) => [w.word, w.count]));

  // 占比：把绝对次数除以周期内消息数，得到该词在语料中的密度
  const share = (count, total) => (total === 0 ? 0 : count / total);
  const words = new Set([...currentWords.keys(), ...previousWords.keys()]);

  const trends = [];
  for (const word of words) {
    const cCount = currentWords.get(word) ?? 0;
    const pCount = previousWords.get(word) ?? 0;
    // 新词（上期没有）用 0 作基数无法算比例，单独标成 rising-new
    const cShare = share(cCount, currentTotal);
    const pShare = share(pCount, previousTotal);
    let ratio = null;
    if (pShare > 0) ratio = cShare / pShare;
    else if (cShare > 0) ratio = Number.POSITIVE_INFINITY;

    trends.push({
      word,
      currentCount: cCount,
      previousCount: pCount,
      currentShare: cShare,
      previousShare: pShare,
      ratio,
      isNew: pCount === 0 && cCount > 0,
      isGone: cCount === 0 && pCount > 0,
    });
  }

  const heated = trends
    .filter((t) => !t.isNew && t.ratio !== null && t.ratio >= 1.5 && t.currentCount >= minCount)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, top);
  const cooled = trends
    .filter((t) => !t.isGone && t.ratio !== null && t.ratio <= 0.5 && t.previousCount >= minCount)
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, top);
  const fresh = trends.filter((t) => t.isNew && t.currentCount >= minCount).sort((a, b) => b.currentCount - a.currentCount).slice(0, top);
  const gone = trends.filter((t) => t.isGone && t.previousCount >= minCount).sort((a, b) => b.previousCount - a.previousCount).slice(0, top);

  return {
    windowDays,
    currentTotal,
    previousTotal,
    heated,
    cooled,
    fresh,
    gone,
    volumeDelta: previousTotal === 0 ? null : (currentTotal - previousTotal) / previousTotal,
  };
}

export function renderTrendText(trend) {
  const pct = (r) => (Number.isFinite(r) ? `${r >= 1 ? '+' : ''}${Math.round((r - 1) * 100)}%` : '新出现');
  const lines = [`📈 话题趋势（近 ${trend.windowDays} 天 vs 前 ${trend.windowDays} 天）`];
  if (trend.volumeDelta !== null) {
    const d = Math.round(trend.volumeDelta * 100);
    lines.push(`消息量：${trend.currentTotal} 条（环比 ${d >= 0 ? '+' : ''}${d}%）`);
  } else {
    lines.push(`消息量：${trend.currentTotal} 条（上一周期无数据，无法对比）`);
  }

  if (trend.heated.length) {
    lines.push('', '🔥 变热', ...trend.heated.map((t) => `· ${t.word} ${pct(t.ratio)}（${t.previousCount} → ${t.currentCount}）`));
  }
  if (trend.fresh.length) {
    lines.push('', '🆕 新话题', ...trend.fresh.map((t) => `· ${t.word}（${t.currentCount} 次）`));
  }
  if (trend.cooled.length) {
    lines.push('', '🧊 变冷', ...trend.cooled.map((t) => `· ${t.word} ${pct(t.ratio)}（${t.previousCount} → ${t.currentCount}）`));
  }
  if (trend.gone.length) {
    lines.push('', '💤 已消失', ...trend.gone.map((t) => `· ${t.word}（上期 ${t.previousCount} 次，本期未出现）`));
  }
  if (trend.heated.length + trend.fresh.length + trend.cooled.length + trend.gone.length === 0) {
    lines.push('', '两个周期的话题分布基本一致，没有明显升降。');
  }
  return lines.join('\n');
}

/**
 * 新成员观察：入群不久、尚未确认是「正常成员还是广告号」的人。
 *
 * 结合 first_seen（入群时间，由 markJoined 写入）与发言量：
 * 入群超 3 天却一句话没说的人，与入群当天就发广告的人，风险画像完全不同，
 * 分开列出比混在一个「新成员」列表里更有用。
 */
export function listNewcomers(storage, groupId, { now = Date.now(), days = 7, limit = 30 } = {}) {
  const since = now - days * DAY;
  const rows = storage.members.list(groupId, 1000);
  return rows
    .filter((m) => m.first_seen >= since)
    .map((m) => {
      const ageMs = now - m.first_seen;
      return {
        userId: m.user_id,
        nickname: m.nickname || m.user_id,
        firstSeen: m.first_seen,
        messageCount: m.message_count,
        ageText: formatDuration(ageMs),
        // 入群超过 3 天仍零发言：要么是潜水新成员，要么是挂机号
        isQuiet: ageMs > 3 * DAY && m.message_count === 0,
      };
    })
    .sort((a, b) => b.firstSeen - a.firstSeen)
    .slice(0, limit);
}

export function renderNewcomersText(rows, { days = 7 } = {}) {
  if (rows.length === 0) return `近 ${days} 天没有新成员入群记录`;
  const quiet = rows.filter((r) => r.isQuiet);
  const lines = [`🆕 近 ${days} 天新成员 ${rows.length} 人`];
  lines.push(...rows.map((r) => `· ${r.nickname}（入群 ${r.ageText}${r.messageCount > 0 ? `，发言 ${r.messageCount} 条` : '，尚未发言'}）`));
  if (quiet.length > 0) {
    lines.push('', `⚠️ 其中 ${quiet.length} 人入群超 3 天仍无发言，可考虑清理或主动引导`);
  }
  return lines.join('\n');
}

/**
 * 规则命中效果评估：哪些规则在真的拦东西，哪些从来没命中过。
 *
 * 长期运行的群会积累一堆「当时觉得有用」的规则，其中大部分事后从没触发过。
 * 没人会主动去删，它们只会留在库里——直到某天一条写坏的正则误伤了正常聊天，
 * 而所有人都想不起来这条规则是什么时候加的。
 */
export function auditRules(storage, groupId, { limit = 50 } = {}) {
  const rules = storage.rules.list(groupId).slice(0, limit);
  return rules.map((r) => ({
    id: r.id,
    type: r.type,
    pattern: r.pattern,
    action: r.action,
    enabled: r.enabled,
    hitCount: r.hitCount,
    createdAt: r.createdAt,
    // 从未命中的已启用规则是「待复核」的主要候选
    suspect: r.enabled && r.hitCount === 0,
  }));
}

export function renderRuleAuditText(rows) {
  if (rows.length === 0) return '当前没有自定义规则，内置检测器始终生效。';
  const suspect = rows.filter((r) => r.suspect);
  const lines = [`🧪 规则效果（共 ${rows.length} 条）`];
  lines.push(
    ...rows.map((r) => `#${r.id} [${r.type}] ${r.pattern} → ${r.action}｜命中 ${r.hitCount} 次${r.enabled ? '' : '（已停用）'}`),
  );
  if (suspect.length > 0) {
    lines.push('', `⚠️ ${suspect.length} 条启用中的规则从未命中过，建议复核是否写错了模式：`);
    lines.push(...suspect.map((r) => `· #${r.id} ${r.pattern}`));
  }
  return lines.join('\n');
}

/** 群活跃度总览：一屏回答「这个群现在怎么样」。 */
export function summarizeActivity(storage, groupId, { now = Date.now() } = {}) {
  const daySince = startOfDay(now);
  const weekSince = startOfWeek(now);
  const monthSince = startOfMonth(now);

  const today = storage.messages.countSince(groupId, daySince, now + 1);
  const week = storage.messages.countSince(groupId, weekSince, now + 1);
  const month = storage.messages.countSince(groupId, monthSince, now + 1);
  // 成员总数要用 COUNT，不能拿 list(limit) 的长度：
  // list 是「按发言数排序取前 N 个」，传 1 得到的是「1 个成员」而不是「成员总数」，
  // 于是活跃占比会被算成 100%（任何分母为 1 的比例都是 100%），
  // 僵尸群会被判断成「活跃度良好」—— 这条判断恰好是它唯一的作用。
  const members = storage.members.countInGroup(groupId);
  const active = storage.messages.distinctActiveUsers(groupId, weekSince, now + 1);

  return {
    today,
    week,
    month,
    members,
    weeklyActive: active,
    // 周活跃占成员的比重：群越大越难高，低于 10% 基本就是「僵尸群」
    vitality: members === 0 ? 0 : active / members,
  };
}

export function renderActivityText(s, { groupId = '' } = {}) {
  const pct = Math.round(s.vitality * 100);
  const advice =
    s.vitality === 0
      ? '本周还没有人发言，确认机器人是否在线或群是否已废弃'
      : s.vitality < 0.1
        ? '周活跃占成员比例偏低，群可能已进入沉默期'
        : s.vitality < 0.3
          ? '活跃度中等，维持现有话题节奏即可'
          : '活跃度良好';
  return [
    `💡 群 ${groupId} 活跃总览`,
    `今日 ${s.today} 条｜本周 ${s.week} 条｜本月 ${s.month} 条`,
    `本周活跃 ${s.weeklyActive} 人 / 记录成员 ${s.members} 人（${pct}%）`,
    `判断：${advice}`,
  ].join('\n');
}
