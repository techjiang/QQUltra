import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeStorage, makeBot } from './helpers.js';
import { createDetectEngine, DEFAULT_DETECT_CONFIG, mergeConfig } from '../src/services/detect/engine.js';
import { adDetector, floodDetector, repeatDetector, longTextDetector, linkDetector, keywordDetector, regexDetector, newbieShillDetector, escalateAction, compileRegex } from '../src/services/detect/rules.js';
import { withDefaults, GROUP_SETTINGS_DEFAULTS } from '../src/services/manage/group-config.js';

const T0 = 1_700_000_000_000;
const msg = (over = {}) => ({
  groupId: '9527',
  userId: '20001',
  nickname: '路人',
  role: 'member',
  text: '',
  segments: [],
  timestamp: T0,
  isGroup: true,
  ...over,
});

/**
 * 铺一批同用户消息进库，用于刷屏/复读窗口。
 *
 * 时间点从 start 起每条 +100ms，最后一条落在 start 上，
 * 调用方后续以 timestamp: start 的探针消息去 inspect 时，
 * 这批消息必须全部早于探针（否则会落在 until 边界之外）。
 */
function seedWindow(storage, texts, { userId = '20001', start = T0 } = {}) {
  storage.groups.ensure('9527');
  const count = texts.length;
  texts.forEach((text, i) => {
    // 倒排：第一条最早，最后一条正好落在 start
    const ts = start - (count - 1 - i) * 100;
    storage.messages.insert(msg({ userId, text, timestamp: ts, isCommand: false }));
    storage.members.upsert({ groupId: '9527', userId, nickname: '路人', timestamp: ts });
  });
}

describe('检测规则单元', () => {
  test('广告检测要求「联系方式 + 引流动词」同时出现', () => {
    assert.ok(adDetector({ text: '加我微信 abc12345 兼职日结' }));
    assert.ok(adDetector({ text: '加扣扣：123456789 免费领福利' }));
    // 只说联系方式不算广告
    assert.equal(adDetector({ text: '我的邮箱是 a@b.com，有问题邮件联系' }), null);
    // 只有引流动词也不算
    assert.equal(adDetector({ text: '大家来加群一起玩呀' }), null);
  });

  test('广告检测能击穿插分隔符的规避写法', () => {
    const finding = adDetector({ text: '加　我 微-信：a b c 1 2 3 4 5' });
    assert.ok(finding, '分隔符写法必须被识别');
    assert.match(finding.detail, /微信abc12345/);
  });

  test('刷屏检测达阈值才触发', () => {
    const config = { flood: { maxMessages: 3, windowMs: 10_000, action: 'mute' } };
    assert.equal(floodDetector({ context: { windowMessages: [1, 2] }, config }), null);
    assert.ok(floodDetector({ context: { windowMessages: [1, 2, 3] }, config }));
  });

  test('复读检测识别连续相同内容，不误判不同内容', () => {
    const config = { repeat: { maxTimes: 3, action: 'warn' } };
    const same = [{ text: '哈哈哈' }, { text: '哈哈 哈' }, { text: '哈哈哈' }];
    assert.ok(repeatDetector({ context: { windowMessages: same }, config }));
    const diff = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
    assert.equal(repeatDetector({ context: { windowMessages: diff }, config }), null);
  });

  test('复读检测忽略空消息，避免空串被判为复读', () => {
    const config = { repeat: { maxTimes: 3, action: 'warn' } };
    assert.equal(repeatDetector({ context: { windowMessages: [{ text: '' }, { text: '' }, { text: '' }] }, config }), null);
  });

  test('长文本按字数阈值触发', () => {
    assert.equal(longTextDetector({ text: 'a'.repeat(10), config: { longText: { maxLength: 100 } } }), null);
    assert.ok(longTextDetector({ text: 'a'.repeat(101), config: { longText: { maxLength: 100 } } }));
  });

  test('链接检测支持白名单豁免', () => {
    const text = 'http://a.com http://b.com http://c.com';
    assert.ok(linkDetector({ text, config: { link: { maxLinks: 3, whitelist: [] } } }));
    assert.equal(linkDetector({ text, config: { link: { maxLinks: 3, whitelist: ['a.com', 'b.com'] } } }), null);
  });

  test('关键词检测默认走归一化，可选关闭', () => {
    const rules = [{ id: 1, type: 'keyword', pattern: '加微信', action: 'warn' }];
    assert.equal(keywordDetector({ rules, text: '加 微-信' }).length, 1);
    const strict = [{ id: 1, type: 'keyword', pattern: '加微信', action: 'warn', options: { defuse: false } }];
    assert.equal(keywordDetector({ rules: strict, text: '加 微-信' }).length, 0);
  });

  test('正则检测支持 /pattern/flags 与裸串，非法正则被忽略而不抛错', () => {
    assert.ok(compileRegex('/广告+/i'));
    assert.ok(compileRegex('广告'));
    assert.equal(compileRegex('/([unclosed/'), null);
    const rules = [
      { id: 1, type: 'regex', pattern: '/广\\s*告/', action: 'warn' },
      { id: 2, type: 'regex', pattern: '/([bad/', action: 'warn' },
    ];
    assert.equal(regexDetector({ rules, text: '这是 广 告 内容' }).length, 1);
  });

  test('新人广告检测只在入群窗口内升级处罚', () => {
    const now = 1_700_000_000_000;
    const fresh = { first_seen: now - 3600_000 };
    const old = { first_seen: now - 48 * 3600_000 };
    const config = { newbie: { windowHours: 24 } };
    const ad = { kind: 'ad', action: 'mute' };
    assert.ok(newbieShillDetector({ context: { adFinding: ad, member: fresh, now }, config }));
    assert.equal(newbieShillDetector({ context: { adFinding: ad, member: old, now }, config }), null);
    assert.equal(newbieShillDetector({ context: { adFinding: null, member: fresh, now }, config }), null);
  });

  test('处罚阶梯随违规次数升级但有上限', () => {
    assert.equal(escalateAction('warn', 0), 'warn');
    assert.equal(escalateAction('warn', 2), 'mute');
    assert.equal(escalateAction('warn', 99), 'kick');
    assert.equal(escalateAction('kick', 0), 'kick', 'kick 不会被降级');
    assert.equal(escalateAction('mute', 0), 'mute', 'mute 不会被降级成 warn');
  });
});

