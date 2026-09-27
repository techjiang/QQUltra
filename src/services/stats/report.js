import { startOfDay, startOfWeek, startOfMonth, hourKey, weekdayKey, formatDuration } from '../../utils/time.js';

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export const PERIODS = {
  today: { label: '今日', start: (now) => startOfDay(now) },
  week: { label: '本周', start: (now) => startOfWeek(now) },
  month: { label: '本月', start: (now) => startOfMonth(now) },
  all: { label: '全部', start: () => 0 },
};

export const PERIOD_NAMES = Object.keys(PERIODS);

/** 中文与常见缩写归一化，让 /stats 本周、/rank 周 都能用。 */
const PERIOD_ALIASES = {
  all: 'all',
  全部: 'all',
  总: 'all',
  累计: 'all',
  day: 'today',
  now: 'today',
  今: 'today',
  week: 'week',
  周: 'week',
  本周: 'week',
  这周: 'week',
  month: 'month',
  月: 'month',
  本月: 'month',
  这个月: 'month',
};

/**
 * 周期解析。
 * 非法周期不再抛异常：异常会被上层渲染成「指令执行失败：...」，
 * 对群成员来说这是恐吓式的提示，直接返回带正确用法的错误更友好。
 */
export function resolvePeriod(period = 'today', now = Date.now()) {
  const key = PERIOD_ALIASES[String(period).toLowerCase()] ?? String(period);
  const spec = PERIODS[key];
  if (!spec) {
    const err = new Error(`未知统计周期「${period}」，可选：${PERIOD_NAMES.join(' / ')}`);
    err.expected = true;
    throw err;
  }
  period = key;
  // until 取右开区间上界：+1 让「本毫秒内刚落库的消息」也算进本期。
  // 否则刚发的消息与查询同处一毫秒时会被排除，表现为统计偶发少一条。
  return { key: period, label: spec.label, since: spec.start(now), until: now + 1 };
}

/**
 * 生成群聊统计报告。数字全部从明细表实时聚合——
 * 群消息量级（万到十万行）完全撑得住，预聚合表带来的口径不一致风险
 * 远大于这点查询开销。
 */
export function buildGroupReport(storage, groupId, { period = 'today', top = 10, now = Date.now() } = {}) {
  const { label, since, until } = resolvePeriod(period, now);

  const total = storage.messages.countSince(groupId, since, until);
  const activeUsers = storage.messages.distinctActiveUsers(groupId, since, until);
  const ranking = storage.messages.countByUser(groupId, since, until);
  const prev = storage.messages.prevPeriodStats(groupId, since, until);

  const buckets = storage.messages.activityBuckets(groupId, since, until);
  const hourly = Array.from({ length: 24 }, () => 0);
  const weekly = Array.from({ length: 7 }, () => 0);
  for (const row of buckets) {
    hourly[hourKey(row.created_at)] += 1;
    weekly[weekdayKey(row.created_at)] += 1;
  }

  const peakHour = topIndex(hourly);
  const peakWeekday = topIndex(weekly);
  const delta = prev.total === 0 ? null : (total - prev.total) / prev.total;

  return {
    groupId: String(groupId),
    period: { key: period, label, since, until },
    total,
    activeUsers,
    avgPerUser: activeUsers === 0 ? 0 : Number((total / activeUsers).toFixed(2)),
    topUsers: ranking.slice(0, top).map((row, i) => ({
      rank: i + 1,
      userId: row.user_id,
      nickname: row.nickname || row.user_id,
      count: row.count,
      share: total === 0 ? 0 : Number((row.count / total).toFixed(4)),
      firstAt: row.first_at,
      lastAt: row.last_at,
    })),
    peak: {
      hour: peakHour.index,
      hourCount: peakHour.value,
      weekday: peakWeekday.index,
      weekdayName: WEEKDAYS[peakWeekday.index],
      weekdayCount: peakWeekday.value,
    },
    distribution: { hourly, weekly },
    comparison: {
      previousTotal: prev.total,
      previousUsers: prev.users,
      totalDelta: delta,
      totalDeltaText: delta === null ? '无对比数据' : `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`,
    },
    generatedAt: now,
  };
}

function topIndex(arr) {
  let index = 0;
  let value = -1;
  arr.forEach((v, i) => {
    if (v > value) {
      value = v;
      index = i;
    }
  });
  return { index, value: Math.max(value, 0) };
}

export function renderReportText(report) {
  const lines = [];
  lines.push(`📊 群 ${report.groupId} · ${report.period.label}统计`);
  lines.push(`总消息 ${report.total} 条 | 活跃成员 ${report.activeUsers} 人 | 人均 ${report.avgPerUser} 条`);
  if (report.comparison.totalDelta !== null) {
    lines.push(`较上一周期：${report.comparison.totalDeltaText}（上期 ${report.comparison.previousTotal} 条）`);
  }
  if (report.total > 0) {
    lines.push(`活跃高峰：${report.peak.weekdayName} ${String(report.peak.hour).padStart(2, '0')}:00（${report.peak.hourCount} 条）`);
  }
  if (report.topUsers.length) {
    lines.push('');
    lines.push('🏆 活跃榜');
    for (const u of report.topUsers) {
      lines.push(`${u.rank}. ${u.nickname} — ${u.count} 条 (${(u.share * 100).toFixed(1)}%)`);
    }
  } else {
    lines.push('');
    lines.push('该周期暂无消息记录');
  }
  return lines.join('\n');
}

export function buildMemberProfile(storage, groupId, userId, { now = Date.now() } = {}) {
  const member = storage.members.get(groupId, userId);
  const daySince = startOfDay(now);
  const weekSince = startOfWeek(now);
  const monthSince = startOfMonth(now);

  const countIn = (since) =>
    storage.messages.countByUser(groupId, since, now).find((r) => String(r.user_id) === String(userId))?.count ?? 0;

  const dayCount = countIn(daySince);
  const weekCount = countIn(weekSince);
  const monthCount = countIn(monthSince);

  if (!member && dayCount === 0 && weekCount === 0 && monthCount === 0) return null;

  const lastSeen = member?.last_seen ?? now;
  return {
    groupId: String(groupId),
    userId: String(userId),
    nickname: member?.nickname || String(userId),
    total: member?.message_count ?? monthCount,
    today: dayCount,
    week: weekCount,
    month: monthCount,
    firstSeen: member?.first_seen ?? null,
    lastSeen,
    silenceSpan: formatDuration(now - lastSeen),
    violations: storage.violations.countByUser(groupId, userId, 0),
  };
}

export function renderMemberText(profile) {
  return [
    `👤 ${profile.nickname}（${profile.userId}）`,
    `累计发言 ${profile.total} 条 | 今日 ${profile.today} | 本周 ${profile.week} | 本月 ${profile.month}`,
    `最后发言：${profile.silenceSpan}前`,
    `违规记录：${profile.violations} 次`,
  ].join('\n');
}
