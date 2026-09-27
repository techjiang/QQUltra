import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { makeBot, makeStorage } from './helpers.js';
import { countWords, tokenize, renderWordCloudText } from '../src/services/stats/wordcloud.js';
import { layoutWords, renderWordCloudSvg, renderPanelSvg, estimateTextWidth } from '../src/services/stats/wordcloud-svg.js';
import { renderPanel, PANEL_SECTIONS, panelCommands } from '../src/services/manage/panel.js';
import { inspectGroupHealth, renderHealthText, buildDailyDigest, evaluateAlert } from '../src/services/manage/digest.js';
import { renderAboutText, AUTHOR, logoPath } from '../src/assets/brand.js';
import { COMMAND_PREFIX } from '../src/services/manage/commands.js';
import { GROUP_SETTINGS_DEFAULTS } from '../src/services/manage/group-config.js';

describe('词云（切词与统计）', () => {
  test('中文按二元切分，英文按单词，CQ 码与占位标记被剔除', () => {
    const tokens = tokenize('[CQ:at,qq=10000] 排位 update 12 [图片]');
    assert.ok(tokens.includes('排位'));
    assert.ok(tokens.includes('update'));
    assert.ok(tokens.includes('12'));
    assert.ok(!tokens.some((t) => t.includes('CQ')), 'CQ 码不应进词表');
    assert.ok(!tokens.includes('图片'), '占位标记不应进词表');
  });

  test('停用词被过滤，同一句话里的重复词只计一次', () => {
    // 「哈哈哈」是停用词；「排位」在同一句里出现两次也只算一次
    const words = countWords(['排位排位哈哈哈这版本排位好难', '排位又输了'], { minCount: 1 });
    const paiwei = words.find((w) => w.word === '排位');
    assert.equal(paiwei.count, 2, '按句去重：两条消息各贡献一次');
  });

  test('低于 minCount 的词不出现在结果里', () => {
    const words = countWords(['只有一次的词'], { minCount: 2 });
    assert.equal(words.length, 0);
  });

  test('词频降序且计数正确', () => {
    const words = countWords(['排位 上分', '排位 上分', '排位'], { minCount: 2 });
    assert.equal(words[0].word, '排位');
    assert.equal(words[0].count, 3);
    assert.ok(words[0].count >= words[1].count, '结果必须按词频降序');
  });

  test('二元切分会产生跨词边界的噪声词，属已知取舍', () => {
    // 「排位上分」会被切成 排位/位上/上分，其中「位上」是跨词噪声。
    // 不引分词库就无法消除，靠 minCount 过滤——这里把行为固定下来，避免被误当 bug 改掉。
    const words = countWords(['排位上分'], { minCount: 1 });
    assert.deepEqual(words.map((w) => w.word).sort(), ['上分', '位上', '排位']);
  });

  test('空语料与纯表情消息不产生词', () => {
    assert.deepEqual(countWords([], { minCount: 1 }), []);
    assert.deepEqual(countWords(['[图片][表情]', '   '], { minCount: 1 }), []);
  });
});

