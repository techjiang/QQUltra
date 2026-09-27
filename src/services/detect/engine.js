import { normalizeText } from '../../utils/text.js';
import { escalateAction, BUILTIN_DETECTORS, RULE_TYPES } from './rules.js';
import { withDefaults } from '../manage/group-config.js';
import { DEFAULT_DETECT_CONFIG } from './defaults.js';

export { DEFAULT_DETECT_CONFIG };

/**
 * 检测引擎：跑一遍检测器 → 合并 finding → 决定动作 → 落库 + 返回处置指令。
 *
 * 引擎只输出「打算做什么」（Decision），执行动作由调用方（bot 主循环）通过适配器完成。
 * 这样引擎可脱离 QQ 环境单测，也避免检测逻辑里散落网络调用。
 */
export function createDetectEngine({ storage, logger, config: globalConfig = {} }) {
  return {
    /**
     * @returns {{ findings: Finding[], decision: Decision, violationCount: number }}
     */
    inspect(message, { detectors = BUILTIN_DETECTORS } = {}) {
      // withDefaults 已保证群配置是完整结构（含各组检测器默认值），
      // 再按 全局默认 ← 启动配置 ← 群配置 的顺序覆盖
      const groupConfig = withDefaults(storage.groups.get(message.groupId)?.settings ?? {}).detect;
      const config = mergeConfig(DEFAULT_DETECT_CONFIG, mergeConfig(globalConfig, groupConfig));
      if (!config.enabled) return { findings: [], decision: { action: 'none', reason: '检测已关闭' }, violationCount: 0 };

      const text = normalizeText(message.text);
      const rules = storage.rules.list(message.groupId).filter((r) => r.enabled && (r.type === RULE_TYPES.KEYWORD || r.type === RULE_TYPES.REGEX));
      const windowMessages = storage.messages.recentByUser(
        message.groupId,
        message.userId,
        message.timestamp - config.windowMs,
        message.timestamp,
      );
      const member = storage.members.get(message.groupId, message.userId);

      // 检测器的统一入参：config 在顶层（通用配置），context 放跨检测器的协作信息
      const context = { windowMessages, member, now: message.timestamp };

      // 顺序敏感：广告检测要先出结果，新人广告检测依赖它
      const findings = [];
      for (const detector of detectors) {
        let result;
        try {
          result = detector({
            message,
            text,
            rules,
            config,
            context: { ...context, adFinding: findings.find((f) => f.kind === RULE_TYPES.AD) },
          });
        } catch (err) {
          logger?.warn(`检测器 ${detector.name} 执行失败: ${err.message}`);
          continue;
        }
        if (!result) continue;
        findings.push(...(Array.isArray(result) ? result : [result]));
      }

      if (findings.length === 0) return { findings: [], decision: { action: 'none' }, violationCount: 0 };

      // 升级依据是「已发生过的违规事件数」，而非命中条数：
      // 一次刷屏会连续命中多条消息，按条数算会一步顶到最重处罚。
      const since = message.timestamp - 7 * 24 * 3600_000;
      const priorCount = storage.violations.countPunished(message.groupId, message.userId, since);
      const action = this.decide(findings, { config, message, priorCount });

      return { findings, decision: action, violationCount: priorCount + 1 };
    },

    decide(findings, { config, message, priorCount }) {
      const { punish } = config;
      if (!punish.enabled) return { action: 'none', reason: '处罚已关闭，仅记录' };
      if (punish.trustedRoles.includes(message.role)) {
        return { action: 'none', reason: `角色 ${message.role} 在白名单内，仅记录` };
      }

      // 取最重的动作：一条消息可能同时命中多条规则，按最严处置
      const weight = { none: 0, warn: 1, mute: 2, kick: 3 };
      const top = findings.reduce((acc, f) => (weight[f.action] > weight[acc] ? f.action : acc), 'none');
      const finalAction = punish.escalate ? escalateAction(top, priorCount) : top;

      return {
        action: finalAction,
        reason: findings.map((f) => f.detail).join('；'),
        muteSeconds: finalAction === 'mute' ? punish.muteSeconds : 0,
        ruleIds: findings.map((f) => f.ruleId).filter((id) => id !== undefined),
      };
    },

    /**
     * 落库：命中记录全部留痕（供人工申诉时追溯），
     * 并在同一事务里写一条 kind='punish' 的事件记录。
     *
     * 区分两类记录的原因是升级阶梯只认「事件」：
     * kind 存具体的规则类型（flood/ad/...），punish 代表「这次真的处置了」。
     * 只有真正处置时才写 punish，因此同一事件窗口内的重复命中不会重复升级。
     */
    commit(message, findings, decision, { executed } = {}) {
      if (findings.length === 0) return;
      storage.db.transaction(() => {
        for (const f of findings) {
          storage.violations.add({
            groupId: message.groupId,
            userId: message.userId,
            ruleId: f.ruleId ?? null,
            kind: f.kind,
            detail: f.detail,
            action: decision.action,
          });
          if (f.ruleId) storage.rules.bumpHit(f.ruleId);
        }

        // executed 有值代表这次真的执行了处置，写一条事件记录供升级阶梯计数
        if (executed) {
          storage.violations.add({
            groupId: message.groupId,
            userId: message.userId,
            kind: 'punish',
            detail: decision.reason,
            action: executed,
          });
        }
      });
      logger?.info(`违规记录 group=${message.groupId} user=${message.userId} kind=${findings.map((f) => f.kind).join(',')} action=${decision.action}`);
    },

    /**
     * 判断这次违规是否应触发升级计数。
     * 同一事件窗口内的连续命中视为同一次违规，不重复计入。
     */
    isNewIncident(message, { incidentWindowMs } = {}) {
      const groupConfig = withDefaults(storage.groups.get(message.groupId)?.settings ?? {}).detect;
      const windowMs =
        incidentWindowMs ??
        mergeConfig(DEFAULT_DETECT_CONFIG, mergeConfig(globalConfig, groupConfig)).punish.incidentWindowMs;
      const sinceLast = storage.violations.msSinceLastPunish(message.groupId, message.userId);
      return sinceLast === null || sinceLast >= windowMs;
    },
  };
}

export function mergeConfig(base, override) {
  if (!override) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeConfig(base[k] ?? {}, v) : v;
  }
  return out;
}
