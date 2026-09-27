import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeBot } from './helpers.js';
import { buildGroupReport } from '../src/services/stats/report.js';
import { runRetention } from '../src/index.js';

/**
 * 端到端：一条消息从进入适配器到被统计、检测、回复，走完整条流水线。
 * 这些用例是「改动是否破坏主链路」的最后一道闸。
 */
describe('端到端主链路', () => {
  const at = (text) => [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text } }];

  test('普通消息：入库 → 进活跃榜', async () => {
    const { bot, storage, adapter } = await makeBot();
    await bot.inject({ groupId: '9527', userId: '20001', nickname: '阿离', text: '早上好' });

    assert.equal(buildGroupReport(storage, '9527', { period: 'all' }).total, 1);
    assert.equal(adapter.outbox.length, 0, '普通消息不应触发回复');
    storage.close();
  });

  test('违规消息：命中 → 处置 → 通知 → 留痕，四件事都发生', async () => {
    const { bot, storage, adapter } = await makeBot();
    await bot.inject({ groupId: '9527', userId: '20009', nickname: '卖茶小妹', text: '加我微信 abc12345，兼职日结' });

    assert.ok(adapter.actions.some((a) => a.action === 'set_group_kick'), '① 执行处置');
    assert.ok(adapter.outbox.some((m) => /移出本群/.test(m.message)), '② 群内通知');
    assert.ok(storage.violations.recent('9527').length > 0, '③ 违规留痕');
    assert.equal(buildGroupReport(storage, '9527', { period: 'all' }).total, 1, '④ 仍进入统计');
    storage.close();
  });

  test('指令消息不触发检测也不进活跃榜', async () => {
    const { bot, storage, adapter } = await makeBot();
    storage.rules.add({ groupId: '9527', type: 'keyword', pattern: '/stats', action: 'kick' });

    await bot.inject({ groupId: '9527', userId: '20001', nickname: '阿离', text: '/stats' });
    assert.equal(adapter.actions.filter((a) => a.action === 'set_group_kick').length, 0);
    assert.equal(buildGroupReport(storage, '9527', { period: 'all' }).total, 0);
    storage.close();
  });

  test('AI 回复同样触发检测（不豁免机器人触发的对话）', async () => {
    const { makeBot: make } = await import('./helpers.js');
    const storage = (await make()).storage;
    const { bot, adapter } = await make({
      storage,
      aiProvider: { chat: async () => ({ content: 'ok' }) },
      config: { ai: { enabled: true, apiKey: 'sk-t' } },
    });

    await bot.inject({ groupId: '9527', userId: '20001', nickname: '阿离', text: '帮我看看', segments: at('帮我看看') });
    assert.equal(adapter.outbox.length, 1);
    assert.equal(adapter.lastReply(), 'ok');
    storage.close();
  });

  test('一次刷屏算一次违规，不被折叠成多条处罚', async () => {
    const { bot, storage, adapter } = await makeBot();
    for (let i = 0; i < 9; i += 1) {
      await bot.inject({ groupId: '9527', userId: '20003', nickname: '刷屏者', text: `灌水 ${i}` });
    }
    const punished = adapter.actions.filter((a) => ['set_group_ban', 'set_group_kick'].includes(a.action));
    assert.equal(punished.length, 1, '同一事件窗口内只应处置一次');
    assert.equal(storage.violations.countPunished('9527', '20003', 0), 1);
    storage.close();
  });

  test('多次独立违规按阶梯升级，第 5 次从禁言升到踢出', async () => {
    const { bot, storage, adapter } = await makeBot();
    const actions = [];

    for (let round = 0; round < 5; round += 1) {
      adapter.actions.length = 0;
      for (let i = 0; i < 9; i += 1) {
        await bot.inject({ groupId: '9527', userId: '20003', nickname: '刷屏者', text: `灌水 ${round}-${i}` });
      }
      actions.push(adapter.actions.filter((a) => ['set_group_ban', 'set_group_kick'].includes(a.action)).at(-1)?.action ?? 'none');

      // 把本轮处罚时间推到事件窗口之外，模拟「下一次独立违规」
      storage.db.run("UPDATE violations SET created_at = created_at - 120000 WHERE kind = 'punish' AND user_id = '20003'");
    }

    assert.deepEqual(actions, ['set_group_ban', 'set_group_ban', 'set_group_ban', 'set_group_ban', 'set_group_kick']);
    storage.close();
  });

  test('多群数据互相隔离', async () => {
    const { bot, storage } = await makeBot();
    await bot.inject({ groupId: '9527', userId: '20001', nickname: '阿离', text: '在 A 群' });
    await bot.inject({ groupId: '8888', userId: '20002', nickname: '扫地僧', text: '在 B 群' });

    assert.equal(buildGroupReport(storage, '9527', { period: 'all' }).total, 1);
    assert.equal(buildGroupReport(storage, '8888', { period: 'all' }).total, 1);
    assert.equal(buildGroupReport(storage, '9527', { period: 'all' }).topUsers[0].nickname, '阿离');
    storage.close();
  });

  test('处理链路中单条消息异常不影响后续消息', async () => {
    const { bot, storage, adapter } = await makeBot();
    // 注入一条会被检测器内部处理的坏消息（segments 非法），再发一条正常消息
    await bot.inject({ groupId: '9527', userId: '20001', nickname: '阿离', text: '', segments: null });
    await bot.inject({ groupId: '9527', userId: '20002', nickname: '扫地僧', text: '/ping' });

    assert.match(adapter.lastReply(), /pong/);
    storage.close();
  });

  test('保留策略清理过期明细但保留近期数据', async () => {
    const { bot, storage } = await makeBot();
    const old = Date.now() - 30 * 86400_000;
    storage.groups.ensure('9527');
    for (let i = 0; i < 4; i += 1) {
      storage.messages.insert({ groupId: '9527', userId: 'a', text: 'old', segments: [], timestamp: old + i });
    }
    await bot.inject({ groupId: '9527', userId: '20001', nickname: '阿离', text: '新消息' });

    const result = runRetention(storage, { retentionDays: 7 });
    assert.equal(result.messages, 4);
    assert.equal(storage.messages.countAllSince('9527', 0), 1);
    storage.close();
  });

  test('机器人自身消息即使注入也不计入统计', async () => {
    const { bot, storage, adapter } = await makeBot();
    await bot.inject({ groupId: '9527', userId: adapter.selfId, nickname: 'QQUltra', text: '我是机器人' });
    assert.equal(buildGroupReport(storage, '9527', { period: 'all' }).total, 0);
    storage.close();
  });
});
