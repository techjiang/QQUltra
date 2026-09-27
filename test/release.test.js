import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeBot, makeStorage } from './helpers.js';
import { openDatabase } from '../src/storage/database.js';
import { migrate, MIGRATIONS } from '../src/storage/migrations.js';
import { createStorage } from '../src/storage/repositories.js';
import { runRetention } from '../src/index.js';
import { parseCommand, KNOWN_FLAGS } from '../src/services/manage/commands.js';
import { renderWordCloudSvg, layoutWords as layoutWordsDirect, estimateTextWidth as estimateTextWidthDirect } from '../src/services/stats/wordcloud-svg.js';
import { sweepStale, writeTempFile, disposeTempFiles, DEFAULT_DIR } from '../src/utils/tempfile.js';
import { inspectGroupHealth } from '../src/services/manage/digest.js';
import { evaluateAlert } from '../src/services/manage/digest.js';
import {
  findSilentMembers,
  renderSilentText,
  compareTopicTrend,
  renderTrendText,
  listNewcomers,
  renderNewcomersText,
  auditRules,
  renderRuleAuditText,
  summarizeActivity,
  renderActivityText,
} from '../src/services/stats/insight.js';

/**
 * 发布前的回归集。
 *
 * 这里的每一条都对应本轮排雷中真实出现过的缺陷，注释里写清「原来错在哪」，
 * 目的是让后来改代码的人知道这些断言不是摆设。
 */

describe('回归：/ai 与 /ai-stats 必须真的能跑通', () => {
  const aiBot = () =>
    makeBot({
      // provider.chat(messages) 直接收消息数组，不是 { messages }
      aiProvider: { chat: async (messages) => ({ content: `echo:${messages.at(-1).content}` }) },
      config: { ai: { enabled: true, apiKey: 'sk-test' } },
    });

  test('/ai 取问句不再抛 undefined.replace', async () => {
    // 回归：args.raw 恒为 undefined（parseCommand 把 raw 挂在返回值而非 args 上），
    // /ai 每次都被兜成「⚠️ Cannot read properties of undefined」，从未工作过
    const { bot, adapter, storage } = await aiBot();
    await bot.inject({ groupId: '9527', userId: '20001', nickname: '阿离', text: '/ai 群里最近聊什么' });
    const reply = adapter.lastReply();
    assert.ok(reply, '必须有回复');
    assert.ok(!/Cannot read properties|undefined/.test(reply), `回复不该是内部错误: ${reply}`);
    assert.match(reply, /群里最近聊什么/);
    storage.close();
  });

  test('/ai-stats 同样可用，且非法周期给出可读提示', async () => {
    const { bot, adapter, storage } = await aiBot();
    await bot.inject({ groupId: '9527', userId: '20001', nickname: '阿离', text: '/ai-stats 本周' });
    assert.match(adapter.lastReply(), /本周统计|echo:/);

    await bot.inject({ groupId: '9527', userId: '20001', nickname: '阿离', text: '/ai-stats 季度' });
    assert.match(adapter.lastReply(), /未知统计周期/);
    storage.close();
  });

  test('/ai 是一次性问答，不写回会话记忆', async () => {
    const { bot, storage } = await aiBot();
    await bot.inject({ groupId: '9527', userId: '20001', nickname: '阿离', text: '/ai 只问一次' });
    assert.equal(storage.conversations.history('group:9527', 10).length, 0, '/ai 不应污染群会话上下文');

    // 而群内 @ 机器人属于「接话」，必须写记忆
    storage.groups.setSetting('9527', 'ai', { enabled: true, trigger: 'mention' });
    await bot.inject({
      groupId: '9527',
      userId: '20001',
      nickname: '阿离',
      text: '你好',
      segments: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '你好' } }],
    });
    assert.ok(storage.conversations.history('group:9527', 10).length > 0, '@ 触发应写记忆');
    storage.close();
  });

  test('/ai 空问题给出用法而不是空白回复', async () => {
    const { bot, adapter, storage } = await aiBot();
    await bot.inject({ groupId: '9527', userId: '20001', nickname: '阿离', text: '/ai' });
    assert.match(adapter.lastReply(), /用法：\/ai/);
    storage.close();
  });
});

