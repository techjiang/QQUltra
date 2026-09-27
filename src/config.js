import { readFileSync, existsSync } from 'node:fs';
import { ConfigError } from './utils/errors.js';

export const DEFAULT_CONFIG = {
  logLevel: 'info',
  dataFile: 'data/qqultra.db',
  permission: { whiteList: [] },
  onebot: {
    mode: 'forward',
    wsUrl: 'ws://127.0.0.1:3001',
    accessToken: '',
    listenHost: '0.0.0.0',
    listenPort: 8642,
    reconnectDelay: 3000,
  },
  ai: {
    enabled: false,
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.7,
    maxTokens: 512,
    timeout: 60000,
    systemPrompt: null,
  },
  stats: { enabled: true, retentionDays: 180 },
  detect: { enabled: true },
  retention: { checkIntervalHours: 24 },
};

/**
 * 配置装载优先级：默认值 < 配置文件 < 环境变量。
 *
 * 环境变量前缀 QQU_，嵌套层级用双下划线分隔（QQU_AI__APIKEY → ai.apiKey），
 * 键名内部的下划线保留（QQU_STATS__RETENTIONDAYS → stats.retentionDays）。
 */
export function loadConfig({ file, env = process.env } = {}) {
  let fromFile = {};
  const path = file ?? env.QQU_CONFIG ?? findDefaultConfig(env);

  if (path && existsSync(path)) {
    try {
      fromFile = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new ConfigError(`配置文件解析失败 ${path}: ${err.message}`, { cause: err });
    }
  }

  const fromEnv = configFromEnv(env);
  const merged = mergeDeep(mergeDeep(DEFAULT_CONFIG, fromFile), fromEnv);
  validate(merged);
  return { config: merged, source: { file: path ?? null, envKeys: Object.keys(fromEnv) } };
}

function findDefaultConfig(env) {
  for (const candidate of ['qqultra.config.json', `${env.CNB_BUILD_WORKSPACE ?? '.'}/qqultra.config.json`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * QQU_STATS__RETENTIONDAYS → ['stats','retentionDays']
 *
 * 环境变量全大写且不能带驼峰，因此每段去掉下划线后要到默认配置里
 * 找同名的键（不分大小写）还原真实拼写；找不到就保持小写。
 */
export function envKeyToPath(key, reference = DEFAULT_CONFIG) {
  const segments = key
    .replace(/^QQU_/, '')
    .split('__')
    .map((part) => part.replace(/_/g, ''))
    .filter(Boolean);
  if (segments.length === 0) return null;

  const path = [];
  let cursor = reference;
  for (const segment of segments) {
    const matched = cursor && typeof cursor === 'object' ? Object.keys(cursor).find((k) => k.toLowerCase() === segment.toLowerCase()) : undefined;
    const resolved = matched ?? segment.toLowerCase();
    path.push(resolved);
    cursor = matched ? cursor[matched] : undefined;
  }
  return path;
}

export function configFromEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('QQU_') || !value) continue;
    const path = envKeyToPath(key);
    if (!path) continue;
    let cursor = out;
    for (const part of path.slice(0, -1)) {
      cursor[part] ??= {};
      cursor = cursor[part];
    }
    cursor[path.at(-1)] = coerce(value);
  }
  return out;
}

function coerce(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  if (value.startsWith('[') || value.startsWith('{')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function mergeDeep(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeDeep(base?.[k] ?? {}, v) : v;
  }
  return out;
}

function validate(config) {
  if (!['forward', 'reverse'].includes(config.onebot.mode)) {
    throw new ConfigError(`onebot.mode 只能是 forward/reverse，当前为 ${config.onebot.mode}`);
  }
  if (config.onebot.mode === 'forward' && !/^wss?:\/\//.test(config.onebot.wsUrl)) {
    throw new ConfigError(`onebot.wsUrl 必须是 ws:// 或 wss:// 开头，当前为 ${config.onebot.wsUrl}`);
  }
  if (config.onebot.mode === 'reverse' && !(config.onebot.listenPort > 0 && config.onebot.listenPort < 65536)) {
    throw new ConfigError(`onebot.listenPort 非法: ${config.onebot.listenPort}`);
  }
  if (config.ai.enabled && !config.ai.apiKey) {
    throw new ConfigError('ai.enabled 为 true 时必须提供 ai.apiKey');
  }
  if (!Number.isInteger(config.stats.retentionDays) || config.stats.retentionDays < 1) {
    throw new ConfigError(`stats.retentionDays 必须是 ≥1 的整数，当前为 ${config.stats.retentionDays}`);
  }
  return true;
}

/** 生成脱敏后的配置摘要，用于启动日志与 /status。 */
export function summarizeConfig(config) {
  return {
    onebot: { mode: config.onebot.mode, wsUrl: config.onebot.wsUrl, listenPort: config.onebot.listenPort },
    ai: {
      enabled: config.ai.enabled,
      model: config.ai.model,
      baseUrl: config.ai.baseUrl,
      apiKey: config.ai.apiKey ? '***' : '(未设置)',
    },
    stats: config.stats,
    detect: config.detect,
    logLevel: config.logLevel,
  };
}
