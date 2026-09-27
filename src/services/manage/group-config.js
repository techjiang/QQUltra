/**
 * 群级配置：存储为 groups.settings 的 JSON，读时与默认值深合并。
 *
 * detect 段与 DEFAULT_DETECT_CONFIG 同源：两处各写一份必然出现
 * 「群配置把全局默认挤掉」的问题（曾导致刷屏检测静默失效）。
 */
import { DEFAULT_DETECT_CONFIG } from '../detect/defaults.js';

export const GROUP_SETTINGS_DEFAULTS = {
  stats: { enabled: true, leaderboardSize: 10 },
  ai: {
    enabled: true,
    trigger: 'mention', // mention | prefix | all
    prefix: '/ai',
    maxReplyLength: 400,
    contextLines: 0,
  },
  detect: DEFAULT_DETECT_CONFIG,
  welcome: { enabled: false, text: '欢迎 {at} 加入本群，请先阅读群规～' },
  antispam: { enabled: true, autoApprove: false },
  /**
   * 异常预警：短时间内违规激增时主动提醒管理员。
   * 阈值定在 5 次/10 分钟——低于这个量级属正常摩擦，逐条提醒等于噪音；
   * 高于它通常意味着有人在批量灌广告或机器人抓到了突发刷屏。
   */
  alert: { enabled: true, threshold: 5, windowMs: 10 * 60_000 },
};

export function withDefaults(settings = {}) {
  const merge = (base, override) => {
    const out = { ...base };
    for (const [k, v] of Object.entries(override ?? {})) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] ?? {}, v) : v;
    }
    return out;
  };
  return merge(GROUP_SETTINGS_DEFAULTS, settings);
}

export function describeSettings(settings) {
  const s = withDefaults(settings);
  return [
    '⚙️ 本群 QQUltra 配置',
    `统计 ${s.stats.enabled ? '开' : '关'} | AI ${s.ai.enabled ? '开' : '关'}（触发：${s.ai.trigger}）`,
    `自动检测 ${s.detect.enabled ? '开' : '关'} | 自动处罚 ${s.detect.punish.enabled ? '开' : '关'}`,
    `入群欢迎 ${s.welcome.enabled ? '开' : '关'}`,
  ].join('\n');
}

/** 支持的配置项白名单，防止 /config set 写进任意键污染 settings。 */
export const SETTABLE_KEYS = {
  'stats.enabled': 'boolean',
  'alert.enabled': 'boolean',
  'alert.threshold': 'number',
  'ai.enabled': 'boolean',
  'ai.trigger': 'enum:mention,prefix,all',
  'ai.prefix': 'string',
  'ai.maxReplyLength': 'number',
  'ai.contextLines': 'number',
  'detect.enabled': 'boolean',
  'detect.punish.enabled': 'boolean',
  'detect.punish.muteSeconds': 'number',
  'welcome.enabled': 'boolean',
  'welcome.text': 'string',
  'antispam.enabled': 'boolean',
  'antispam.autoApprove': 'boolean',
};

export function coerceSetting(key, rawValue) {
  const spec = SETTABLE_KEYS[key];
  if (!spec) throw new Error(`不支持的配置项: ${key}`);
  if (spec === 'boolean') {
    if (rawValue === 'true' || rawValue === true) return true;
    if (rawValue === 'false' || rawValue === false) return false;
    throw new Error(`${key} 需要 true/false`);
  }
  if (spec === 'number') {
    const n = Number(rawValue);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${key} 需要非负数字`);
    return n;
  }
  if (spec.startsWith('enum:')) {
    const allowed = spec.slice(5).split(',');
    if (!allowed.includes(String(rawValue))) throw new Error(`${key} 只能是 ${allowed.join('/')}`);
    return String(rawValue);
  }
  return String(rawValue);
}

export function applySetting(group, key, rawValue) {
  const value = coerceSetting(key, rawValue);
  const [head, ...tail] = key.split('.');
  const settings = structuredClone(group.settings ?? {});
  settings[head] ??= {};
  let cursor = settings;
  for (const part of [head, ...tail].slice(0, -1)) {
    cursor[part] ??= {};
    cursor = cursor[part];
  }
  cursor[tail.at(-1) || head] = value;
  if (tail.length === 0) settings[head] = value;
  return { settings, value };
}