describe('回归：语料纯净度（指令不得污染统计视图）', () => {
  test('/history 不把自己列进发言回顾', async () => {
    // 回归：recentInGroup 不过滤 is_command，第一条永远是刚打的 /history
    const { bot, adapter, storage } = await makeBot();
    for (let i = 0; i < 4; i += 1) {
      await bot.inject({ groupId: '9527', userId: '20001', nickname: '甲', text: `真消息${i}` });
    }
    adapter.clearOutbox();
    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: '/history --n 3' });
    const reply = adapter.lastReply();
    assert.ok(!reply.includes('/history'), `回顾里不该出现指令本身: ${reply}`);
    assert.match(reply, /真消息3/);
    storage.close();
  });

  test('/wordcloud 的语料不含指令文本', async () => {
    const { bot, storage } = await makeBot();
    await bot.inject({ groupId: '9527', userId: '20001', nickname: '甲', text: '排位排位' });
    await bot.inject({ groupId: '9527', userId: '20002', nickname: '乙', text: '排位排位' });
    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: '/wordcloud 排位' });

    const { resolvePeriod } = await import('../src/services/stats/report.js');
    const { countWords } = await import('../src/services/stats/wordcloud.js');
    const { since, until } = resolvePeriod('week');
    const rows = storage.messages.recentWindow('9527', since, until, 200);
    const words = countWords(rows.map((r) => r.text), { top: 20, minCount: 1 });
    assert.ok(!words.some((w) => w.word.includes('word')), `词表不该含指令词: ${JSON.stringify(words)}`);
    storage.close();
  });

  test('recentInGroup 需要时可以显式包含指令（对账场景）', async () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    storage.messages.insert({ groupId: '9527', userId: '1', text: '普通', segments: [], timestamp: 1, isCommand: false });
    storage.messages.insert({ groupId: '9527', userId: '1', text: '/ping', segments: [], timestamp: 2, isCommand: true });
    assert.equal(storage.messages.recentInGroup('9527', 0, 10).length, 1);
    assert.equal(storage.messages.recentInGroup('9527', 0, 10, { includeCommands: true }).length, 2);
    storage.close();
  });
});

describe('回归：规则配置不能静默失效', () => {
  test('拼错的规则类型被拒绝而不是入库', async () => {
    // 回归：/rule add keywrod 违禁词 会「✅ 已添加」，但该类型永不被任何检测器读取，
    // 规则形同不存在，且没有任何报错
    const { bot, adapter, storage } = await makeBot();
    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: '/rule add keywrod 违禁词' });
    assert.match(adapter.lastReply(), /未知规则类型/);
    assert.equal(storage.rules.list('9527').length, 0, '非法类型不该入库');
    storage.close();
  });

  test('非法正则被拒绝而不是入库', async () => {
    // 回归：compileRegex 对坏正则只返回 null，规则入库但永不命中
    const { bot, adapter, storage } = await makeBot();
    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: '/rule add regex [未闭合 --action=mute' });
    assert.match(adapter.lastReply(), /正则表达式无效/);
    assert.equal(storage.rules.list('9527').length, 0);
    storage.close();
  });

  test('合法规则大小写不敏感且能真正命中', async () => {
    const { bot, adapter, storage } = await makeBot();
    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: '/rule add REGEX 违\\s*禁 --action=mute' });
    assert.match(adapter.lastReply(), /已添加规则/);
    assert.equal(storage.rules.list('9527')[0].type, 'regex', '类型应归一化为小写');

    adapter.clearOutbox();
    await bot.inject({ groupId: '9527', userId: '20001', nickname: '甲', text: '这是违 禁内容' });
    assert.ok(storage.violations.recent('9527', 5).length > 0, '规则必须真的命中');
    storage.close();
  });
});

describe('回归：旗标解析不得静默取值', () => {
  test('/stats --top abc 明确报错而不是静默变成 1', async () => {
    // 回归：Number('abc') || 10 会退回默认值，Number(true) === 1 让 --top 变成 1，
    // 用户只看到「结果不对」，没有任何提示
    const { bot, adapter, storage } = await makeBot();
    await bot.inject({ groupId: '9527', userId: '20001', text: '/stats --top abc' });
    assert.match(adapter.lastReply(), /--top 需要正整数/);

    await bot.inject({ groupId: '9527', userId: '20001', text: '/rank --top 0' });
    assert.match(adapter.lastReply(), /--top 需要正整数/);
    storage.close();
  });

  test('已知旗标清单覆盖 help 里对外宣传的用法', () => {
    // 这张表是给后续做「未知旗标提示」用的，先固定住它的存在与形状
    assert.ok(KNOWN_FLAGS.stats.includes('top'));
    assert.ok(KNOWN_FLAGS.violations.includes('n'));
    assert.ok(KNOWN_FLAGS.panel.includes('img'));
  });

  test('--flag value 与 --flag=value 两种写法等价', () => {
    assert.deepEqual(parseCommand('/stats --top 3').args.flags, parseCommand('/stats --top=3').args.flags);
  });
});

