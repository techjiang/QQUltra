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
});