describe('检测引擎与群配置', () => {
  test('群配置默认值与检测默认值同源，不会互相挤掉', () => {
    // 回归：曾因 group-config 里只手写 {enabled,punish}，
    // 覆盖掉 flood/repeat 等默认值，导致刷屏检测静默失效
    assert.deepEqual(withDefaults({}).detect, DEFAULT_DETECT_CONFIG);
    assert.deepEqual(GROUP_SETTINGS_DEFAULTS.detect, DEFAULT_DETECT_CONFIG);
  });

  test('只配了 muteSeconds 的群仍保有完整检测默认值', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    storage.groups.setSetting('9527', 'detect', { punish: { muteSeconds: 300 } });

    const engine = createDetectEngine({ storage });
    seedWindow(storage, Array.from({ length: 8 }, (_, i) => `刷屏 ${i}`));
    const result = engine.inspect(msg({ text: '刷屏 7', timestamp: T0 + 700 }));
    assert.ok(result.findings.some((f) => f.kind === 'flood'), '刷屏规则必须仍然生效');
    storage.close();
  });

  test('阈值边界：第 8 条触发、第 7 条不触发', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const engine = createDetectEngine({ storage });

    seedWindow(storage, Array.from({ length: 7 }, (_, i) => `m${i}`));
    assert.equal(engine.inspect(msg({ timestamp: T0 + 600 })).findings.length, 0, '窗口内 7 条不应触发');

    seedWindow(storage, ['m7'], { start: T0 + 700 });
    assert.ok(engine.inspect(msg({ timestamp: T0 + 700 })).findings.some((f) => f.kind === 'flood'));
    storage.close();
  });

  test('窗口外的旧消息不计入刷屏', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const engine = createDetectEngine({ storage });
    // 每条间隔 5 秒，共 10 条，但 10 秒窗口内最多 3 条
    seedWindow(storage, Array.from({ length: 10 }, (_, i) => `m${i}`), { start: T0 - 50_000 });
    for (let i = 0; i < 10; i += 1) {
      storage.messages.insert(msg({ text: `m${i}`, timestamp: T0 - 50_000 + i * 5000, isCommand: false }));
    }
    assert.equal(engine.inspect(msg({ timestamp: T0 })).findings.length, 0);
    storage.close();
  });

  test('管理员在白名单内只记录不处罚', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const engine = createDetectEngine({ storage });
    seedWindow(storage, Array.from({ length: 8 }, (_, i) => `m${i}`));
    const result = engine.inspect(msg({ role: 'admin', timestamp: T0 + 700 }));
    assert.ok(result.findings.length > 0, '仍应记录命中');
    assert.equal(result.decision.action, 'none');
    assert.match(result.decision.reason, /白名单/);
    storage.close();
  });

  test('关闭处罚后仅记录', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    storage.groups.setSetting('9527', 'detect', { punish: { enabled: false } });
    const engine = createDetectEngine({ storage });
    seedWindow(storage, Array.from({ length: 8 }, (_, i) => `m${i}`));
    assert.equal(engine.inspect(msg({ timestamp: T0 + 700 })).decision.action, 'none');
    storage.close();
  });

  test('整个检测关闭后不再产出任何 finding', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    storage.groups.setSetting('9527', 'detect', { enabled: false });
    const engine = createDetectEngine({ storage });
    seedWindow(storage, Array.from({ length: 20 }, (_, i) => `m${i}`));
    const result = engine.inspect(msg({ text: '加我微信 abc12345 兼职日结', timestamp: T0 + 700 }));
    assert.deepEqual(result.findings, []);
    assert.equal(result.decision.action, 'none');
    storage.close();
  });

  test('多条规则命中时取最重处罚', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const engine = createDetectEngine({ storage });
    storage.groups.setSetting('9527', 'detect', { longText: { maxLength: 10 } });
    // 先让该用户有入群记录，新人广告检测(kick) 才会参与竞争
    storage.members.upsert({ groupId: '9527', userId: '20001', nickname: '路人', timestamp: T0 });

    const result = engine.inspect(msg({ text: '加我微信 abc12345 兼职日结，这段话其实挺长的' }));
    assert.ok(result.findings.length >= 2, '广告与长文本应同时命中');
    assert.equal(result.decision.action, 'kick', '按最重的 kick 处置');
    storage.close();
  });

  test('commit 累积违规事件并推动升级', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    // 用没有 kick 规则的违规类型（刷屏），单独观察阶梯升级
    const engine = createDetectEngine({ storage });
    const spam = () => Array.from({ length: 8 }, (_, i) => `m${i}`);

    // 刷屏的基础处罚是 mute，阶梯只升不降：
    // 前四次维持 mute，priorCount>=4 后升到 kick
    const seen = [];
    for (let round = 0; round < 5; round += 1) {
      // 每轮把窗口平移到新的时间基准，避免与前几轮的消息混在同一窗口
      const roundStart = T0 + round * 60_000;
      seedWindow(storage, spam(), { start: roundStart - 600 });
      const m = msg({ timestamp: roundStart });
      const { findings, decision } = engine.inspect(m);
      // executed 传入具体动作，才会写入升级计数用的 punish 事件
      engine.commit(m, findings, decision, { executed: decision.action });
      seen.push(decision.action);
    }
    assert.equal(storage.violations.countPunished('9527', '20001', 0), 5, '每次独立违规记一次事件');
    assert.deepEqual(seen, ['mute', 'mute', 'mute', 'mute', 'kick']);
    storage.close();
  });

  test('同一事件窗口内的连续命中不重复计入升级依据', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const engine = createDetectEngine({ storage });
    const m = msg();
    assert.equal(engine.isNewIncident(m), true, '首次违规算新事件');

    storage.violations.add({ groupId: '9527', userId: '20001', kind: 'punish', detail: 'x', action: 'mute' });
    assert.equal(engine.isNewIncident(m), false, '窗口内不应算作新事件');
    assert.equal(engine.isNewIncident(m, { incidentWindowMs: 0 }), true, '窗口可被收紧');
    storage.close();
  });

  test('只命中规则但未执行处置时不写 punish 事件', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const engine = createDetectEngine({ storage });
    const m = msg({ text: '这里出现了违禁词' });
    storage.rules.add({ groupId: '9527', type: 'keyword', pattern: '违禁词', action: 'warn' });

    const { findings, decision } = engine.inspect(m);
    engine.commit(m, findings, decision);
    assert.equal(storage.violations.countPunished('9527', '20001', 0), 0);
    assert.ok(storage.violations.countByUser('9527', '20001', 0) > 0, '命中仍要留痕');
    storage.close();
  });

  test('自定义关键词规则的命中次数被累计', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const rule = storage.rules.add({ groupId: '9527', type: 'keyword', pattern: '违禁词', action: 'warn' });
    const engine = createDetectEngine({ storage });
    const m = msg({ text: '这里出现了违禁词汇' });
    const { findings, decision } = engine.inspect(m);
    engine.commit(m, findings, decision);
    assert.equal(storage.rules.get(rule.id).hitCount, 1);
    storage.close();
  });

  test('mergeConfig 深层覆盖且不丢兄弟键', () => {
    const merged = mergeConfig({ a: { b: 1, c: 2 }, d: 3 }, { a: { b: 9 } });
    assert.deepEqual(merged, { a: { b: 9, c: 2 }, d: 3 });
  });
});