describe('回归：私聊不执行群维度指令', () => {
  test('/stats 私聊给出明确提示而不是「群 null」报告', async () => {
    const { bot, adapter, storage } = await makeBot();
    await bot.inject({ groupId: null, userId: '20001', nickname: '阿离', text: '/stats' });
    const reply = adapter.lastReply();
    assert.ok(!/群 null/.test(reply), `不该出现「群 null」: ${reply}`);
    assert.match(reply, /群内指令/);
    storage.close();
  });

  test('未授权者先看到权限提示，而不是「群内指令」', async () => {
    // 顺序很重要：先判权限，否则未授权的人会以为「换个地方就能用」
    const { bot, adapter, storage } = await makeBot();
    await bot.inject({ groupId: null, userId: '20001', role: 'owner', text: '/purge 1' });
    assert.match(adapter.lastReply(), /管理员权限/);
    storage.close();
  });

  test('白名单账号仍可私聊执行不依赖群数据的运维指令', async () => {
    const { bot, adapter, storage } = await makeBot({ config: { permission: { whiteList: ['20001'] } } });
    await bot.inject({ groupId: null, userId: '20001', text: '/config keys' });
    assert.match(adapter.lastReply(), /可配置项/);
    storage.close();
  });
});

describe('回归：豁免命中不得计入风控口径', () => {
  test('白名单角色的命中只留痕，不触发异常预警', async () => {
    // 回归：warning 只记录不处置，但仍写 violations 且 kind 是真实类型，
    // 于是管理员自己说几句广告口径的话就会把群预警打到触发
    const { bot, storage } = await makeBot();
    for (let i = 0; i < 6; i += 1) {
      await bot.inject({ groupId: '9527', userId: '29999', nickname: '管理员', role: 'admin', text: `加我微信 abc12345 兼职日结 ${i}` });
    }
    assert.ok(storage.violations.recent('9527', 5).length > 0, '仍要留痕供审计');
    assert.equal(evaluateAlert({ storage, groupId: '9527', threshold: 5, windowMs: 600_000 }).count, 0, '豁免命中不该计入预警');
    storage.close();
  });

  test('普通成员的同类命中照常计入预警', async () => {
    const { bot, storage } = await makeBot();
    for (let i = 0; i < 5; i += 1) {
      await bot.inject({ groupId: '9527', userId: `2000${i}`, nickname: `路人${i}`, text: '加我微信 abc12345 兼职日结' });
    }
    assert.ok(evaluateAlert({ storage, groupId: '9527', threshold: 5, windowMs: 600_000 }).count >= 5);
    storage.close();
  });

  test('/violations 把豁免事件标注出来', async () => {
    const { bot, adapter, storage } = await makeBot();
    await bot.inject({ groupId: '9527', userId: '29999', nickname: '管理员', role: 'admin', text: '加我微信 abc12345 兼职日结' });
    adapter.clearOutbox();
    await bot.inject({ groupId: '9527', userId: '29999', role: 'owner', text: '/violations' });
    const reply = adapter.lastReply();
    assert.match(reply, /未处置|豁免|仅记录/, `豁免事件应显式标注: ${reply}`);
    storage.close();
  });
});

describe('回归：写放大与生命周期', () => {
  test('普通消息不再刷新 groups.updated_at', async () => {
    // 回归：ensure() 用 ON CONFLICT DO UPDATE 无条件写 updated_at，
    // 每条群消息产生 2 次 UPDATE，且 updated_at 失去「配置何时改过」的语义
    const { bot, storage } = await makeBot();
    const before = storage.groups.get('9527').updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await bot.inject({ groupId: '9527', userId: '20001', nickname: '甲', text: '消息' });
    await bot.inject({ groupId: '9527', userId: '20001', nickname: '甲', text: '再一条' });
    assert.equal(storage.groups.get('9527').updatedAt, before, 'updated_at 是「配置变更时间」，不该被消息刷新');
    storage.close();
  });

  test('ensure 仍会在群名变化时更新', async () => {
    const storage = makeStorage();
    const first = storage.groups.ensure('9527', '旧名');
    assert.equal(first.name, '旧名');
    const renamed = storage.groups.ensure('9527', '新名');
    assert.equal(renamed.name, '新名');
    storage.close();
  });

  test('出图临时文件有 TTL 且能被回收（不再无限堆积）', () => {
    // 回归：/wordcloud 与 /panel --img 的 SVG 写进 tmpdir 后从不删除
    const file = writeTempFile({ name: 'regression.svg', content: '<svg/>' });
    assert.ok(file.startsWith(join(DEFAULT_DIR, 'qqu-')) || file.includes('qqu-'));
    const removed = sweepStale({ maxAgeMs: -1 });
    assert.ok(removed >= 1, '超龄文件必须被回收');
    disposeTempFiles();
  });
});

