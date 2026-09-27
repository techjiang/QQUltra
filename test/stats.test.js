import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeStorage, makeBot } from './helpers.js';
import { buildGroupReport, buildMemberProfile, renderReportText, resolvePeriod } from '../src/services/stats/report.js';
import { DAY, startOfDay } from '../src/utils/time.js';

/**
 * 注入固定分布的消息：a=5 b=3 c=1，共 9 条。
 *
 * base 默认取「当天正午」而非 Date.now()——用 now 附近的时刻做基准，
 * 在深夜或月初跑测试时会把消息推到前一天/上一月，导致「今日/本月」断言随机失败。
 */
function seed(storage, { groupId = '9527', base = null } = {}) {
  storage.groups.ensure(groupId);
  // 锚在当天 00:00 之后的一小段时间内，保证 past-anchored 且不会跨天
  const at = base ?? startOfDay(Date.now()) + 1_000;
  const rows = [
    { userId: 'a', nickname: '阿离', count: 5 },
    { userId: 'b', nickname: '扫地僧', count: 3 },
    { userId: 'c', nickname: '路人甲', count: 1 },
  ];
  for (const { userId, nickname, count } of rows) {
    for (let i = 0; i < count; i += 1) {
      const ts = at + i * 1000;
      storage.messages.insert({ groupId, userId, nickname, text: `${nickname} 说第 ${i} 句`, segments: [], timestamp: ts });
      storage.members.upsert({ groupId, userId, nickname, timestamp: ts });
    }
  }
  return rows;
}

