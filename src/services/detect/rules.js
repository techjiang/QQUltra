import { defuse } from '../../utils/text.js';

/**
 * 内置检测器。每个检测器是纯函数：({ message, context }) => Finding | Finding[] | null。
 *
 * 设计约束：
 * - 检测器不执行处罚，只产出 finding，由 engine 决定动作（记录/警告/撤回/禁言）
 * - 时间与计数依赖 context 注入，方便测试里构造确定场景
 * - 规则可被运营用 DB 规则覆盖/关闭，见 engine
 */
export const RULE_TYPES = {
  KEYWORD: 'keyword',
  REGEX: 'regex',
  FLOOD: 'flood',
  AD: 'ad',
  LINK: 'link',
  REPEAT: 'repeat',
  LONG_TEXT: 'long_text',
  NEWBIE_SHILL: 'newbie_shill',
};

/** 关键词命中（支持 DB 规则，pattern 为关键词本体）。 */
export function keywordDetector({ rules, text }) {
  return rules
    .filter((r) => r.type === RULE_TYPES.KEYWORD)
    .map((rule) => {
      const target = rule.options?.defuse === false ? text : defuse(text);
      const needle = rule.options?.defuse === false ? rule.pattern : defuse(rule.pattern);
      if (!needle) return null;
      return target.includes(needle)
        ? { kind: RULE_TYPES.KEYWORD, ruleId: rule.id, detail: `命中关键词「${rule.pattern}」`, action: rule.action }
        : null;
    })
    .filter(Boolean);
}

/** 正则命中（pattern 为 /.../flags 或裸正则串）。 */
export function regexDetector({ rules, text }) {
  const findings = [];
  for (const rule of rules.filter((r) => r.type === RULE_TYPES.REGEX)) {
    const re = compileRegex(rule.pattern);
    if (!re) continue;
    const match = re.exec(text);
    if (match) {
      findings.push({ kind: RULE_TYPES.REGEX, ruleId: rule.id, detail: `命中规则「${rule.pattern}」→ ${match[0].slice(0, 40)}`, action: rule.action });
    }
  }
  return findings;
}

export function compileRegex(pattern) {
  try {
    const m = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
    return m ? new RegExp(m[1], m[2]) : new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * 刷屏：滑动窗口内消息数超阈值。
 * 只看条数不看内容，因此正常聊天很难误伤——阈值由群配置调。
 */
export function floodDetector({ context, config }) {
  const { windowMessages } = context;
  const limit = config.flood?.maxMessages ?? 8;
  if (windowMessages.length < limit) return null;
  return {
    kind: RULE_TYPES.FLOOD,
    detail: `${Math.round((config.flood?.windowMs ?? 10_000) / 1000)} 秒内发言 ${windowMessages.length} 条（阈值 ${limit}）`,
    action: config.flood?.action ?? 'mute',
  };
}

/** 复读：窗口内连续相同文本达到阈值。 */
export function repeatDetector({ context, config }) {
  const { windowMessages } = context;
  const limit = config.repeat?.maxTimes ?? 4;
  if (windowMessages.length < limit) return null;

  let streak = 1;
  for (let i = 1; i < windowMessages.length; i += 1) {
    if (defuse(windowMessages[i].text) === defuse(windowMessages[0].text) && defuse(windowMessages[0].text) !== '') streak += 1;
    else break;
  }
  if (streak < limit) return null;
  return {
    kind: RULE_TYPES.REPEAT,
    detail: `连续复读同样内容 ${streak} 次`,
    action: config.repeat?.action ?? 'warn',
  };
}

/**
 * 广告/引流：联系方式 + 引流动词同时出现才判定。
 * 单看联系方式会误伤正常交流（「我的邮箱是 xxx」），因此要求组合信号。
 *
 * 正则跑在 defuse 后的文本上（已去空白与标点），
 * 否则「加 微-信：a b c 1 2 3」这种分隔符写法能直接绕过。
 */
const CONTACT_PATTERNS = [
  /(?:qq|扣扣|企鹅):?\d{5,12}/,
  /(?:微信|weixin|wx|vx|v信|威信):?[a-z0-9_-]{5,20}/,
  /(?:telegram|tg|电报|飞机):?@?[a-z0-9_]{4,32}/,
  /https?:\/\/[^\s]{4,}/,
  /\b\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}\b/,
];

const SHILL_VERBS = ['加我', '私聊', '加群', '进群', '带单', '返利', '优惠', '免费领', '兼职', '日结', '刷单', '代理', '开户', '引流', '推广', '秒到账', '返佣', '福利'];

export function adDetector({ text }) {
  const d = defuse(text);
  const contacts = CONTACT_PATTERNS.map((re) => re.exec(d)?.[0]).filter(Boolean);
  if (contacts.length === 0) return null;

  const verb = SHILL_VERBS.find((v) => d.includes(defuse(v)));
  if (!verb) return null;

  return {
    kind: RULE_TYPES.AD,
    detail: `疑似引流广告：出现「${verb}」并附带联系方式 ${contacts[0].slice(0, 40)}`,
    action: 'mute',
  };
}

/** 裸链接刷屏（非白名单域名）。 */
export function linkDetector({ text, config }) {
  const urls = text.match(/https?:\/\/[^\s]+/g);
  if (!urls || urls.length === 0) return null;
  const whitelist = config.link?.whitelist ?? [];
  const blocked = urls.filter((u) => !whitelist.some((w) => u.includes(w)));
  const maxLinks = config.link?.maxLinks ?? 3;
  if (blocked.length < maxLinks) return null;
  return { kind: RULE_TYPES.LINK, detail: `单条消息含 ${blocked.length} 个未授信链接`, action: config.link?.action ?? 'warn' };
}

/** 超长文本（常见于刷屏小作文、复制粘贴轰炸）。 */
export function longTextDetector({ text, config }) {
  const limit = config.longText?.maxLength ?? 1000;
  if (text.length <= limit) return null;
  return { kind: RULE_TYPES.LONG_TEXT, detail: `单条文本 ${text.length} 字（阈值 ${limit}）`, action: config.longText?.action ?? 'warn' };
}

/** 新人短时间内打广告：入群 24h 内 + 广告特征，处罚升级。 */
export function newbieShillDetector({ context, config }) {
  const { adFinding, member } = context;
  if (!adFinding || !member) return null;
  const ageLimit = (config.newbie?.windowHours ?? 24) * 3600_000;
  if (context.now - member.first_seen > ageLimit) return null;
  return { kind: RULE_TYPES.NEWBIE_SHILL, detail: '新成员入群 24 小时内发送引流广告', action: 'kick' };
}

export const BUILTIN_DETECTORS = [
  keywordDetector,
  regexDetector,
  adDetector,
  newbieShillDetector,
  repeatDetector,
  floodDetector,
  linkDetector,
  longTextDetector,
];

/** 动作升级：同一用户违规次数越多，处置越重。 */
export const ACTION_LADDER = ['warn', 'warn', 'mute', 'mute', 'kick'];

export function escalateAction(baseAction, violationCount, ladder = ACTION_LADDER) {
  const idx = Math.min(violationCount, ladder.length - 1);
  const escalated = ladder[idx];
  if (baseAction === 'kick') return 'kick';
  if (baseAction === 'mute' && escalated === 'warn') return 'mute';
  return escalated;
}