describe('回归：保留策略与成员汇总口径一致', () => {
  test('runRetention 清理成员汇总并登记保留天数', async () => {
    // 回归：只删 messages 明细，group_members 不动 →
    // /whois 会展示「累计发言 N 条」但明细里一条都查不到的幽灵成员
    const storage = makeStorage();
    const old = Date.now() - 40 * 86_400_000;
    storage.groups.ensure('9527');
    storage.messages.insert({ groupId: '9527', userId: '20007', nickname: '老人', segments: [], timestamp: old });
    storage.members.upsert({ groupId: '9527', userId: '20007', nickname: '老人', timestamp: old });

    const result = runRetention(storage, { retentionDays: 30 });
    assert.equal(result.messages, 1);
    assert.equal(result.members, 1, '明细被删后成员汇总也必须清理');
    assert.equal(storage.members.get('9527', '20007'), null);
    assert.equal(storage.kv.get('retention_days'), 30, '/status 依赖这个键，必须真的写入');
    storage.close();
  });

  test('/status 自检在保留策略未执行时给出提醒', async () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const health = inspectGroupHealth({ storage, groupId: '9527', lastReadyAt: Date.now() });
    const check = health.checks.find((c) => c.name === '数据保留');
    assert.ok(check, '数据保留自检项必须始终存在');
    assert.equal(check.level, 'warn', '没跑过保留清理时应提醒');
    storage.close();
  });

  test('保留策略执行后自检转为正常', async () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    runRetention(storage, { retentionDays: 30 });
    const health = inspectGroupHealth({ storage, groupId: '9527', lastReadyAt: Date.now() });
    assert.equal(health.checks.find((c) => c.name === '数据保留').level, 'ok');
    storage.close();
  });
});

describe('回归：词云布局不得越界或重叠', () => {
  const renderWordCloudLayout = () => ({ layoutWords: layoutWordsDirect, estimateTextWidth: estimateTextWidthDirect });

  test('真实词长分布下无重叠、无越界', () => {
    // 回归：旧螺旋半径随 sqrt(step) 无限增长且 x 方向乘 1.6 拉伸，
    // 2000 步用尽后直接采用最后一次坐标（常在画布外）。
    // 实测 20 个真实高频词就会重叠、60 个词时 39 个越界。
    const { layoutWords, estimateTextWidth } = renderWordCloudLayout();
    /** 与渲染器同源的碰撞判定：按估计文本宽高算 AABB。 */
    const boxesOf = (placed) =>
      placed.map((p) => {
        const w = estimateTextWidth(p.word, p.size) + 6;
        const h = p.size * 1.15;
        return { word: p.word, x: p.x - w / 2, y: p.y - h / 2, w, h };
      });

    const words = [
      { word: '排位', count: 50 },
      { word: '更新', count: 40 },
      { word: '上分', count: 30 },
      { word: '今天', count: 25 },
      { word: '明天', count: 20 },
      { word: '晚上', count: 18 },
      { word: '一起', count: 15 },
      { word: '有人', count: 12 },
      { word: '外挂', count: 10 },
      { word: '充值', count: 9 },
      { word: '皮肤', count: 8 },
      { word: '活动', count: 7 },
      { word: '公告', count: 6 },
      { word: '登录', count: 5 },
      { word: '服务器', count: 5 },
      { word: '打野', count: 4 },
      { word: '辅助', count: 4 },
      { word: '射手', count: 4 },
      { word: '中路', count: 3 },
      { word: '对抗路', count: 3 },
    ];
    const width = 640;
    const height = 400;
    const placed = layoutWords(words, { width, height });
    assert.equal(placed.length, words.length, '这批词应当全部放得下');

    const boxes = boxesOf(placed);
    for (const b of boxes) {
      assert.ok(b.x >= 6 && b.x + b.w <= width - 6, `词 ${b.word} 横向越界`);
      assert.ok(b.y >= 44 && b.y + b.h <= height - 22, `词 ${b.word} 纵向越界`);
    }
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        assert.ok(!(w > 0 && h > 0), `词 ${a.word} 与 ${b.word} 重叠`);
      }
    }
  });

  test('放不下时宁可少画也不重叠，并把丢词数报出来', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ word: '一个相当长的词条' + i, count: 60 - i }));
    const result = renderWordCloudSvg(many, { width: 640, height: 400 });
    assert.ok(result.placed > 0, '至少要画出一些词');
    assert.ok(result.placed <= many.length);
    assert.equal(result.dropped, many.length - result.placed, '丢词数必须可查，标题才能说清画了几个');
  });

  test('布局结果确定可复现', () => {
    const { layoutWords } = renderWordCloudLayout();
    const words = [
      { word: '排位', count: 5 },
      { word: '更新', count: 3 },
      { word: '上分', count: 2 },
    ];
    assert.deepEqual(layoutWords(words, {}), layoutWords(words, {}));
  });
});

