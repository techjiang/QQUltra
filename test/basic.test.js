import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, summarizeConfig, DEFAULT_CONFIG } from '../src/config.js';
import { normalizeText, defuse, segmentsToText, truncate } from '../src/utils/text.js';
import { startOfWeek, startOfMonth, formatDuration, parseDateBoundary } from '../src/utils/time.js';
import { parseCommand, createCommandRegistry } from '../src/services/manage/commands.js';
import { normalizeMessage, createEventBus } from '../src/core/events.js';

describe('配置装载', () => {
  test('默认配置可用且通过校验', () => {
    const { config } = loadConfig({ env: {} });
    assert.equal(config.onebot.mode, 'forward');
    assert.equal(config.stats.retentionDays, 180);
  });

  test('环境变量按双下划线展开为嵌套键', () => {
    const { config } = loadConfig({ env: { QQU_ONEBOT__WSURL: 'ws://x:1', QQU_STATS__RETENTIONDAYS: '30' } });
    assert.equal(config.onebot.wsUrl, 'ws://x:1');
    assert.equal(config.stats.retentionDays, 30);
  });

  test('开启 AI 但缺 apiKey 时报错', () => {
    assert.throws(() => loadConfig({ env: { QQU_AI__ENABLED: 'true' } }), /apiKey/);
  });

  test('非法 mode 被拒绝', () => {
    assert.throws(() => loadConfig({ env: { QQU_ONEBOT__MODE: 'carrier-pigeon' } }), /forward\/reverse/);
  });

  test('摘要脱敏 apiKey', () => {
    const { config } = loadConfig({ env: { QQU_AI__APIKEY: 'sk-secret-value' } });
    const summary = summarizeConfig(config);
    assert.equal(summary.ai.apiKey, '***');
    assert.equal(JSON.stringify(summary).includes('sk-secret-value'), false);
  });
});

describe('文本归一化（反绕过）', () => {
  test('全角转半角', () => {
    assert.equal(normalizeText('ＡＢＣ１２３'), 'ABC123');
  });

  test('零宽字符被清除', () => {
    assert.equal(normalizeText('加\u200b微\u200b信'), '加微信');
  });

  test('defuse 抹掉分隔符与标点，击穿「加 微-信」式规避', () => {
    assert.equal(defuse('加 微-信：abc'), '加微信abc');
    assert.ok(defuse('加 微 信 abc123').includes(defuse('加微信abc123')));
  });

  test('消息段转文本保留非文本占位', () => {
    const text = segmentsToText([
      { type: 'text', data: { text: '看图' } },
      { type: 'image', data: {} },
      { type: 'at', data: { qq: '123' } },
    ]);
    assert.equal(text, '看图[图片]@123');
  });

  test('truncate 不超长且带省略号', () => {
    assert.equal(truncate('abcdef', 4), 'abc…');
    assert.equal(truncate('abc', 10), 'abc');
  });
});

describe('时间工具', () => {
  test('周一为一周起点', () => {
    const wed = new Date(2026, 8, 23, 15, 30).getTime(); // 周三
    assert.equal(new Date(startOfWeek(wed)).getDay(), 1);
  });

  test('月份起点正确', () => {
    assert.equal(new Date(startOfMonth(new Date(2026, 8, 27, 9).getTime())).getDate(), 1);
  });

  test('解析日期边界', () => {
    assert.ok(parseDateBoundary('2026-09-27') > 0);
    assert.ok(parseDateBoundary('today') > 0);
    assert.throws(() => parseDateBoundary('前天'), /无法识别/);
  });

  test('时长格式化分层', () => {
    assert.equal(formatDuration(45_000), '45秒');
    assert.equal(formatDuration(90_000), '1分30秒');
    assert.equal(formatDuration(3 * 3600_000), '3小时0分');
  });
});

describe('命令解析', () => {
  test('解析位置参数与 --key=value', () => {
    const cmd = parseCommand('/stats week --top=5');
    assert.equal(cmd.name, 'stats');
    assert.deepEqual(cmd.args.positional, ['week']);
    assert.equal(cmd.args.flags.top, '5');
  });

  test('无前缀文本不算命令', () => {
    assert.equal(parseCommand('你好'), null);
    assert.equal(parseCommand('/'), null);
  });

  test('布尔 flag 无值时视为 true', () => {
    assert.equal(parseCommand('/rule add keyword 广告 --dry').args.flags.dry, true);
  });

  test('重复注册同名命令直接报错', () => {
    const reg = createCommandRegistry();
    reg.register('a', { run: () => '' });
    assert.throws(() => reg.register('a', { run: () => '' }), /重复注册/);
  });

  test('别名可路由到同一命令且权限沿用', () => {
    const reg = createCommandRegistry();
    reg.register('config', { aliases: ['cfg'], level: 'admin', run: () => '' });
    assert.equal(reg.get('cfg').name, 'config');
    assert.equal(reg.get('cfg').level, 'admin');
  });

  test('权限判定：member 放行、admin 拦普通人、白名单放行', () => {
    const reg = createCommandRegistry();
    reg.register('public', { run: () => '' });
    reg.register('admin', { level: 'admin', run: () => '' });
    assert.equal(reg.canRun(reg.get('public'), { role: 'member', userId: '1' }), true);
    assert.equal(reg.canRun(reg.get('admin'), { role: 'member', userId: '1' }), false);
    assert.equal(reg.canRun(reg.get('admin'), { role: 'admin', userId: '1' }), true);
    assert.equal(reg.canRun(reg.get('admin'), { role: 'member', userId: '9' }, { whiteList: ['9'] }), true);
  });
});

describe('事件总线', () => {
  test('订阅者按注册顺序串行执行', async () => {
    const bus = createEventBus();
    const order = [];
    bus.on('e', async () => { await new Promise((r) => setTimeout(r, 10)); order.push('slow'); });
    bus.on('e', () => order.push('fast'));
    await bus.emit('e', {});
    assert.deepEqual(order, ['slow', 'fast']);
  });

  test('单个订阅者抛错不影响其他订阅者', async () => {
    const bus = createEventBus();
    const seen = [];
    bus.on('e', () => { throw new Error('boom'); });
    bus.on('e', () => seen.push('ok'));
    await bus.emit('e', {});
    assert.deepEqual(seen, ['ok']);
  });

  test('normalizeMessage 统一群/私聊字段', () => {
    const group = normalizeMessage({ userId: 1, groupId: 2, text: 'x' });
    const priv = normalizeMessage({ userId: 1, text: 'x' });
    assert.equal(group.isGroup, true);
    assert.equal(group.userId, '1');
    assert.equal(priv.isGroup, false);
    assert.equal(priv.groupId, null);
  });
});

describe('默认配置完整性', () => {
  test('DEFAULT_CONFIG 不包含任何密钥默认值', () => {
    assert.equal(DEFAULT_CONFIG.ai.apiKey, '');
    assert.equal(DEFAULT_CONFIG.onebot.accessToken, '');
  });
});
