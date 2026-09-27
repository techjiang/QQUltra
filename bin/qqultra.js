#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createApp, runRetention } from '../src/index.js';
import { createBot } from '../src/core/bot.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { openDatabase } from '../src/storage/database.js';
import { migrate } from '../src/storage/migrations.js';
import { createStorage } from '../src/storage/repositories.js';
import { loadConfig, summarizeConfig } from '../src/config.js';
import { createLogger } from '../src/utils/logger.js';
import { buildGroupReport, renderReportText } from '../src/services/stats/report.js';

const USAGE = `QQUltra — 至尊QQ人工智能 / 群聊统计 / 自动化检测 / 群聊信息管理

用法：
  qqultra start            启动机器人（连接 OneBot 协议端）
  qqultra demo             离线演示：注入样例消息，展示统计与风控效果
  qqultra report <群号>     直接输出某群的统计报告（读本地库）
  qqultra inspect          查看当前配置（脱敏）
  qqultra purge [天数]      清理过期消息明细
  qqultra help             显示本帮助

环境变量：
  QQU_CONFIG               配置文件路径（默认 ./qqultra.config.json）
  QQU_ONEBOT__WSURL        协议端地址，如 ws://127.0.0.1:3001
  QQU_ONEBOT__ACCESSTOKEN  协议端 access_token
  QQU_AI__ENABLED          true 开启 AI 对话
  QQU_AI__APIKEY           AI 服务密钥
  QQU_AI__MODEL            模型名
  QQU_DATAFILE             数据文件路径
  QQU_LOGLEVEL             debug|info|warn|error
`;

