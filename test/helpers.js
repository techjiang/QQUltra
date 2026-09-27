import { openDatabase } from '../src/storage/database.js';
import { migrate } from '../src/storage/migrations.js';
import { createStorage } from '../src/storage/repositories.js';
import { createLogger } from '../src/utils/logger.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { createBot } from '../src/core/bot.js';
import { DEFAULT_CONFIG, mergeDeep } from '../src/config.js';

export const silentLogger = createLogger({ level: 'silent' });

/** 内存库 + 已迁移的存储，测试间完全隔离。 */
export function makeStorage() {
  const db = openDatabase({ file: ':memory:' });
  migrate(db, { logger: silentLogger });
  return createStorage({ db, logger: silentLogger });
}

export async function makeBot(overrides = {}) {
  const storage = overrides.storage ?? makeStorage();
  const adapter = overrides.adapter ?? new MockAdapter({ selfId: '10000', groupId: '9527', logger: silentLogger });
  const config = mergeDeep(
    { ...DEFAULT_CONFIG, logLevel: 'silent', ai: { ...DEFAULT_CONFIG.ai, enabled: false } },
    overrides.config ?? {},
  );
  const bot = createBot({
    config,
    storage,
    adapter,
    logger: silentLogger,
    ...(overrides.aiProvider !== undefined ? { aiProvider: overrides.aiProvider } : {}),
  });
  await bot.start();
  storage.groups.ensure('9527', '测试群');
  return { bot, storage, adapter };
}

/** 断言某段文本出现在回复里。 */
export function expectIncludes(actual, needle, label = '') {
  if (!String(actual).includes(needle)) {
    throw new Error(`${label} 期望包含「${needle}」，实际为：${String(actual).slice(0, 300)}`);
  }
}
