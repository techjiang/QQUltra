export { createBot, HELP } from './core/bot.js';
export { createEventBus, normalizeMessage, EVENTS } from './core/events.js';
export { Adapter } from './core/adapter.js';
export { OneBot11Adapter } from './adapters/onebot11.js';
export { openDatabase } from './storage/database.js';
export { migrate } from './storage/migrations.js';
export { createStorage } from './storage/repositories.js';
export { loadConfig, DEFAULT_CONFIG, summarizeConfig } from './config.js';
export { createLogger } from './utils/logger.js';
export { buildGroupReport, renderReportText, buildMemberProfile } from './services/stats/report.js';
export { createDetectEngine, DEFAULT_DETECT_CONFIG } from './services/detect/engine.js';
export { BUILTIN_DETECTORS, RULE_TYPES } from './services/detect/rules.js';
export { createOpenAICompatibleProvider } from './services/ai/provider.js';
export { parseCommand } from './services/manage/commands.js';
export { withDefaults, SETTABLE_KEYS } from './services/manage/group-config.js';

import { createBot } from './core/bot.js';
import { OneBot11Adapter } from './adapters/onebot11.js';
import { openDatabase } from './storage/database.js';
import { migrate } from './storage/migrations.js';
import { createStorage } from './storage/repositories.js';
import { loadConfig } from './config.js';
import { createLogger } from './utils/logger.js';

/**
 * 一站式启动：装载配置 → 打开存储 → 迁移 → 装配适配器与 Bot。
 * 需要自定义适配器（如跨平台）时用各模块单独组合，而不是改这个函数。
 */
export async function createApp({ file, env } = {}) {
  const { config, source } = loadConfig({ file, env });
  const logger = createLogger({ level: config.logLevel, scope: 'app' });

  const db = openDatabase({ file: config.dataFile, logger });
  migrate(db, { logger });
  const storage = createStorage({ db, logger });

  const adapter = new OneBot11Adapter({ ...config.onebot, logger: logger.child('onebot'), logLevel: config.logLevel });
  const bot = createBot({ config, storage, adapter, logger: logger.child('bot') });

  logger.info(`配置来源: ${source.file ?? '默认值' + (source.envKeys.length ? ` + 环境变量(${source.envKeys.join(',')})` : '')}`);

  return {
    config,
    logger,
    storage,
    adapter,
    bot,
    async shutdown() {
      await bot.stop().catch(() => {});
      storage.close();
    },
  };
}

/**
 * 数据保留清理：按 retentionDays 删除过期明细。
 *
 * 三件事必须一起做，否则「清了多少」和「库里还剩什么」对不上：
 * 1. 删过期消息明细
 * 2. 删过期违规记录
 * 3. 清理明细已删但汇总仍在的成员行（否则 /whois 会一直展出「幽灵成员」）
 * 4. 把实际生效的保留天数写进 kv —— /status 的「数据保留」自检项依赖它，
 *    之前这个键从来没被写入过，于是那一项永远不会显示，
 *    运维以为自己在跑保留策略，实际上无从确认。
 */
export function runRetention(storage, { retentionDays, logger, now = Date.now() } = {}) {
  const cutoff = now - retentionDays * 86400_000;
  const messages = storage.messages.purgeBefore(cutoff);
  const violations = storage.violations.purgeBefore(cutoff);
  const members = storage.members.purgeBefore(cutoff);
  storage.kv.set('retention_days', retentionDays);
  storage.kv.set('retention_last_run_at', now);
  logger?.info(
    `保留策略：清理 ${messages} 条消息、${violations} 条违规、${members} 条空成员汇总（保留 ${retentionDays} 天）`,
  );
  return { messages, violations, members };
}