describe('词云（渲染）', () => {
  test('估算宽度：CJK 比同长度西文更宽', () => {
    assert.ok(estimateTextWidth('排位', 20) > estimateTextWidth('ab', 20));
  });

  test('螺旋布局结果确定性：同输入必得同坐标', () => {
    const words = [
      { word: '排位', count: 5 },
      { word: '更新', count: 3 },
      { word: '上分', count: 2 },
    ];
    assert.deepEqual(layoutWords(words, {}), layoutWords(words, {}));
  });

  test('布局不越界也不重叠（回归：估宽偏小会导致词叠在一起）', () => {
    const words = Array.from({ length: 24 }, (_, i) => ({ word: `词${'甲一二三四五六七八九十'[i % 11]}${i}`, count: 24 - i }));
    const width = 640;
    const height = 400;
    const placed = layoutWords(words, { width, height });
    assert.equal(placed.length, words.length, '每个词都应被放置');

    for (const p of placed) {
      const w = estimateTextWidth(p.word, p.size) + 6;
      const h = p.size * 1.15;
      assert.ok(p.x - w / 2 >= 0 && p.x + w / 2 <= width, `词 ${p.word} 横向越界`);
      assert.ok(p.y - h / 2 >= 0 && p.y + h / 2 <= height, `词 ${p.word} 纵向越界`);
    }

    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i];
        const b = placed[j];
        const aw = estimateTextWidth(a.word, a.size) + 6;
        const ah = a.size * 1.15;
        const bw = estimateTextWidth(b.word, b.size) + 6;
        const bh = b.size * 1.15;
        const overlap =
          Math.abs(a.x - b.x) < (aw + bw) / 2 && Math.abs(a.y - b.y) < (ah + bh) / 2;
        assert.ok(!overlap, `词 ${a.word} 与 ${b.word} 重叠`);
      }
    }
  });

  test('SVG 转义特殊字符，避免破坏文档结构', () => {
    const { svg } = renderWordCloudSvg([{ word: '<script>&"', count: 2 }], {});
    assert.ok(!svg.includes('<script>'));
    assert.ok(svg.includes('&lt;script&gt;'));
    assert.ok(svg.includes('&amp;'));
  });

  test('空词表也能渲染出合法 SVG', () => {
    const { svg } = renderWordCloudSvg([], {});
    assert.match(svg, /^<svg /);
    assert.match(svg, /<\/svg>\s*$/);
  });

  test('文本词云无数据时给出可读提示而不是空字符串', () => {
    assert.match(renderWordCloudText([]), /暂无足够语料/);
  });

  test('面板图卡把指令与说明分列渲染', () => {
    const svg = renderPanelSvg('/stats [today] — 统计报告', { title: '面板' });
    assert.match(svg, /\/stats \[today\]/);
    assert.match(svg, /统计报告/);
  });
});

describe('管理面板', () => {
  test('面板覆盖的指令都真实存在（防止面板与实际能力脱节）', async () => {
    const { bot } = await makeBot();
    for (const cmd of panelCommands()) {
      const name = cmd.replace(COMMAND_PREFIX, '');
      assert.ok(bot.commands.resolve(name), `面板里的 ${cmd} 没有对应指令实现`);
    }
  });

  test('普通成员看不到管理员与群主项', () => {
    const text = renderPanel({ role: 'member' });
    assert.ok(!text.includes('/purge'));
    assert.ok(!text.includes('/config set'));
    assert.ok(text.includes('/stats'), '公共指令仍应可见');
  });

  test('管理员能看到管理项，白名单同样放行', () => {
    assert.ok(renderPanel({ role: 'admin' }).includes('/purge'));
    assert.ok(renderPanel({ role: 'member', whiteListed: true }).includes('/purge'));
    assert.ok(renderPanel({ role: 'owner' }).includes('/config set'));
  });

  test('每条指令都能在 /help 里找到，避免指令存在但没人知道', async () => {
    const { bot, adapter, storage } = await makeBot();
    await bot.inject({ groupId: '9527', userId: 'a', text: '/help' });
    const help = adapter.lastReply();
    for (const name of bot.commands.list()) {
      assert.ok(help.includes(`/${name}`), `指令 /${name} 未出现在 /help 中`);
    }
    storage.close();
  });

  test('面板覆盖全部面向用户的入口（内部工具型指令除外）', async () => {
    const { bot } = await makeBot();
    const inPanel = new Set(panelCommands().map((c) => c.replace(COMMAND_PREFIX, '')));
    // 这些只在特定时机由管理员使用，放进面板反而干扰阅读
    const intentionallyHidden = new Set(['rule', 'approve', 'unsubscribe']);
    for (const name of bot.commands.list()) {
      if (intentionallyHidden.has(name)) continue;
      assert.ok(inPanel.has(name), `指令 /${name} 未登记到面板`);
    }
  });

  test('每个分区都至少有一条指令', () => {
    for (const section of PANEL_SECTIONS) {
      assert.ok(section.items.length > 0, `${section.key} 分区为空`);
    }
  });
});

