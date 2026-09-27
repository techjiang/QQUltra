import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeBot } from './helpers.js';
import { withDefaults, applySetting, coerceSetting, describeSettings, SETTABLE_KEYS } from '../src/services/manage/group-config.js';
import { extractMentions } from '../src/services/manage/commands.js';

describe('群配置', () => {
  test('缺省设置补全全部默认段', () => {
    const s = withDefaults({});
    assert.equal(s.stats.enabled, true);
    assert.equal(s.ai.trigger, 'mention');
    assert.equal(s.detect.enabled, true);
    assert.equal(s.welcome.enabled, false);
  });

  test('部分覆盖保留同级默认值', () => {
    const s = withDefaults({ ai: { enabled: false } });
    assert.equal(s.ai.enabled, false);
    assert.equal(s.ai.trigger, 'mention', '未覆盖的兄弟键应保留默认');
  });

  test('布尔/数字/枚举分别校验', () => {
    assert.equal(coerceSetting('stats.enabled', 'false'), false);
    assert.equal(coerceSetting('detect.punish.muteSeconds', '300'), 300);
    assert.equal(coerceSetting('ai.trigger', 'prefix'), 'prefix');
    assert.throws(() => coerceSetting('ai.trigger', '随便'), /只能是/);
    assert.throws(() => coerceSetting('stats.enabled', 'yes'), /true\/false/);
    assert.throws(() => coerceSetting('detect.punish.muteSeconds', '-5'), /非负数字/);
  });

  test('未知配置项被拒绝，防止污染 settings', () => {
    assert.throws(() => coerceSetting('hack.me', '1'), /不支持的配置项/);
  });

  test('applySetting 生成嵌套结构', () => {
    const { settings, value } = applySetting({ settings: {} }, 'detect.punish.muteSeconds', '300');
    assert.deepEqual(settings, { detect: { punish: { muteSeconds: 300 } } });
    assert.equal(value, 300);
  });

  test('单层键直接落在顶层级', () => {
    const { settings } = applySetting({ settings: {} }, 'antispam.enabled', 'true');
    assert.equal(settings.antispam.enabled, true);
  });

  test('所有可设置键都能被 applySetting 处理', () => {
    const sample = { boolean: 'true', 'enum:mention,prefix,all': 'all', number: '1', string: 'x' };
    for (const [key, spec] of Object.entries(SETTABLE_KEYS)) {
      const kind = spec.startsWith('enum:') ? 'enum:mention,prefix,all' : spec;
      assert.doesNotThrow(() => applySetting({ settings: {} }, key, sample[kind]), `${key} 应可设置`);
    }
  });

  test('配置描述人类可读', () => {
    const text = describeSettings({ ai: { enabled: false }, detect: { punish: { enabled: false } } });
    assert.match(text, /AI 关/);
    assert.match(text, /自动处罚 关/);
    assert.match(text, /触发：mention/);
  });
});

describe('管理指令', () => {
  const run = async (text, { role = 'owner', userId = '29999', setup } = {}) => {
    const { bot, storage, adapter } = await makeBot();
    if (setup) await setup({ storage, bot });
    await bot.inject({ groupId: '9527', userId, nickname: '群主', role, text });
    return { reply: adapter.lastReply(), storage, adapter, bot, close: () => storage.close() };
  };

  test('/help 列出主要指令', async () => {
    const { reply, close } = await run('/help');
    assert.match(reply, /QQUltra 指令一览/);
    assert.match(reply, /\/stats/);
    assert.match(reply, /\/ai/);
    close();
  });

  test('/ping 返回存活信息', async () => {
    const { reply, close } = await run('/ping');
    assert.match(reply, /pong/);
    close();
  });

  test('/me 无记录时提示先发言', async () => {
    const { reply, close } = await run('/me');
    assert.match(reply, /还没有你的发言记录/);
    close();
  });

  test('/whois 需要 @ 目标', async () => {
    const { reply, close } = await run('/whois');
    assert.match(reply, /用法：\/whois @某人/);
    close();
  });

  test('/whois 按 @ 查询成员档案', async () => {
    const { bot, storage, adapter } = await makeBot();
    await bot.inject({ groupId: '9527', userId: '20001', nickname: '阿离', text: '大家好' });
    await bot.inject({
      groupId: '9527',
      userId: '29999',
      nickname: '群主',
      role: 'owner',
      text: '/whois @阿离',
      segments: [{ type: 'at', data: { qq: '20001' } }],
    });
    assert.match(adapter.lastReply(), /阿离/);
    assert.match(adapter.lastReply(), /累计发言 1 条/);
    storage.close();
  });

  test('/config 展示当前配置，/config set 生效并持久化', async () => {
    const { bot, storage, adapter } = await makeBot();
    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: '/config' });
    assert.match(adapter.lastReply(), /本群 QQUltra 配置/);

    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: '/config set ai.trigger all' });
    assert.match(adapter.lastReply(), /已设置 ai.trigger/);
    assert.equal(withDefaults(storage.groups.get('9527').settings).ai.trigger, 'all');

    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: '/config set 不存在的键 1' });
    assert.match(adapter.lastReply(), /指令执行失败/);
    storage.close();
  });

  test('/config keys 列出可配置项', async () => {
    const { reply, close } = await run('/config keys');
    assert.match(reply, /可配置项/);
    assert.match(reply, /stats\.enabled/);
    close();
  });

  test('/rule add 后 /rules 可见，/rule del 可删除', async () => {
    const { bot, storage, adapter } = await makeBot();
    const send = (text) => bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text });

    await send('/rule add keyword 违禁词 --action=mute');
    assert.match(adapter.lastReply(), /已添加规则 #\d+/);

    await send('/rules');
    assert.match(adapter.lastReply(), /违禁词/);

    const id = storage.rules.list('9527')[0].id;
    await send(`/rule del ${id}`);
    assert.match(adapter.lastReply(), /已删除规则/);
    assert.equal(storage.rules.list('9527').length, 0);
    storage.close();
  });

  test('/rule add 校验 action 取值', async () => {
    const { reply, close } = await run('/rule add keyword 词 --action=destroy');
    assert.match(reply, /--action 只能是/);
    close();
  });

  test('/rule on|off 切换规则开关', async () => {
    const { bot, storage, adapter } = await makeBot();
    const rule = storage.rules.add({ groupId: '9527', type: 'keyword', pattern: '词', action: 'warn' });
    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: `/rule off ${rule.id}` });
    assert.match(adapter.lastReply(), /已停用/);
    assert.equal(storage.rules.get(rule.id).enabled, false);
    storage.close();
  });

  test('非管理员的配置类指令被拒绝', async () => {
    const { reply, close } = await run('/config set ai.trigger all', { role: 'member', userId: '20001' });
    assert.match(reply, /需要管理员权限/);
    close();
  });

  test('/purge 仅 owner 可用且清理过期数据', async () => {
    const { bot, storage, adapter } = await makeBot();
    const old = Date.now() - 10 * 86400_000;
    storage.groups.ensure('9527');
    for (let i = 0; i < 3; i += 1) {
      storage.messages.insert({ groupId: '9527', userId: 'a', text: 'old', segments: [], timestamp: old + i });
    }
    await bot.inject({ groupId: '9527', userId: '20001', role: 'admin', text: '/purge 1' });
    assert.match(adapter.lastReply(), /需要管理员权限|仅|owner/);

    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: '/purge 1' });
    assert.match(adapter.lastReply(), /已清理 1 天前的 3 条消息明细/);
    storage.close();
  });

  test('未知指令静默忽略，不打扰群聊', async () => {
    const { reply, close } = await run('/nobody-knows-this');
    assert.equal(reply, null);
    close();
  });
});

