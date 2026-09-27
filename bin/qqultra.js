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
import { buildGroupReport, renderReportText, resolvePeriod } from '../src/services/stats/report.js';
import { ASCII_LOGO, renderAboutText, PROJECT, AUTHOR } from '../src/assets/brand.js';
import { DISCLAIMER_TEXT, DISCLAIMER_SHORT } from '../src/assets/disclaimer.js';
import { VERSION } from '../src/version.js';
import { renderPanel } from '../src/services/manage/panel.js';
import { inspectGroupHealth, renderHealthText, buildDailyDigest } from '../src/services/manage/digest.js';
import { countWords, renderWordCloudText } from '../src/services/stats/wordcloud.js';
import { disposeTempFiles } from '../src/utils/tempfile.js';
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

const USAGE = `${ASCII_LOGO}

${PROJECT.name} v${VERSION} — ${PROJECT.slogan}
作者 ${AUTHOR.name} · ${AUTHOR.site}

用法：
  qqultra start            启动机器人（连接 OneBot 协议端）
  qqultra demo             离线演示：注入样例消息，展示统计与风控效果
  qqultra panel [--role=admin]  预览 PC 端 QQ 内的管理面板
  qqultra report <群号>     直接输出某群的统计报告（读本地库）
  qqultra health [群号]     运行自检并输出健康报告
  qqultra wordcloud <群号>  在终端生成词云（读本地库）
  qqultra digest <群号>     预览每日简报内容
  qqultra insight <群号>    群运营洞察（活跃总览/沉默成员/话题趋势/新成员/规则效果）
  qqultra inspect          查看当前配置（脱敏）
  qqultra purge [天数]      清理过期消息明细
  qqultra about            作者与项目信息（含完整免责声明）
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

${DISCLAIMER_SHORT}
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
    case 'panel':
      cmdPanel(rest);
      break;
    case 'health':
      cmdHealth(rest);
      break;
    case 'wordcloud':
      cmdWordcloud(rest);
      break;
    case 'digest':
      cmdDigest(rest);
      break;
    case 'insight':
      cmdInsight(rest);
      break;
    case 'about':
      console.log(renderAboutText({ version: VERSION }));
      console.log('\n' + ASCII_LOGO);
      console.log('\n' + DISCLAIMER_TEXT);
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
  console.log(`${PROJECT.slogan}`);
  console.log(`作者 ${AUTHOR.name} · ${AUTHOR.site} · QQ群 ${AUTHOR.qqGroups.join(' / ')}`);
}

/** 预览 PC 端 QQ 里会看到的管理面板。 */
function cmdPanel(args) {
  const role = (args.find((a) => a.startsWith('--role=')) ?? '--role=admin').split('=')[1];
  const whiteListed = args.includes('--white');
  console.log(renderPanel({ role, whiteListed, groupName: null }));
}

function cmdHealth(args) {
  const groupId = args[0] ?? null;
  const { storage, config } = openLocalStorage();
  try {
    if (groupId) {
      const health = inspectGroupHealth({
        storage,
        groupId,
        lastReadyAt: storage.kv.get('last_ready_at', null),
        adapterName: 'onebot11',
      });
      console.log(renderHealthText(health));
      return;
    }
    const groups = storage.groups.list();
    if (groups.length === 0) {
      console.log('本地库还没有任何群记录，先启动机器人接收消息');
      return;
    }
    console.log(`共 ${groups.length} 个群，数据文件 ${config.dataFile}\n`);
    for (const g of groups) {
      const health = inspectGroupHealth({ storage, groupId: g.groupId, lastReadyAt: storage.kv.get('last_ready_at', null) });
      console.log(`群 ${g.groupId}${g.name ? `（${g.name}）` : ''} → ${health.level}`);
      for (const c of health.checks.filter((x) => x.level !== 'ok')) console.log(`  · ${c.name}：${c.detail}`);
    }
  } finally {
    storage.close();
  }
}

function cmdWordcloud(args) {
  const groupId = args[0];
  if (!groupId) {
    console.error('用法：qqultra wordcloud <群号> [--period=week] [--top=20]');
    process.exitCode = 1;
    return;
  }
  const period = (args.find((a) => a.startsWith('--period=')) ?? '--period=all').split('=')[1];
  const top = Number((args.find((a) => a.startsWith('--top=')) ?? '--top=20').split('=')[1]);
  const { storage } = openLocalStorage();
  try {
    const { since, until, label } = resolvePeriod(period);
    const rows = storage.messages.recentInGroup(groupId, since, 5000).filter((r) => r.created_at < until);
    const words = countWords(rows.map((r) => r.text), { top, minCount: 2 });
    console.log(`☁️ ${label}词云（${rows.length} 条消息）\n`);
    console.log(renderWordCloudText(words, { limit: top }));
  } finally {
    storage.close();
  }
}

/**
 * 群运营洞察：一次输出全部「判断层」信息。
 * 与 /vibe、/silent 等群内指令共用同一批纯函数，保证 CLI 和群内口径一致。
 */
function cmdInsight(args) {
  const groupId = args[0];
  if (!groupId) {
    console.error('用法：qqultra insight <群号>');
    process.exitCode = 1;
    return;
  }
  const { storage } = openLocalStorage();
  try {
    const sections = [
      renderActivityText(summarizeActivity(storage, groupId), { groupId }),
      '',
      renderSilentText(findSilentMembers(storage, groupId)),
      '',
      renderTrendText(compareTopicTrend(storage, groupId)),
      '',
      renderNewcomersText(listNewcomers(storage, groupId)),
      '',
      renderRuleAuditText(auditRules(storage, groupId)),
    ];
    console.log(sections.join('\n'));
  } finally {
    storage.close();
  }
}

function cmdDigest(args) {
  const groupId = args[0];
  if (!groupId) {
    console.error('用法：qqultra digest <群号>');
    process.exitCode = 1;
    return;
  }
  const { storage } = openLocalStorage();
  try {
    console.log(buildDailyDigest(storage, groupId).text);
  } finally {
    storage.close();
  }
}

async function cmdStart() {
  console.log(ASCII_LOGO);
  console.log(`  ${PROJECT.name} v${VERSION} · 作者 ${AUTHOR.name}\n`);
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
    // 退出时清掉本次进程写出的图卡临时文件；上次遗留的那些已在 createBot 启动时回收
    const removed = disposeTempFiles();
    if (removed > 0) app.logger.debug(`已清理 ${removed} 个临时出图文件`);
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
  disposeTempFiles();
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
    const { messages, violations, members } = runRetention(storage, { retentionDays: days });
    console.log(`已清理 ${messages} 条消息、${violations} 条违规记录、${members} 条空成员汇总（保留最近 ${days} 天）`);
  } finally {
    storage.close();
  }
}