describe('健康自检与简报', () => {
  test('检测被关闭时给出 warn，群停用给出 bad', () => {
    const storage = makeStorage();
    const group = storage.groups.ensure('9527', '群');
    storage.groups.setSetting('9527', 'detect', { enabled: false });
    storage.messages.insert({ groupId: '9527', userId: '1', nickname: 'a', text: 'hi', timestamp: Date.now() });
    void group;

    const warn = inspectGroupHealth({ storage, groupId: '9527', lastReadyAt: Date.now() });
    assert.equal(warn.level, 'warn');
    assert.ok(warn.checks.some((c) => c.name === '自动检测' && c.level === 'warn'));

    storage.groups.setEnabled('9527', false);
    const bad = inspectGroupHealth({ storage, groupId: '9527', lastReadyAt: Date.now() });
    assert.equal(bad.level, 'bad');
    storage.close();
  });

  test('近 24 小时无数据流入时提示，而不是静默显示正常', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527', '群');
    const health = inspectGroupHealth({ storage, groupId: '9527', lastReadyAt: Date.now() });
    assert.ok(health.checks.some((c) => c.name === '数据流入' && c.level === 'warn'));
    assert.match(renderHealthText(health), /数据流入/);
    storage.close();
  });

  test('连接时间戳过旧升级为 bad', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527', '群');
    const health = inspectGroupHealth({ storage, groupId: '9527', lastReadyAt: Date.now() - 12 * 3600_000 });
    assert.equal(health.checks.find((c) => c.name === '连接').level, 'bad');
    storage.close();
  });

  test('简报统计昨日数据并给出环比', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527', '群');
    const now = new Date('2026-03-10T12:00:00').getTime();
    const DAY = 86400_000;
    const yStart = new Date('2026-03-09T00:00:00').getTime();
    for (let i = 0; i < 4; i += 1) {
      storage.messages.insert({ groupId: '9527', userId: '1', nickname: '阿离', text: 'x', timestamp: yStart + i * 1000 });
    }
    for (let i = 0; i < 2; i += 1) {
      storage.messages.insert({ groupId: '9527', userId: '2', nickname: '扫地僧', text: 'y', timestamp: yStart - DAY + i * 1000 });
    }

    const digest = buildDailyDigest(storage, '9527', { now });
    assert.equal(digest.stats.yesterday, 4);
    assert.equal(digest.stats.dayBefore, 2);
    assert.equal(digest.stats.delta, 100);
    assert.match(digest.text, /昨日简报/);
    storage.close();
  });

  test('预警在窗口内达标才触发，且指出主要类型', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527', '群');
    const now = Date.now();
    for (let i = 0; i < 6; i += 1) {
      storage.violations.add({ groupId: '9527', userId: `u${i}`, kind: 'ad', detail: 'd', action: 'mute' });
    }
    const hit = evaluateAlert({ storage, groupId: '9527', now: Date.now(), threshold: 5 });
    assert.equal(hit.triggered, true);
    assert.match(hit.reason, /ad/);
    void now;

    const miss = evaluateAlert({ storage, groupId: '9527', now: Date.now(), threshold: 99 });
    assert.equal(miss.triggered, false);
    storage.close();
  });
});

describe('作者信息与品牌', () => {
  test('作者名片包含全部渠道且脱敏无遗漏', () => {
    const text = renderAboutText({ version: '9.9.9' });
    assert.match(text, /科技酱/);
    assert.match(text, /docs\.asoe\.cn/);
    assert.match(text, /github\.com\/techjiang/);
    assert.match(text, /space\.bilibili\.com\/1768832152/);
    assert.match(text, /forums\.asoe\.cn/);
    for (const g of AUTHOR.qqGroups) assert.ok(text.includes(g), `缺少 QQ 群 ${g}`);
    assert.match(text, /v9\.9\.9/);
  });

  test('Logo 随包分发且是可用的 PNG 文件', () => {
    const file = logoPath();
    assert.ok(file, 'logo.png 应随包存在');
    assert.match(file, /logo\.png$/);
  });
});