const [command = 'help', ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case 'start':
      await cmdStart();
      break;
    case 'demo':
      await cmdDemo(rest);
      break;
    case 'report':
      cmdReport(rest);
      break;
    case 'inspect':
      cmdInspect();
      break;
    case 'purge':
      cmdPurge(rest);
      break;
    case 'version':
    case '--version':
    case '-v':
      printVersion();
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      break;
    default:
      console.error(`未知命令: ${command}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
} catch (err) {
  console.error(`\u001b[31m[错误] ${err.message}\u001b[0m`);
  if (process.env.QQU_LOGLEVEL === 'debug') console.error(err.stack);
  process.exitCode = 1;
}

function printVersion() {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  console.log(`${pkg.name} v${pkg.version} (node ${process.version})`);
}

async function cmdStart() {
  const app = await createApp();
  app.logger.info('QQUltra 启动中…');
  app.logger.info(summarizeConfig(app.config));

  const selfId = await app.bot.start();
  app.logger.info(`已就绪，机器人 QQ: ${selfId ?? '未知'}`);

  const retentionMs = app.config.retention.checkIntervalHours * 3600_000;
  const timer = setInterval(() => runRetention(app.storage, { retentionDays: app.config.stats.retentionDays, logger: app.logger }), retentionMs);

  const shutdown = async (signal) => {
    app.logger.info(`收到 ${signal}，正在退出…`);
    clearInterval(timer);
    await app.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * 离线演示：用内存库 + MockAdapter 走一遍完整链路。
 * 这是「无需 QQ 环境也能验证改动」的入口，也是文档里的快速上手示例。
 */
async function cmdDemo(args) {
  const { config } = loadConfig({ env: { ...process.env, QQU_DATAFILE: ':memory:' } });
  const logger = createLogger({ level: process.env.QQU_LOGLEVEL ?? 'info', scope: 'demo' });
  const db = openDatabase({ file: ':memory:' });
  migrate(db);
  const storage = createStorage({ db, logger });

  const adapter = new MockAdapter({ selfId: '10000', groupId: '9527' });
  const bot = createBot({
    config: { ...config, ai: { ...config.ai, enabled: false } },
    storage,
    adapter,
    logger,
  });

  await bot.start();
  if (!adapter.selfId) throw new Error('演示模式未能识别机器人账号');
  const now = Date.now();
  const group = '9527';
  storage.groups.ensure(group, 'QQUltra 演示群');

  logger.info('=== 1. 注入聊天消息，观察统计采集 ===');
  const scripted = [
    { userId: '20001', nickname: '阿离', text: '早上好各位' },
    { userId: '20002', nickname: '扫地僧', text: '早' },
    { userId: '20003', nickname: '路人甲', text: '今天有人打排位吗', offset: -20_000 },
    { userId: '20001', nickname: '阿离', text: '我我我', offset: -15_000 },
    { userId: '20003', nickname: '路人甲', text: '晚上八点', offset: -10_000 },
    { userId: '20001', nickname: '阿离', text: '约了', offset: -5_000 },
  ];
  for (const item of scripted) {
    await bot.inject({ groupId: group, ...item, timestamp: now + (item.offset ?? 0) });
  }
  logger.info(`已采集 ${storage.messages.countSince(group, 0)} 条消息`);

  logger.info('=== 2. 触发统计指令 /stats ===');
  adapter.clearOutbox();
  await bot.inject({ groupId: group, userId: '20001', nickname: '阿离', text: '/stats --period=all' });
  console.log('\n' + adapter.lastReply() + '\n');

  logger.info('=== 3. 触发广告引流检测（新人 + 联系方式 + 引流动词）===');
  adapter.clearOutbox();
  await bot.inject({ groupId: group, userId: '20009', nickname: '卖茶小妹', text: '加我微信 abc12345，兼职日结，免费领福利' });
  console.log('处罚动作: ' + JSON.stringify(adapter.actions.filter((a) => a.action !== 'send_group_msg')));
  for (const line of adapter.outbox.map((m) => m.message)) console.log('群内提示: ' + line);
  console.log();

  logger.info('=== 4. 触发刷屏检测（10 秒内超过 8 条）===');
  adapter.clearOutbox();
  for (let i = 0; i < 9; i += 1) {
    await bot.inject({ groupId: group, userId: '20003', nickname: '路人甲', text: `刷屏测试 ${i}` });
  }
  const punishActions = adapter.actions.filter((a) => a.action === 'set_group_ban');
  console.log(`禁言动作: ${punishActions.length} 次` + (punishActions[0] ? `（时长 ${punishActions[0].params.duration}s）` : ''));
  for (const line of adapter.outbox.map((m) => m.message)) console.log('群内提示: ' + line);
  console.log();

  logger.info('=== 5. 管理员查看违规记录与成员档案 ===');
  adapter.clearOutbox();
  await bot.inject({ groupId: group, userId: '29999', nickname: '群主', role: 'owner', text: '/me' });
  console.log(adapter.lastReply() + '\n');

  const report = buildGroupReport(storage, group, { period: 'all', top: 5 });
  logger.info('=== 6. 最终统计快照（机器人自身消息与指令不计入活跃榜）===');
  console.log(renderReportText(report));

  if (args.includes('--json')) console.log('\n' + JSON.stringify(report, null, 2));

  await bot.stop();
  storage.close();
}

function openLocalStorage() {
  const { config } = loadConfig();
  const logger = createLogger({ level: 'warn', scope: 'cli' });
  const db = openDatabase({ file: config.dataFile, logger });
  migrate(db, { logger });
  return { storage: createStorage({ db, logger }), config };
}

function cmdReport(args) {
  const groupId = args[0];
  if (!groupId) {
    console.error('用法：qqultra report <群号> [--period=today|week|month|all]');
    process.exitCode = 1;
    return;
  }
  const periodFlag = args.find((a) => a.startsWith('--period='));
  const period = periodFlag ? periodFlag.split('=')[1] : 'today';
  const { storage } = openLocalStorage();
  try {
    console.log(renderReportText(buildGroupReport(storage, groupId, { period })));
  } finally {
    storage.close();
  }
}

function cmdInspect() {
  const { config, source } = loadConfig();
  console.log('配置来源:', source.file ?? '默认值', source.envKeys.length ? `+ 环境变量 ${source.envKeys.join(', ')}` : '');
  console.log(JSON.stringify(summarizeConfig(config), null, 2));
}

function cmdPurge(args) {
  const { storage, config } = openLocalStorage();
  try {
    const days = Number(args[0] ?? config.stats.retentionDays);
    const { messages, violations } = runRetention(storage, { retentionDays: days });
    console.log(`已清理 ${messages} 条消息、${violations} 条违规记录（保留最近 ${days} 天）`);
  } finally {
    storage.close();
  }
}
