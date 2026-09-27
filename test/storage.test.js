import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeStorage } from './helpers.js';

const msg = (over = {}) => ({
  groupId: '9527',
  userId: '20001',
  nickname: '阿离',
  role: 'member',
  text: 'hello',
  segments: [{ type: 'text', data: { text: 'hello' } }],
  timestamp: Date.now(),
  isCommand: false,
  ...over,
});

describe('存储层', () => {
  test('迁移可重复执行且幂等', async () => {
    const storage = makeStorage();
    const { migrate } = await import('../src/storage/migrations.js');
    const first = migrate(storage.db);
    const second = migrate(storage.db);
    assert.equal(first, 0, '建库时已迁移过，此处应无待执行迁移');
    assert.equal(second, 0);
    storage.close();
  });

  test('undefined 绑定参数归一为 null 而不是抛错', () => {
    const storage = makeStorage();
    // node:sqlite 对 undefined 会抛 "cannot be bound"，入口必须归一
    assert.doesNotThrow(() => {
      storage.violations.add({ groupId: '1', userId: '2', ruleId: undefined, kind: 'k', detail: undefined, action: undefined });
    });
    const row = storage.db.get('SELECT * FROM violations LIMIT 1');
    assert.equal(row.rule_id, null);
    assert.equal(row.action, null);
    storage.close();
  });

  test('消息明细与成员汇总同事务写入', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    storage.db.transaction(() => {
      storage.messages.insert(msg());
      storage.members.upsert({ groupId: '9527', userId: '20001', nickname: '阿离', timestamp: Date.now() });
    });
    assert.equal(storage.messages.countSince('9527', 0), 1);
    assert.equal(storage.members.get('9527', '20001').message_count, 1);
    storage.close();
  });

  test('事务回滚后不留脏数据', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    try {
      storage.db.transaction(() => {
        storage.messages.insert(msg());
        throw new Error('故意失败');
      });
    } catch {
      /* 预期 */
    }
    assert.equal(storage.messages.countSince('9527', 0), 0);
    storage.close();
  });

  test('成员计数随发言递增', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    for (let i = 0; i < 3; i += 1) {
      storage.messages.insert(msg());
      storage.members.upsert({ groupId: '9527', userId: '20001', nickname: '阿离', timestamp: Date.now() });
    }
    assert.equal(storage.members.get('9527', '20001').message_count, 3);
    storage.close();
  });

  test('活跃榜按发言数降序', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const base = Date.now();
    [['a', 3], ['b', 5], ['c', 1]].forEach(([uid, n]) => {
      for (let i = 0; i < n; i += 1) {
        storage.messages.insert(msg({ userId: uid, nickname: uid, timestamp: base + i }));
      }
    });
    assert.deepEqual(storage.messages.countByUser('9527', 0).map((r) => r.user_id), ['b', 'a', 'c']);
    storage.close();
  });

  test('群配置以 JSON 合并存储并可读回', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527', '测试群');
    storage.groups.setSetting('9527', 'welcome', { enabled: true, text: 'hi {at}' });
    storage.groups.setSetting('9527', 'ai', { enabled: false });
    const group = storage.groups.get('9527');
    assert.equal(group.settings.welcome.enabled, true);
    assert.equal(group.settings.ai.enabled, false);
    assert.equal(group.name, '测试群');
    storage.close();
  });

  test('禁用群后 isEnabled 为 false，未登记群默认放行', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    storage.groups.setEnabled('9527', false);
    assert.equal(storage.groups.isEnabled('9527'), false);
    assert.equal(storage.groups.isEnabled('8888'), true);
    storage.close();
  });

  test('会话记忆按 maxKeep 截断', () => {
    const storage = makeStorage();
    for (let i = 0; i < 20; i += 1) storage.conversations.append('group:1', 'user', `m${i}`, 5);
    const history = storage.conversations.history('group:1', 100);
    assert.equal(history.length, 5);
    assert.equal(history.at(-1).content, 'm19');
    storage.close();
  });

  test('清空会话返回删除条数', () => {
    const storage = makeStorage();
    storage.conversations.append('group:1', 'user', 'a');
    storage.conversations.append('group:1', 'assistant', 'b');
    assert.equal(storage.conversations.clear('group:1'), 2);
    assert.equal(storage.conversations.history('group:1').length, 0);
    storage.close();
  });

  test('kv 存取任意 JSON 值', () => {
    const storage = makeStorage();
    storage.kv.set('obj', { a: [1, 2], b: 'x' });
    assert.deepEqual(storage.kv.get('obj'), { a: [1, 2], b: 'x' });
    assert.equal(storage.kv.get('missing', 'fallback'), 'fallback');
    storage.close();
  });

  test('purgeBefore 只删过期明细', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const now = Date.now();
    storage.messages.insert(msg({ timestamp: now - 10 * 86400_000 }));
    storage.messages.insert(msg({ timestamp: now }));
    assert.equal(storage.messages.purgeBefore(now - 86400_000), 1);
    assert.equal(storage.messages.countSince('9527', 0), 1);
    storage.close();
  });

  test('规则按群过滤，全局规则(group_id 为空)对所有群可见', () => {
    const storage = makeStorage();
    storage.rules.add({ groupId: null, type: 'keyword', pattern: '全局词' });
    storage.rules.add({ groupId: '9527', type: 'keyword', pattern: '本群词' });
    storage.rules.add({ groupId: '8888', type: 'keyword', pattern: '别群词' });
    const forGroup = storage.rules.list('9527').map((r) => r.pattern);
    assert.deepEqual(forGroup.sort(), ['全局词', '本群词']);
    storage.close();
  });

  test('规则命中计数与开关', () => {
    const storage = makeStorage();
    const rule = storage.rules.add({ groupId: '9527', type: 'keyword', pattern: '广告' });
    storage.rules.bumpHit(rule.id);
    storage.rules.bumpHit(rule.id);
    assert.equal(storage.rules.get(rule.id).hitCount, 2);
    storage.rules.toggle(rule.id, false);
    assert.equal(storage.rules.get(rule.id).enabled, false);
    assert.equal(storage.rules.list('9527').filter((r) => r.enabled).length, 0);
    storage.close();
  });

  const addAt = (storage, { userId, kind, detail, action, createdAt }) => {
    storage.db.run(
      'INSERT INTO violations (group_id, user_id, rule_id, kind, detail, action, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      '9527', String(userId), kind, detail, action, createdAt,
    );
  };

  test('incidents 把一次违规的多条痕迹聚成一个事件', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const t = Date.now() - 10_000;
    // 一次广告违规会产生 3 行：两个命中的检测器 + 一条 punish 摘要
    addAt(storage, { userId: '20009', kind: 'ad', detail: '疑似引流广告', action: 'kick', createdAt: t });
    addAt(storage, { userId: '20009', kind: 'newbie_shill', detail: '新成员引流', action: 'kick', createdAt: t });
    addAt(storage, { userId: '20009', kind: 'punish', detail: '疑似引流广告；新成员引流', action: 'kick', createdAt: t });

    const incidents = storage.violations.incidents('9527', 10);
    // 回归：按行返回会让 --n 10 的 /violations 只装得下 3 次真实违规，
    // 且同一次违规重复出现三遍
    assert.equal(incidents.length, 1, '3 行痕迹应聚成 1 次事件');
    assert.deepEqual(incidents[0].kinds.sort(), ['ad', 'newbie_shill']);
    assert.equal(incidents[0].action, 'kick');
    storage.close();
  });

  test('incidents 能合并跨毫秒的命中行与处置摘要', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const t = Date.now() - 10_000;
    // 回归：命中行在 commit 事务里逐条写，punish 摘要随后写，
    // 两者跨毫秒是常态（实测约 1/6 概率差 1ms）。
    // 原先用「时间戳完全相等」判断，导致同一次违规时而合并、时而拆成两条。
    addAt(storage, { userId: '20009', kind: 'ad', detail: 'x', action: 'kick', createdAt: t });
    addAt(storage, { userId: '20009', kind: 'newbie_shill', detail: 'y', action: 'kick', createdAt: t });
    addAt(storage, { userId: '20009', kind: 'punish', detail: 'x；y', action: 'kick', createdAt: t + 1 });

    const incidents = storage.violations.incidents('9527', 10);
    assert.equal(incidents.length, 1, '跨 1ms 的同一次违规必须合并');
    assert.deepEqual(incidents[0].kinds.sort(), ['ad', 'newbie_shill']);
    storage.close();
  });

  test('incidents 不会把不同用户或相隔较远的违规合并', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const t = Date.now() - 600_000;
    // 不同用户在同一毫秒：不能互相吞并
    addAt(storage, { userId: '20009', kind: 'ad', detail: 'a', action: 'kick', createdAt: t });
    addAt(storage, { userId: '20010', kind: 'ad', detail: 'b', action: 'kick', createdAt: t });
    // 同一用户但相隔 5 分钟：是两次独立事件
    addAt(storage, { userId: '20009', kind: 'ad', detail: 'c', action: 'kick', createdAt: t + 300_000 });
    assert.equal(storage.violations.incidents('9527', 10).length, 3);
    storage.close();
  });

  test('incidents 区分同用户的不同事件，且 honor limit', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const base = Date.now() - 600_000;
    for (let i = 0; i < 5; i += 1) {
      const t = base + i * 60_000;
      addAt(storage, { userId: '20009', kind: 'ad', detail: `第${i}次`, action: 'mute', createdAt: t });
      addAt(storage, { userId: '20009', kind: 'punish', detail: `第${i}次`, action: 'mute', createdAt: t });
    }
    assert.equal(storage.violations.incidents('9527', 10).length, 5, '5 个时间戳 = 5 次事件');
    assert.equal(storage.violations.incidents('9527', 2).length, 2, 'limit 应被遵守');
    storage.close();
  });

  test('incidents 覆盖未走处置流程的命中（无 punish 锚点）', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const t = Date.now() - 10_000;
    // 处罚关闭 / 白名单场景只有命中行，没有 punish
    addAt(storage, { userId: '20001', kind: 'flood', detail: '仅记录', action: 'none', createdAt: t });
    const incidents = storage.violations.incidents('9527', 10);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].action, 'none');
    assert.deepEqual(incidents[0].kinds, ['flood']);
    storage.close();
  });
});