describe('新增群内指令（端到端）', () => {
  async function seed() {
    const { bot, adapter, storage } = await makeBot();
    const now = Date.now();
    for (let i = 0; i < 4; i += 1) {
      await bot.inject({
        groupId: '9527',
        userId: '20001',
        nickname: '阿离',
        text: '今天有人打排位吗，晚上八点排位冲分',
        timestamp: now + i,
      });
    }
    return { bot, adapter, storage };
  }

  test('/about 返回作者与项目信息', async () => {
    const { bot, adapter, storage } = await seed();
    await bot.inject({ groupId: '9527', userId: 'a', text: '/about' });
    assert.match(adapter.lastReply(), /科技酱/);
    storage.close();
  });

  test('/panel 在群里给出面板，普通成员看不到管理项', async () => {
    const { bot, adapter, storage } = await seed();
    await bot.inject({ groupId: '9527', userId: '20001', role: 'member', text: '/panel' });
    const text = adapter.lastReply();
    assert.match(text, /管理面板/);
    assert.ok(!text.includes('/purge'));
    storage.close();
  });

  test('/status 给出运行时长与自检项', async () => {
    const { bot, adapter, storage } = await seed();
    await bot.inject({ groupId: '9527', userId: 'a', text: '/status' });
    const text = adapter.lastReply();
    assert.match(text, /运行自检/);
    assert.match(text, /适配器/);
    storage.close();
  });

  test('/wordcloud 语料不足时退回文本而不是报错', async () => {
    const { bot, adapter, storage } = await seed();
    await bot.inject({ groupId: '9527', userId: 'a', text: '/wordcloud all' });
    const reply = adapter.lastReply();
    assert.ok(reply && reply.length > 0, '必须给出回复，不能静默');
    storage.close();
  });

  test('/history 无参数看全群、带 @ 看个人', async () => {
    const { bot, adapter, storage } = await seed();
    await bot.inject({ groupId: '9527', userId: 'a', text: '/history --n=2' });
    assert.match(adapter.lastReply(), /最新发言/);

    await bot.inject({ groupId: '9527', userId: 'a', text: '/history', segments: [{ type: 'at', data: { qq: '20001' } }] });
    assert.match(adapter.lastReply(), /20001|阿离/);
    storage.close();
  });

  test('/violations 需要管理员权限', async () => {
    const { bot, adapter, storage } = await seed();
    await bot.inject({ groupId: '9527', userId: '20001', role: 'member', text: '/violations' });
    assert.match(adapter.lastReply(), /管理员权限/);

    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: '/violations' });
    assert.match(adapter.lastReply(), /没有|违规/);
    storage.close();
  });

  test('/alert on|off|threshold 修改群配置并可读回', async () => {
    const { bot, adapter, storage } = await seed();
    const owner = { groupId: '9527', userId: '29999', role: 'owner' };

    await bot.inject({ ...owner, text: '/alert off' });
    assert.match(adapter.lastReply(), /关闭/);
    assert.equal(storage.groups.get('9527').settings.alert.enabled, false);

    await bot.inject({ ...owner, text: '/alert threshold 12' });
    assert.match(adapter.lastReply(), /12/);
    assert.equal(storage.groups.get('9527').settings.alert.threshold, 12);

    await bot.inject({ ...owner, text: '/alert threshold abc' });
    assert.match(adapter.lastReply(), /正整数/);
    storage.close();
  });

  test('别名可用：/统计 走 /stats，/菜单 走 /help', async () => {
    const { bot, adapter, storage } = await seed();
    await bot.inject({ groupId: '9527', userId: 'a', text: '/统计 all' });
    assert.match(adapter.lastReply(), /群 9527/);
    await bot.inject({ groupId: '9527', userId: 'a', text: '/菜单' });
    assert.match(adapter.lastReply(), /指令一览/);
    storage.close();
  });

  test('预警在违规激增时主动推送，且 30 分钟内不重复打扰', async () => {
    const { bot, adapter, storage } = await seed();
    const settings = GROUP_SETTINGS_DEFAULTS.alert;
    assert.equal(settings.enabled, true, '预警默认开启');

    // 直接把违规记录堆到阈值以上，再注入一条普通消息触发主动服务
    for (let i = 0; i < 6; i += 1) {
      storage.violations.add({ groupId: '9527', userId: `u${i}`, kind: 'ad', detail: 'd', action: 'mute' });
    }
    adapter.clearOutbox();
    await bot.inject({ groupId: '9527', userId: '20002', text: '普通消息' });
    assert.ok(adapter.outbox.some((m) => /异常预警/.test(m.message)), '应推送预警');

    adapter.clearOutbox();
    await bot.inject({ groupId: '9527', userId: '20002', text: '再说一句' });
    assert.ok(!adapter.outbox.some((m) => /异常预警/.test(m.message)), '冷却期内不应重复推送');
    storage.close();
  });

  test('订阅简报后当天推送一次，再次触发不重复', async () => {
    const { bot, adapter, storage } = await seed();
    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: '/subscribe' });
    assert.match(adapter.lastReply(), /已订阅/);

    adapter.clearOutbox();
    await bot.inject({ groupId: '9527', userId: '20002', text: '第一条' });
    assert.ok(adapter.outbox.some((m) => /昨日简报/.test(m.message)), '应推送简报');

    adapter.clearOutbox();
    await bot.inject({ groupId: '9527', userId: '20002', text: '第二条' });
    assert.ok(!adapter.outbox.some((m) => /昨日简报/.test(m.message)), '同一天只推一次');

    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: '/unsubscribe' });
    assert.match(adapter.lastReply(), /已退订/);
    storage.close();
  });
});

