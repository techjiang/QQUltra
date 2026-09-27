import { startOfDay, formatDuration, DAY } from '../../utils/time.js';

/**
 * 巡检与简报：把「需要人主动问」变成「机器人主动报」。
 *
 * 群聊机器人的真实死法是静默失效——掉线、权限被撤、检测全关，
 * 群里看不出任何异常，直到某天发现统计里少了半个月数据。
 * 因此这里把健康状态做成可判定的结构化结果，既能被定时任务用，
 * 也能被 /status 直接渲染。
 */

export const HEALTH_LEVELS = { OK: 'ok', WARN: 'warn', BAD: 'bad' };

/**
 * 群维度健康自检。
 * @returns {{ level: string, checks: {name:string, level:string, detail:string}[] }}
 */
export function inspectGroupHealth({ storage, groupId, now = Date.now(), lastReadyAt = null, adapterName = 'unknown' } = {}) {
  const checks = [];
  const group = storage.groups.get(groupId);
  const settings = group ? { ...group.settings } : {};

  // 1. 群是否被停用
  if (group && group.enabled === false) {
    checks.push({ name: '群状态', level: HEALTH_LEVELS.BAD, detail: '本群已被停用，机器人不处理任何消息' });
  } else {
    checks.push({ name: '群状态', level: HEALTH_LEVELS.OK, detail: '正常运行' });
  }

  // 2. 最近是否有数据流入（没数据 ≠ 没事，可能是群冷或掉线）
  const since = now - 24 * 3600_000;
  const total24h = storage.messages.countAllSince(groupId, since, now + 1);
  if (total24h === 0) {
    checks.push({ name: '数据流入', level: HEALTH_LEVELS.WARN, detail: '近 24 小时无任何消息入库，确认群是否活跃或连接是否正常' });
  } else {
    checks.push({ name: '数据流入', level: HEALTH_LEVELS.OK, detail: `近 24 小时入库 ${total24h} 条` });
  }

  // 3. 检测是否被整体关掉（最容易发生也最难发现的配置事故）
  const detectConfig = settings.detect ?? {};
  if (detectConfig.enabled === false) {
    checks.push({ name: '自动检测', level: HEALTH_LEVELS.WARN, detail: '本群自动检测已关闭，垃圾信息不会被拦截' });
  } else {
    const punishOff = detectConfig.punish?.enabled === false;
    checks.push({
      name: '自动检测',
      level: punishOff ? HEALTH_LEVELS.WARN : HEALTH_LEVELS.OK,
      detail: punishOff ? '检测开启但处罚关闭，只记录不处置' : '检测与处罚均开启',
    });
  }

  // 4. 连接新鲜度：协议端掉线后 ready 时间戳会变旧
  if (lastReadyAt) {
    const idle = now - lastReadyAt;
    const level = idle > 6 * 3600_000 ? HEALTH_LEVELS.BAD : idle > 3600_000 ? HEALTH_LEVELS.WARN : HEALTH_LEVELS.OK;
    checks.push({ name: '连接', level, detail: `最近一次就绪 ${formatDuration(idle)}前（适配器 ${adapterName}）` });
  } else {
    checks.push({ name: '连接', level: HEALTH_LEVELS.WARN, detail: '尚无就绪记录，可能是首次启动' });
  }

  // 5. 数据保留策略是否覆盖了统计周期。
  // 保留策略没跑过时也要报出来：统计口径和明细口径不一致的根因往往就在这里，
  // 而「没显示这一项」在旧实现里和「不需要这一项」看起来一模一样。
  const retention = storage.kv.get('retention_days', null);
  const lastRun = storage.kv.get('retention_last_run_at', null);
  if (retention !== null && lastRun !== null) {
    const stale = now - lastRun > 36 * 3600_000;
    checks.push({
      name: '数据保留',
      level: stale ? HEALTH_LEVELS.WARN : HEALTH_LEVELS.OK,
      detail: stale ? `明细保留 ${retention} 天，但已超过 36 小时未执行清理` : `明细保留 ${retention} 天（${formatDuration(now - lastRun)}前执行）`,
    });
  } else {
    checks.push({ name: '数据保留', level: HEALTH_LEVELS.WARN, detail: '尚未执行过保留清理，明细会持续增长' });
  }

  const worst = checks.some((c) => c.level === HEALTH_LEVELS.BAD)
    ? HEALTH_LEVELS.BAD
    : checks.some((c) => c.level === HEALTH_LEVELS.WARN)
      ? HEALTH_LEVELS.WARN
      : HEALTH_LEVELS.OK;

  return { level: worst, checks };
}