describe('群聊统计', () => {
  test('周期解析覆盖 today/week/month/all', () => {
    const now = Date.now();
    assert.equal(resolvePeriod('today', now).since, startOfDay(now));
    assert.equal(resolvePeriod('all', now).since, 0);
    assert.throws(() => resolvePeriod('季度', now), /未知统计周期/);
  });

  test('总数、活跃人数、人均口径一致', () => {
    const storage = makeStorage();
    seed(storage);
    const report = buildGroupReport(storage, '9527', { period: 'all' });
    assert.equal(report.total, 9);
    assert.equal(report.activeUsers, 3);
    assert.equal(report.avgPerUser, 3);
    storage.close();
  });

  test('排名与占比正确且降序', () => {
    const storage = makeStorage();
    seed(storage);
    const { topUsers } = buildGroupReport(storage, '9527', { period: 'all' });
    assert.deepEqual(topUsers.map((u) => u.nickname), ['阿离', '扫地僧', '路人甲']);
    assert.equal(topUsers[0].count, 5);
    assert.equal(topUsers[0].share, Number((5 / 9).toFixed(4)));
    assert.equal(topUsers.reduce((s, u) => s + u.count, 0), 9);
    storage.close();
  });

  test('top 参数限制返回条数', () => {
    const storage = makeStorage();
    seed(storage);
    assert.equal(buildGroupReport(storage, '9527', { period: 'all', top: 2 }).topUsers.length, 2);
    storage.close();
  });

  test('空群返回零值而不是报错', () => {
    const storage = makeStorage();
    const report = buildGroupReport(storage, '8888', { period: 'today' });
    assert.equal(report.total, 0);
    assert.equal(report.activeUsers, 0);
    assert.equal(report.avgPerUser, 0);
    assert.deepEqual(report.topUsers, []);
    assert.match(renderReportText(report), /暂无消息记录/);
    storage.close();
  });

  test('环比按等长上一周期对比', () => {
    const storage = makeStorage();
    const now = Date.now();
    const todayStart = startOfDay(now);
    const span = now - todayStart; // 本期已过去的时长

    storage.groups.ensure('9527');
    // 本期 2 条，紧邻的等长上期 4 条 → -50%
    for (let i = 0; i < 2; i += 1) storage.messages.insert({ groupId: '9527', userId: 'a', text: 'x', segments: [], timestamp: todayStart + i });
    for (let i = 0; i < 4; i += 1) storage.messages.insert({ groupId: '9527', userId: 'a', text: 'x', segments: [], timestamp: todayStart - span + i });

    const report = buildGroupReport(storage, '9527', { period: 'today', now });
    assert.equal(report.comparison.previousTotal, 4);
    assert.equal(report.comparison.totalDelta, -0.5);
    assert.equal(report.comparison.totalDeltaText, '-50.0%');
    storage.close();
  });

  test('无上一周期数据时环比标注为无对比数据', () => {
    const storage = makeStorage();
    seed(storage);
    assert.equal(buildGroupReport(storage, '9527', { period: 'today' }).comparison.totalDeltaText, '无对比数据');
    storage.close();
  });

  test('活跃时段分布落进对应小时桶', () => {
    const storage = makeStorage();
    const base = new Date(2026, 8, 23, 14, 0, 0).getTime(); // 周三 14 点
    storage.groups.ensure('9527');
    for (let i = 0; i < 3; i += 1) storage.messages.insert({ groupId: '9527', userId: 'a', text: 'x', segments: [], timestamp: base + i * 1000 });

    // now 必须晚于注入的消息，否则 until 边界会把数据切掉
    const report = buildGroupReport(storage, '9527', { period: 'all', now: base + 10_000 });
    assert.equal(report.distribution.hourly[14], 3);
    assert.equal(report.peak.hour, 14);
    assert.equal(report.peak.weekday, 2, '2026-09-23 是周三');
    assert.equal(report.peak.weekdayName, '周三');
    storage.close();
  });

  test('成员档案聚合今日/本周/本月与违规数', () => {
    const storage = makeStorage();
    seed(storage);
    storage.violations.add({ groupId: '9527', userId: 'a', kind: 'flood', detail: 'x' });
    const profile = buildMemberProfile(storage, '9527', 'a');
    assert.equal(profile.nickname, '阿离');
    assert.equal(profile.total, 5);
    assert.equal(profile.today, 5);
    assert.equal(profile.violations, 1);
    storage.close();
  });

  test('无记录成员返回 null', () => {
    const storage = makeStorage();
    assert.equal(buildMemberProfile(storage, '9527', 'ghost'), null);
    storage.close();
  });

  test('机器人自身消息不计入统计', async () => {
    const { bot, storage, adapter } = await makeBot();
    await bot.inject({ groupId: '9527', userId: 'a', nickname: '阿离', text: '人说的话' });
    await bot.inject({ groupId: '9527', userId: adapter.selfId, nickname: 'QQUltra', text: '机器人自己的话' });
    assert.equal(buildGroupReport(storage, '9527', { period: 'all' }).total, 1);
    assert.equal(storage.members.get('9527', adapter.selfId), null);
    storage.close();
  });

  test('私聊消息不进群统计', async () => {
    const { bot, storage } = await makeBot();
    await bot.inject({ groupId: null, userId: 'a', text: '私聊内容' });
    assert.equal(buildGroupReport(storage, '9527', { period: 'all' }).total, 0);
    storage.close();
  });

  test('/stats 指令产出可读报告', async () => {
    const { bot, storage, adapter } = await makeBot();
    seed(storage);
    await bot.inject({ groupId: '9527', userId: 'a', nickname: '阿离', text: '/stats --period=all' });
    const reply = adapter.lastReply();
    assert.match(reply, /群 9527/);
    assert.match(reply, /阿离/);
    assert.match(reply, /活跃榜/);
    storage.close();
  });

  test('/rank 无数据时给出友好提示', async () => {
    const { bot, storage, adapter } = await makeBot();
    await bot.inject({ groupId: '9527', userId: 'a', text: '/rank' });
    assert.match(adapter.lastReply(), /暂无发言记录/);
    storage.close();
  });

  test('停用统计的群不再采集', async () => {
    const { bot, storage } = await makeBot();
    storage.groups.setSetting('9527', 'stats', { enabled: false });
    await bot.inject({ groupId: '9527', userId: 'a', text: '不该被统计' });
    assert.equal(buildGroupReport(storage, '9527', { period: 'all' }).total, 0);
    storage.close();
  });
});