describe('群管理与通知', () => {
  test('入群欢迎语按配置发送并替换 @ 占位', async () => {
    const { bot, storage, adapter } = await makeBot();
    storage.groups.setSetting('9527', 'welcome', { enabled: true, text: '欢迎 {at} 加入！' });
    adapter.emitNotice({ subType: 'group_increase', groupId: '9527', userId: '20010' });
    await new Promise((r) => setTimeout(r, 10));
    assert.match(adapter.lastReply(), /欢迎 \[CQ:at,qq=20010\] 加入！/);
    storage.close();
  });

  test('未开启欢迎语时不发言', async () => {
    const { adapter, storage } = await makeBot();
    adapter.emitNotice({ subType: 'group_increase', groupId: '9527', userId: '20010' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(adapter.lastReply(), null);
    storage.close();
  });

  test('成员退群清理汇总记录', async () => {
    const { bot, storage, adapter } = await makeBot();
    await bot.inject({ groupId: '9527', userId: '20001', nickname: '阿离', text: 'hi' });
    assert.ok(storage.members.get('9527', '20001'));

    adapter.emitNotice({ subType: 'group_decrease', groupId: '9527', userId: '20001' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(storage.members.get('9527', '20001'), null);
    storage.close();
  });

  test('入群申请默认不自动放行，留人工审核', async () => {
    const { adapter, storage } = await makeBot();
    adapter.emitRequest({ subType: 'add', flag: 'abc', groupId: '9527', userId: '20011' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(adapter.actions.some((a) => a.action === 'set_group_add_request'), false);

    await adapter.setGroupAddRequest('abc', true, 'ok').catch(() => {});
    assert.ok(adapter.actions.some((a) => a.action === 'set_group_add_request'));
    storage.close();
  });

  test('开启 autoApprove 后自动通过入群申请', async () => {
    const { adapter, storage } = await makeBot();
    storage.groups.setSetting('9527', 'antispam', { autoApprove: true });
    adapter.emitRequest({ subType: 'add', flag: 'xyz', groupId: '9527', userId: '20012' });
    await new Promise((r) => setTimeout(r, 20));
    const call = adapter.actions.find((a) => a.action === 'set_group_add_request');
    assert.ok(call);
    assert.equal(call.params.approve, true);
    storage.close();
  });

  test('/approve 与 /reject 走通人工审核', async () => {
    const { bot, storage, adapter } = await makeBot();
    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: '/approve flag-1' });
    assert.match(adapter.lastReply(), /已通过入群申请/);
    assert.equal(adapter.actions.at(-2).params.approve, true);

    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: '/reject flag-2' });
    assert.match(adapter.lastReply(), /已拒绝入群申请/);
    assert.equal(adapter.actions.at(-2).params.approve, false);
    storage.close();
  });

  test('被禁用的群不再响应任何消息', async () => {
    const { bot, storage, adapter } = await makeBot();
    storage.groups.setEnabled('9527', false);
    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: '/ping' });
    assert.equal(adapter.lastReply(), null);
    storage.close();
  });

  test('extractMentions 过滤 @全体成员', () => {
    const mentions = extractMentions([
      { type: 'at', data: { qq: 'all' } },
      { type: 'at', data: { qq: '123' } },
      { type: 'text', data: { text: 'x' } },
    ]);
    assert.deepEqual(mentions, ['123']);
  });
});
