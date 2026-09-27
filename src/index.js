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

/** 数据保留清理：按 retentionDays 删除过期明细，返回清理条数。 */
export function runRetention(storage, { retentionDays, logger } = {}) {
  const cutoff = Date.now() - retentionDays * 86400_000;
  const messages = storage.messages.purgeBefore(cutoff);
  const violations = storage.violations.purgeBefore(cutoff);
  logger?.info(`保留策略：清理 ${messages} 条消息、${violations} 条违规记录`);
  return { messages, violations };
}