const LEVEL_ICON = { ok: '✅', warn: '⚠️', bad: '⛔' };

export function renderHealthText({ level, checks }) {
  return [
    `${LEVEL_ICON[level] ?? '•'} 运行自检：${level === 'ok' ? '一切正常' : level === 'warn' ? '有需要留意的地方' : '存在异常'}`,
    ...checks.map((c) => `${LEVEL_ICON[c.level] ?? '•'} ${c.name}：${c.detail}`),
  ].join('\n');
}

/**
 * 昨日简报：给订阅者主动推送的固定格式摘要。
 * 只讲「变化」，不复述 /stats 已有的绝对数字，否则每天一条等于噪音。
 */
export function buildDailyDigest(storage, groupId, { now = Date.now() } = {}) {
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - DAY;

  const yesterday = storage.messages.countSince(groupId, yesterdayStart, todayStart);
  const dayBefore = storage.messages.countSince(groupId, yesterdayStart - DAY, yesterdayStart);
  const users = storage.messages.distinctActiveUsers(groupId, yesterdayStart, todayStart);
  const top = storage.messages.countByUser(groupId, yesterdayStart, todayStart).slice(0, 3);
  // 用窗口查询而不是「取最近 200 条再过滤」：
  // 后者的上限是行数而不是时间，违规多的群会把昨天的记录挤出去，简报少报。
  // 同时排除豁免命中（白名单角色），风控命中数才是真实需要人关注的量。
  const violations = storage.violations.hitsInWindow(groupId, yesterdayStart, todayStart, 500);

  const delta = dayBefore === 0 ? null : Math.round(((yesterday - dayBefore) / dayBefore) * 100);

  const lines = [`📮 昨日简报 · 群 ${groupId}`];
  lines.push(
    `消息 ${yesterday} 条 | 活跃 ${users} 人${delta === null ? '' : ` | 环比 ${delta >= 0 ? '+' : ''}${delta}%`}`,
  );
  if (top.length) lines.push('前三：' + top.map((u, i) => `${i + 1}.${u.nickname || u.user_id}(${u.count})`).join(' '));
  lines.push(`风控：命中 ${violations.length} 次${violations.length ? `（${[...new Set(violations.map((v) => v.kind))].join('/')}）` : ''}`);
  return { text: lines.join('\n'), stats: { yesterday, dayBefore, users, violations: violations.length, delta } };
}

/**
 * 异常预警判定：短时间内违规激增才提醒，避免每条违规都打扰管理员。
 * @returns {{ triggered: boolean, reason: string, count: number }}
 */
export function evaluateAlert({ storage, groupId, now = Date.now(), windowMs = 10 * 60_000, threshold = 5 }) {
  const since = now - windowMs;
  // 排除豁免命中与 punish 摘要，且窗口过滤交给 SQL：
  // 先取最近 500 条再过滤，等于让「最近 500 条里有多少落在窗口内」决定结果，
  // 群里有历史违规时窗口内的新违规会被挤掉，预警该响的时候不响。
  const hits = storage.violations.hitsInWindow(groupId, since, now + 1, 500);
  if (hits.length < threshold) return { triggered: false, reason: '', count: hits.length };

  const byKind = {};
  for (const h of hits) byKind[h.kind] = (byKind[h.kind] ?? 0) + 1;
  const topKind = Object.entries(byKind).sort((a, b) => b[1] - a[1])[0];
  return {
    triggered: true,
    count: hits.length,
    reason: `最近 ${Math.round(windowMs / 60_000)} 分钟命中 ${hits.length} 次违规，主要类型：${topKind[0]}（${topKind[1]} 次）`,
  };
}