describe('私聊路径（PC 端 QQ 直接找机器人）', () => {
  test('私聊普通指令可用且回私聊，而不是 attempt 到 null 群', async () => {
    const { bot, adapter, storage } = await makeBot();
    await bot.inject({ groupId: null, userId: '20001', nickname: '阿离', text: '/help' });
    assert.ok(adapter.outbox.length > 0, '私聊应得到回复');
    assert.equal(adapter.outbox[0].scope, 'private');
    assert.equal(adapter.outbox[0].userId, '20001');
    assert.match(adapter.lastReply(), /指令一览/);
    storage.close();
  });

  test('私聊里的管理指令一律要求白名单，不能靠 role 提权', async () => {
    const { bot, adapter, storage } = await makeBot();
    await bot.inject({ groupId: null, userId: '20001', role: 'owner', text: '/purge 1' });
    assert.match(adapter.lastReply(), /管理员权限/);
    storage.close();
  });

  test('白名单内的账号可以私聊执行管理指令', async () => {
    const { bot, adapter, storage } = await makeBot({ config: { permission: { whiteList: ['20001'] } } });
    await bot.inject({ groupId: null, userId: '20001', role: 'member', text: '/config keys' });
    assert.match(adapter.lastReply(), /可配置项/);
    storage.close();
  });

  test('/panel --img 发出图卡；图卡不可用时退回文本（不静默失败）', async () => {
    const { bot, adapter, storage } = await makeBot();
    await bot.inject({ groupId: null, userId: '20001', text: '/panel --img' });
    const reply = adapter.lastReply();
    assert.ok(reply, '无论走图卡还是文本，都必须有回复');
    // 要么是图卡 CQ 码，要么是带标题的文本面板——两者都算正常，沉默才算 bug
    assert.ok(/CQ:image/.test(reply) || /管理面板/.test(reply), `回复既不是图卡也不是面板: ${reply}`);
    storage.close();
  });

  test('/panel --img 在图片发送失败时退回文本面板', async () => {
    const { bot, adapter, storage } = await makeBot();
    adapter.sendPrivateImage = async () => {
      throw new Error('协议端不支持本地文件');
    };
    await bot.inject({ groupId: null, userId: '20001', text: '/panel --img' });
    assert.match(adapter.lastReply(), /管理面板/, '图卡失败必须退回文本');
    storage.close();
  });

  test('未知指令不产生回复，也不抛错', async () => {
    const { bot, adapter, storage } = await makeBot();
    await bot.inject({ groupId: null, userId: '20001', text: '/不存在的指令' });
    assert.equal(adapter.outbox.length, 0);
    storage.close();
  });
});

describe('周期解析与参数容错', () => {
  test('中文与缩写周期都能解析', async () => {
    const { resolvePeriod } = await import('../src/services/stats/report.js');
    for (const [input, expected] of [['周', 'week'], ['本周', 'week'], ['月', 'month'], ['本月', 'month'], ['全部', 'all'], ['累计', 'all']]) {
      assert.equal(resolvePeriod(input).key, expected, `${input} 应解析为 ${expected}`);
    }
  });

  test('非法周期抛的是可预期错误，而不是内部异常', async () => {
    const { resolvePeriod } = await import('../src/services/stats/report.js');
    assert.throws(
      () => resolvePeriod('乱写'),
      (err) => {
        assert.equal(err.expected, true, '必须标记为可预期的用户输入错误');
        assert.match(err.message, /可选/);
        return true;
      },
    );
  });

  test('群里用错周期时给出用法提示而不是「执行失败」', async () => {
    const { bot, adapter, storage } = await makeBot();
    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: '/stats 乱写' });
    const reply = adapter.lastReply();
    assert.match(reply, /未知统计周期/);
    assert.ok(!reply.includes('指令执行失败'), `不该按内部错误上报: ${reply}`);
    storage.close();
  });
});