describe('自动化处置落库与通知', () => {
  test('广告用户被踢出且全程留痕', async () => {
    const { bot, storage, adapter } = await makeBot();
    await bot.inject({ groupId: '9527', userId: '20009', nickname: '卖茶小妹', text: '加我微信 abc12345，兼职日结' });

    const actions = adapter.actions.map((a) => a.action);
    assert.ok(actions.includes('set_group_kick'), '应执行踢出');
    assert.ok(adapter.outbox.some((m) => /移出本群/.test(m.message)));
    assert.equal(storage.violations.countByUser('9527', '20009', 0) >= 1, true);
    storage.close();
  });

  test('刷屏用户被禁言且通知标注原因', async () => {
    const { bot, storage, adapter } = await makeBot();
    for (let i = 0; i < 9; i += 1) {
      await bot.inject({ groupId: '9527', userId: '20003', nickname: '路人甲', text: `刷屏 ${i}` });
    }
    const banCount = adapter.actions.filter((a) => a.action === 'set_group_ban').length;
    assert.ok(banCount >= 1, '应执行禁言');
    assert.ok(adapter.outbox.some((m) => /被禁言/.test(m.message)));
    storage.close();
  });

  test('管理员发言不受自动处罚', async () => {
    const { bot, storage, adapter } = await makeBot();
    for (let i = 0; i < 9; i += 1) {
      await bot.inject({ groupId: '9527', userId: '29999', nickname: '群主', role: 'owner', text: `刷屏 ${i}` });
    }
    assert.equal(adapter.actions.filter((a) => a.action === 'set_group_ban').length, 0);
    storage.close();
  });

  test('处罚执行失败时降级为提醒而非中断主循环', async () => {
    const { bot, storage, adapter } = await makeBot();
    adapter.muteMember = async () => {
      throw new Error('机器人不是管理员');
    };
    for (let i = 0; i < 9; i += 1) {
      await bot.inject({ groupId: '9527', userId: '20003', nickname: '路人甲', text: `刷屏 ${i}` });
    }
    assert.ok(adapter.outbox.some((m) => /自动处置失败/.test(m.message)), '应发出降级提醒');
    assert.ok(storage.violations.recent('9527').some((v) => v.action === 'degraded'));
    storage.close();
  });

  test('指令消息不走自动检测，管理员不会被自己的规则拦下', async () => {
    const { bot, storage, adapter } = await makeBot();
    storage.rules.add({ groupId: '9527', type: 'keyword', pattern: '/rule', action: 'kick' });
    await bot.inject({ groupId: '9527', userId: '29999', nickname: '群主', role: 'owner', text: '/rules' });
    assert.equal(adapter.actions.filter((a) => a.action === 'set_group_kick').length, 0);
    assert.ok(adapter.outbox.some((m) => /生效规则|内置规则/.test(m.message)));
    storage.close();
  });

  test('禁用自动检测的群只统计不处罚', async () => {
    const { bot, storage, adapter } = await makeBot();
    storage.groups.setSetting('9527', 'detect', { enabled: false });
    for (let i = 0; i < 9; i += 1) {
      await bot.inject({ groupId: '9527', userId: '20003', text: `刷屏 ${i}` });
    }
    assert.equal(adapter.actions.filter((a) => a.action === 'set_group_ban').length, 0);
    assert.equal(storage.violations.recent('9527').length, 0);
    storage.close();
  });
});