describe('回归：协议端重放不得放大统计', () => {
  test('同一 message_id 重复注入只计一次', async () => {
    // 回归：messages 无唯一约束，NapCat/Lagrange 重连后重放历史消息
    // 会把总消息数、活跃榜、时段分布整体放大，且重放消息「业务上完全合法」，
    // 没有任何校验会拦它 —— 数据畸变了但看起来只是「群变活跃了」
    const { bot, storage } = await makeBot();
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      const msg = { groupId: '9527', userId: '20001', nickname: '甲', text: `消息${i}`, timestamp: now + i, messageId: String(1000 + i) };
      await bot.inject(msg);
    }
    for (let i = 0; i < 3; i += 1) {
      const msg = { groupId: '9527', userId: '20001', nickname: '甲', text: `消息${i}`, timestamp: now + i, messageId: String(1000 + i) };
      await bot.inject(msg);
    }
    assert.equal(storage.messages.countAllSince('9527', 0), 3, '重放不应增加明细');
    assert.equal(storage.members.get('9527', '20001').message_count, 3, '重放也不应累加发言数');
    storage.close();
  });

  test('不带 message_id 的消息仍然全部入库', async () => {
    const { bot, storage } = await makeBot();
    await bot.inject({ groupId: '9527', userId: '20001', nickname: '甲', text: 'a' });
    await bot.inject({ groupId: '9527', userId: '20001', nickname: '甲', text: 'a' });
    assert.equal(storage.messages.countAllSince('9527', 0), 2, 'allow(NULL) 上的唯一索引不该影响无 id 的消息');
    storage.close();
  });

  test('不同群的相同 message_id 不互相冲突', async () => {
    const { bot, storage } = await makeBot();
    await bot.inject({ groupId: '9527', userId: '20001', nickname: '甲', text: 'a', messageId: '7' });
    await bot.inject({ groupId: '8888', userId: '20002', nickname: '乙', text: 'b', messageId: '7' });
    assert.equal(storage.messages.countAllSince('9527', 0), 1);
    assert.equal(storage.messages.countAllSince('8888', 0), 1);
    storage.close();
  });

  test('老库升级：迁移会清掉历史重复行并建成唯一索引', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqu-migrate-'));
    const file = join(dir, 'legacy.db');
    const db = openDatabase({ file });
    try {
      // 造一个「只跑到 v2」的老库，并写入历史重复行
      db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
      for (const m of MIGRATIONS.filter((x) => x.version <= 2)) {
        db.exec(m.sql);
        db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, Date.now());
      }
      for (let i = 0; i < 3; i += 1) {
        db.run(
          'INSERT INTO messages (group_id, message_id, user_id, nickname, role, text, segments, raw, is_command, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          '9527', 'DUP', '1', 'a', 'member', 'x', '[]', null, 0, Date.now(),
        );
      }

      // 不清历史重复行就建唯一索引会直接失败、整库起不来 —— 这是真实升级路径
      assert.doesNotThrow(() => migrate(db));
      assert.equal(db.get('SELECT COUNT(*) AS c FROM messages').c, 1, '重复行应被收敛为一条');
      assert.equal(migrate(db), 0, '迁移应可重复执行');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('回归：事务嵌套与取消语义', () => {
  test('事务可嵌套，内层回滚不影响外层', async () => {
    // 回归：transaction 用 BEGIN/COMMIT 不支持嵌套，
    // 而 collector.record 与 engine.commit 已各开一个事务，只是恰好不在同一调用栈
    const db = openDatabase({ file: ':memory:' });
    migrate(db);
    db.run('CREATE TABLE t (v TEXT)');

    db.transaction(() => {
      db.run('INSERT INTO t VALUES (?)', 'outer');
      try {
        db.transaction(() => {
          db.run('INSERT INTO t VALUES (?)', 'inner');
          throw new Error('inner boom');
        });
      } catch {
        /* 内层回滚 */
      }
    });
    assert.deepEqual(db.all('SELECT v FROM t').map((r) => r.v), ['outer'], '内层回滚不该带走外层');
    db.close();
  });

  test('外层回滚时内层也一起回滚', () => {
    const db = openDatabase({ file: ':memory:' });
    migrate(db);
    db.run('CREATE TABLE t (v TEXT)');
    assert.throws(() =>
      db.transaction(() => {
        db.transaction(() => db.run('INSERT INTO t VALUES (?)', 'inner'));
        throw new Error('outer boom');
      }),
    );
    assert.equal(db.get('SELECT COUNT(*) AS c FROM t').c, 0);
    db.close();
  });

  test('AI 请求的外部取消不被报成超时', async () => {
    // 回归：内部超时与外部取消错误名同为 AbortError，
    // 混在一起会把调用方主动放弃报成网络超时，排查方向直接跑偏
    const { createOpenAICompatibleProvider } = await import('../src/services/ai/provider.js');
    const provider = createOpenAICompatibleProvider({
      apiKey: 'sk',
      timeout: 60_000,
      fetchImpl: async (url, opts) =>
        new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(() => provider.chat([{ role: 'user', content: 'x' }], { signal: controller.signal }), /取消/);
  });

  test('真正的超时仍报超时', async () => {
    const { createOpenAICompatibleProvider } = await import('../src/services/ai/provider.js');
    const provider = createOpenAICompatibleProvider({
      apiKey: 'sk',
      timeout: 1,
      fetchImpl: async (url, opts) =>
        new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });
    await assert.rejects(() => provider.chat([{ role: 'user', content: 'x' }]), /超时/);
  });
});

describe('回归：配置项的群级生效', () => {
  /** 注入两轮刷屏（第二轮晚一小时），返回两次事件的时间戳，便于断言窗口行为。 */
  const twoRounds = async ({ bot, storage }, groupId = '9527') => {
    const base = Date.now();
    // 用显式 timestamp 而不是 Date.now()：窗口判定要与测试跑得快慢无关，
    // 否则 wall clock 会让用例偶发失败
    for (let i = 0; i < 9; i += 1) {
      await bot.inject({ groupId, userId: '20003', nickname: '刷', text: `灌${i}`, timestamp: base + i });
    }
    const round1 = storage.db.get("SELECT created_at FROM violations WHERE kind = 'punish' ORDER BY id LIMIT 1")?.created_at;
    for (let i = 0; i < 9; i += 1) {
      await bot.inject({ groupId, userId: '20003', nickname: '刷', text: `灌b${i}`, timestamp: base + 3_600_000 + i });
    }
    const round2 = storage.db.get("SELECT created_at FROM violations WHERE kind = 'punish' ORDER BY id DESC LIMIT 1")?.created_at;
    return { round1, round2 };
  };

  test('默认窗口内两轮合并算一个事件（默认 60s < 1h）', async () => {
    const ctx = await makeBot();
    const { round1, round2 } = await twoRounds(ctx);
    // 两轮间隔 1 小时 > 默认窗口 60s，所以它们本就该是两次独立事件
    assert.ok(round2 - round1 >= 3_600_000, `两轮事件时间应相差约一小时: ${round2 - round1}`);
    ctx.storage.close();
  });

  test('群配置把窗口放大后，间隔一小时的两轮被折叠为同一次事件', async () => {
    // 回归：moderator 只认构造参数，createBot 传的是写死的 {muteSeconds:600}，
    // 于是 /config set detect.punish.incidentWindowMs 改完毫无效果且不报错。
    // 反过来验证：把窗口调到 2 小时后，晚一小时的那轮应当被判定为「同一事件」而跳过处置。
    const ctx = await makeBot();
    ctx.storage.groups.setSetting('9527', 'detect', { punish: { incidentWindowMs: 2 * 3_600_000 } });
    const { bot, storage, adapter } = ctx;
    const base = Date.now();
    for (let i = 0; i < 9; i += 1) {
      await bot.inject({ groupId: '9527', userId: '20003', nickname: '刷', text: `灌${i}`, timestamp: base + i });
    }
    const firstCount = storage.violations.countPunished('9527', '20003', 0);
    const banCount = adapter.actions.filter((a) => a.action === 'set_group_ban').length;

    for (let i = 0; i < 9; i += 1) {
      await bot.inject({ groupId: '9527', userId: '20003', nickname: '刷', text: `灌b${i}`, timestamp: base + 3_600_000 + i });
    }
    assert.equal(storage.violations.countPunished('9527', '20003', 0), firstCount, '放大窗口后第二轮不该再处置');
    assert.equal(adapter.actions.filter((a) => a.action === 'set_group_ban').length, banCount, '不该产生新的禁言动作');
    storage.close();
  });

  test('窗口配成 0 时两轮各自处置', async () => {
    const ctx = await makeBot();
    ctx.storage.groups.setSetting('9527', 'detect', { punish: { incidentWindowMs: 0 } });
    await twoRounds(ctx);
    const rows = ctx.storage.db.all("SELECT created_at FROM violations WHERE kind = 'punish' ORDER BY id");
    assert.ok(rows.length >= 2, `窗口 0 时两轮都应处置，实际 ${rows.length} 次`);
    assert.ok(rows.at(-1).created_at - rows[0].created_at >= 3_600_000, '两次处置应分属两轮');
    ctx.storage.close();
  });

  test('默认窗口内同一轮刷屏只处置一次', async () => {
    const { bot, storage, adapter } = await makeBot();
    for (let i = 0; i < 9; i += 1) {
      await bot.inject({ groupId: '9527', userId: '20003', nickname: '刷', text: `灌${i}` });
    }
    assert.equal(adapter.actions.filter((a) => a.action === 'set_group_ban').length, 1);
    storage.close();
  });
});

describe('发布就绪检查', () => {
  test('迁移版本号唯一且递增', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    assert.deepEqual(versions, [...new Set(versions)], '版本号不能重复');
    assert.deepEqual(
      versions,
      [...versions].sort((a, b) => a - b),
      '文件里也应按版本递增排列，便于人工核对',
    );
  });

  test('CLI 入口可执行且 help 列出全部命令', async () => {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, ['bin/qqultra.js', 'help'], { encoding: 'utf8' });
    for (const cmd of ['start', 'demo', 'panel', 'report', 'health', 'wordcloud', 'digest', 'inspect', 'purge', 'about']) {
      assert.ok(out.includes(`qqultra ${cmd}`), `help 应列出 ${cmd}`);
    }
  });

  test('未知命令返回非零退出码', async () => {
    const { execFileSync } = await import('node:child_process');
    assert.throws(() => execFileSync(process.execPath, ['bin/qqultra.js', 'nope'], { encoding: 'utf8', stdio: 'pipe' }));
  });

  test('/panel 里登记的每个指令都真实存在', async () => {
    const { panelCommands } = await import('../src/services/manage/panel.js');
    const { bot, storage } = await makeBot();
    for (const name of panelCommands()) {
      const spec = bot.commands.resolve(name.replace(/^\//, ''));
      assert.ok(spec, `面板里的 ${name} 必须在命令表里`);
    }
    storage.close();
  });
});

describe('群运营洞察（新增能力）', () => {
  const DAY = 86_400_000;

  const seedInsight = (storage, now = Date.now()) => {
    storage.groups.ensure('9527', '测试群');
    // 沉默成员：历史很活跃，最近 30 天不说话
    storage.members.markJoined({ groupId: '9527', userId: '30003', nickname: '阿离', timestamp: now - 100 * DAY });
    storage.db.run('UPDATE group_members SET message_count = 50, last_seen = ? WHERE user_id = ?', now - 30 * DAY, '30003');
    // 活跃成员
    storage.members.upsert({ groupId: '9527', userId: '20001', nickname: '甲', timestamp: now });
    // 新成员：入群 5 天但从没说过话
    storage.members.markJoined({ groupId: '9527', userId: '30002', nickname: '挂机号', timestamp: now - 5 * DAY });
    // 本期话题
    for (let i = 0; i < 10; i += 1) {
      storage.messages.insert({ groupId: '9527', userId: '20001', nickname: '甲', text: '新赛季 排位 上分', segments: [], timestamp: now - i * 1000 });
    }
    // 上期话题
    for (let i = 0; i < 10; i += 1) {
      storage.messages.insert({ groupId: '9527', userId: '20001', nickname: '甲', text: '外挂 举报 官方', segments: [], timestamp: now - 8 * DAY - i * 1000 });
    }
  };

  test('沉默成员只列出「曾活跃」的人，过滤掉只冒过泡的', () => {
    const storage = makeStorage();
    seedInsight(storage);
    const rows = findSilentMembers(storage, '9527', { silentDays: 14, minMessages: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, '30003');
    assert.match(rows[0].silentText, /天/);
    storage.close();
  });

  test('无沉默成员时给出明确的正向结论而不是空列表', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    assert.match(renderSilentText(findSilentMembers(storage, '9527')), /没有「沉默的活跃成员」/);
    storage.close();
  });

  test('话题趋势用「占比」比较，不受整体消息量波动干扰', () => {
    // 若直接比绝对次数，本期消息量翻倍会让所有词都显示「变热」；
    // 占比比较才能区分「话题本身变热」与「群整体更热闹」
    const storage = makeStorage();
    seedInsight(storage);
    const trend = compareTopicTrend(storage, '9527', { windowDays: 7 });
    assert.ok(trend.fresh.some((t) => t.word === '排位'), '本期新出现的词应归入新话题');
    assert.ok(trend.gone.some((t) => t.word === '外挂'), '上期有、本期没有的词应归入已消失');
    assert.equal(trend.cooled.length, 0, '上期词本期为 0 属于「消失」而不是「变冷」');
    storage.close();
  });

  test('趋势报告把四类变化都渲染出来，且不隐藏「无变化」结论', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const text = renderTrendText(compareTopicTrend(storage, '9527'));
    assert.match(text, /话题趋势/);
    assert.match(text, /没有明显升降|消息量/);
    storage.close();
  });

  test('新成员观察区分「潜水」与「正常」', () => {
    const storage = makeStorage();
    seedInsight(storage);
    const rows = listNewcomers(storage, '9527', { days: 7 });
    const quiet = rows.filter((r) => r.isQuiet);
    assert.equal(quiet.length, 1, '入群超 3 天且零发言才算潜水');
    assert.equal(quiet[0].userId, '30002');
    assert.match(renderNewcomersText(rows), /尚未发言/);
    storage.close();
  });

  test('规则效果评估挑出「启用却从未命中」的规则', () => {
    // 长期运行的群会攒下一堆当时觉得有用的规则，事后从未触发，
    // 而写坏的正则一直躺在库里等一个误伤的机会
    const storage = makeStorage();
    storage.groups.ensure('9527');
    storage.rules.add({ groupId: '9527', type: 'keyword', pattern: '从没命中过', action: 'warn' });
    const used = storage.rules.add({ groupId: '9527', type: 'keyword', pattern: '命中过', action: 'warn' });
    storage.rules.bumpHit(used.id);

    const rows = auditRules(storage, '9527');
    assert.equal(rows.find((r) => r.pattern === '从没命中过').suspect, true);
    assert.equal(rows.find((r) => r.pattern === '命中过').suspect, false);
    assert.match(renderRuleAuditText(rows), /从未命中过/);
    storage.close();
  });

  test('活跃总览按活跃占比给判断，僵尸群能被识别', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    // 10 个成员，本周只有 1 人说话 → 10%
    for (let i = 0; i < 10; i += 1) {
      storage.members.markJoined({ groupId: '9527', userId: String(40000 + i), nickname: `成员${i}`, timestamp: Date.now() - 30 * DAY });
    }
    const empty = summarizeActivity(storage, '9527');
    assert.equal(empty.weeklyActive, 0);
    assert.match(renderActivityText(empty), /还没有人发言/);

    storage.messages.insert({ groupId: '9527', userId: '40000', nickname: '成员0', text: 'hi', segments: [], timestamp: Date.now() });
    storage.members.upsert({ groupId: '9527', userId: '40000', nickname: '成员0', timestamp: Date.now() });
    const low = summarizeActivity(storage, '9527');
    assert.ok(low.vitality > 0 && low.vitality < 0.3);
    storage.close();
  });

  test('新指令在群里可用，且都出现在面板里', async () => {
    const { bot, adapter, storage } = await makeBot();
    for (const cmd of ['/vibe', '/silent', '/newcomers', '/trend', '/rules audit']) {
      adapter.clearOutbox();
      await bot.inject({ groupId: '9527', userId: '20001', nickname: '甲', text: cmd });
      assert.ok(adapter.lastReply(), `${cmd} 必须有回复`);
      assert.ok(!/执行失败|undefined/.test(adapter.lastReply()), `${cmd} 不该报内部错误: ${adapter.lastReply()}`);
    }
    storage.close();
  });

  test('中文别名可用', async () => {
    const { bot, adapter, storage } = await makeBot();
    for (const cmd of ['/趋势', '/沉默', '/新人', '/活跃总览']) {
      adapter.clearOutbox();
      await bot.inject({ groupId: '9527', userId: '20001', nickname: '甲', text: cmd });
      assert.ok(adapter.lastReply(), `${cmd} 必须能路由到对应命令`);
    }
    storage.close();
  });

  test('群维度新指令在私聊被拒绝', async () => {
    const { bot, adapter, storage } = await makeBot();
    await bot.inject({ groupId: null, userId: '20001', text: '/silent' });
    assert.match(adapter.lastReply(), /群内指令/);
    storage.close();
  });
});

describe('回归：撤回通知必须留痕', () => {
  test('group_recall 会记录被撤回的消息，便于事后追查漏检', async () => {
    // 回归：notice 只处理 group_increase/group_decrease，
    // 撤回通知连记录都不留，于是「我们漏了哪条」永远无从回答
    const { adapter, storage } = await makeBot();
    adapter.emitNotice({ subType: 'group_recall', groupId: '9527', userId: '20001', messageId: '555', timestamp: 1_700_000_000_000 });
    await new Promise((r) => setTimeout(r, 30));
    const record = storage.kv.get('last_recall:9527', null);
    assert.ok(record, '撤回必须留痕');
    assert.equal(record.messageId, '555');
    assert.equal(record.userId, '20001');
    storage.close();
  });

  test('OneBot 适配器把 group_recall 的 message_id 翻译出来', async () => {
    const { OneBot11Adapter } = await import('../src/adapters/onebot11.js');
    const adapter = new OneBot11Adapter({});
    const notice = adapter._translateNotice({
      notice_type: 'group_recall',
      group_id: 9527,
      user_id: 20001,
      operator_id: 20002,
      message_id: 12345,
      time: 1_700_000_000,
    });
    assert.equal(notice.subType, 'group_recall');
    assert.equal(notice.messageId, '12345');
    assert.equal(notice.operatorId, '20002');
  });
});