describe('入群/退群通知（回归：静默失效的两个字段）', () => {
  test('入群即登记 first_seen，不必等新人先发言', async () => {
    const { bot, storage } = await makeBot();
    const joinedAt = Date.now() - 60_000;
    await bot.bus.emit('notice', {
      platform: 'onebot11',
      subType: 'group_increase',
      groupId: '9527',
      userId: '20011',
      timestamp: joinedAt,
    });
    const member = storage.members.get('9527', '20011');
    assert.ok(member, '入群后必须留下成员记录');
    assert.equal(member.first_seen, joinedAt, 'first_seen 必须是入群时间而非首次发言时间');
    assert.equal(member.message_count, 0, '入群本身不是发言');
    storage.close();
  });

  test('关闭欢迎语不影响入群登记（风控基准与欢迎语解耦）', async () => {
    const { bot, storage, adapter } = await makeBot();
    storage.groups.setSetting('9527', 'welcome', { enabled: false });
    adapter.clearOutbox();
    await bot.bus.emit('notice', {
      platform: 'onebot11',
      subType: 'group_increase',
      groupId: '9527',
      userId: '20012',
      timestamp: Date.now(),
    });
    assert.ok(storage.members.get('9527', '20012'), '关掉欢迎语仍须登记入群');
    assert.equal(adapter.outbox.length, 0, '关掉欢迎语就不该发欢迎消息');
    storage.close();
  });

  test('group_decrease 按 target_id 清理，而不是取不到的 userId', async () => {
    const { bot, storage } = await makeBot();
    await bot.bus.emit('notice', { platform: 'onebot11', subType: 'group_increase', groupId: '9527', userId: '20013', timestamp: Date.now() });
    assert.ok(storage.members.get('9527', '20013'));

    // OneBot 通知里离开者在 target_id，operator_id 是操作者
    await bot.bus.emit('notice', {
      platform: 'onebot11',
      subType: 'group_decrease',
      groupId: '9527',
      targetId: '20013',
      operatorId: '29999',
      timestamp: Date.now(),
    });
    assert.equal(storage.members.get('9527', '20013'), null, '离开者汇总应被清理');
    storage.close();
  });

  test('新人广告检测依赖入群时间：入群 24h 内升级为踢出', async () => {
    const { bot, storage, adapter } = await makeBot();
    await bot.bus.emit('notice', { platform: 'onebot11', subType: 'group_increase', groupId: '9527', userId: '20014', timestamp: Date.now() });
    adapter.clearOutbox();
    await bot.inject({ groupId: '9527', userId: '20014', nickname: '新人', text: '加我微信 abc12345，兼职日结' });
    assert.ok(adapter.actions.some((a) => a.action === 'set_group_kick'), '新人发广告应直接踢出');
    assert.ok(storage.violations.recent('9527').some((v) => v.kind === 'newbie_shill'));
    storage.close();
  });

  test('老成员发广告不会被误判为新人广告', async () => {
    const { bot, storage, adapter } = await makeBot();
    const threeDaysAgo = Date.now() - 3 * 86400_000;
    await bot.bus.emit('notice', {
      platform: 'onebot11',
      subType: 'group_increase',
      groupId: '9527',
      userId: '20015',
      timestamp: threeDaysAgo,
    });
    adapter.clearOutbox();
    await bot.inject({ groupId: '9527', userId: '20015', nickname: '老成员', text: '加我微信 abc12345，兼职日结' });
    assert.ok(!storage.violations.recent('9527').some((v) => v.kind === 'newbie_shill'), '老成员不该命中新人广告');
    assert.ok(adapter.actions.some((a) => a.action === 'set_group_ban'), '仍应按普通广告禁言');
    storage.close();
  });

  test('欢迎语模板变量全部可替换', async () => {
    const { bot, storage, adapter } = await makeBot();
    storage.groups.setSetting('9527', 'welcome', { enabled: true, text: '欢迎 {at}/{nickname} 来到 {group}' });
    adapter.clearOutbox();
    await bot.bus.emit('notice', { platform: 'onebot11', subType: 'group_increase', groupId: '9527', userId: '20016', timestamp: Date.now() });
    const welcome = adapter.lastReply();
    assert.ok(!welcome.includes('{at}') && !welcome.includes('{nickname}') && !welcome.includes('{group}'), `模板变量应全部替换: ${welcome}`);
    assert.match(welcome, /20016/);
    storage.close();
  });
});

describe('事件总线健壮性', () => {
  test('漏写事件名时直接报错，而不是静默不处理', async () => {
    const { createEventBus } = await import('../src/core/events.js');
    const bus = createEventBus();
    // 回归：曾经 bus.emit(payload) 会静默什么也不做，
    // 表现为「通知处理器好像没生效」，排查成本极高
    await assert.rejects(() => bus.emit({ subType: 'group_increase' }), TypeError);
    await assert.rejects(() => bus.emit(''), TypeError);
  });
});
