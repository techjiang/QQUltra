import { createEventBus, EVENTS } from './events.js';
import { createLogger } from '../utils/logger.js';
import { createCollector } from '../services/stats/collector.js';
import { buildGroupReport, renderReportText, buildMemberProfile, renderMemberText, resolvePeriod } from '../services/stats/report.js';
import { createDetectEngine } from '../services/detect/engine.js';
import { createModerator } from '../services/manage/moderation.js';
import { createCommandRegistry, parseCommand, extractMentions } from '../services/manage/commands.js';
import { withDefaults, describeSettings, applySetting, SETTABLE_KEYS } from '../services/manage/group-config.js';
import { createSessionManager, DEFAULT_PERSONA, buildStatsAnswerPrompt } from '../services/ai/session.js';
import { createOpenAICompatibleProvider } from '../services/ai/provider.js';
import { truncate } from '../utils/text.js';
import { formatDuration } from '../utils/time.js';

const HELP = [
  '🤖 QQUltra 指令一览',
  '/help — 查看帮助',
  '/stats [today|week|month|all] [--top=N] — 群聊统计报告',
  '/rank [today|week|month|all] — 活跃榜',
  '/me — 我的发言档案',
  '/whois @某人 — 查看成员档案',
  '/ai <问题> — 问 AI（群里需 @ 机器人）',
  '/ai-reset — 清空本会话记忆',
  '/config — 查看本群配置',
  '/rules — 查看检测规则',
  '/ping — 存活检查',
  '管理员：/config set <键> <值> | /rule add <类型> <内容> [--action=mute] | /rule del <id> | /approve <flag> | /reject <flag> | /purge <天数>',
].join('\n');

/**
 * Bot 主循环：唯一把「事件 → 业务 → 回消息」串起来的地方。
 * 各业务模块保持纯逻辑，装配与副作用顺序都在这里显式表达。
 */
export function createBot({
  config,
  storage,
  adapter,
  logger = createLogger({ level: config.logLevel, scope: 'bot' }),
  // 允许注入 AI provider：测试可直接替换，避免真实网络调用与密钥依赖
  aiProvider: injectedAiProvider,
}) {
  const bus = createEventBus({ logger });
  const collector = createCollector({ storage, logger });
  const detectEngine = createDetectEngine({ storage, logger, config: config.detect });
  const moderator = createModerator({ storage, adapter, logger, config: { muteSeconds: 600 } });
  const commands = createCommandRegistry();
  const sessions = createSessionManager({ storage, logger });

  const aiProvider =
    injectedAiProvider !== undefined
      ? injectedAiProvider
      : config.ai.enabled && config.ai.apiKey
        ? createOpenAICompatibleProvider({ ...config.ai, logger })
        : null;

  registerCommands(commands, { storage, config, sessions, aiProvider, logger });

  const ctx = {
    config,
    storage,
    adapter,
    logger,
    bus,
    collector,
    detectEngine,
    moderator,
    commands,
    sessions,
    aiProvider,
    stats: { buildGroupReport, renderReportText, buildMemberProfile, renderMemberText, resolvePeriod },
  };

  // ---- 事件装配顺序很重要：采集 → 检测 → 处置 → 命令 ----
  bus.on(EVENTS.MESSAGE, (message) => handleMessage(ctx, message));

  bus.on(EVENTS.NOTICE, async (notice) => {
    if (notice.subType === 'group_increase') {
      await moderator.handleMemberIncrease(notice);
    } else if (notice.subType === 'group_decrease') {
      storage.members.remove(notice.groupId, notice.userId);
      logger.debug(`成员退群/被踢，已清理汇总: ${notice.groupId}/${notice.userId}`);
    }
  });

  bus.on(EVENTS.REQUEST, async (request) => {
    const group = storage.groups.get(request.groupId);
    const settings = withDefaults(group?.settings);
    // 自动通过策略：群配置里显式打开才自动放行，默认留给人工
    if (settings.antispam?.autoApprove === true) {
      await moderator.handleJoinRequest(request, { approve: true, reason: '自动审核通过' });
    } else {
      logger.info(`待审核入群申请 group=${request.groupId} user=${request.userId} flag=${request.flag}`);
    }
  });

  adapter.addEventListener('message', (ev) => {
    bus.emit(EVENTS.MESSAGE, ev.detail).catch((err) => logger.error(`消息事件派发失败: ${err.message}`));
  });
  adapter.addEventListener('notice', (ev) => {
    bus.emit(EVENTS.NOTICE, ev.detail).catch((err) => logger.error(`通知事件派发失败: ${err.message}`));
  });
  adapter.addEventListener('request', (ev) => {
    bus.emit(EVENTS.REQUEST, ev.detail).catch((err) => logger.error(`请求事件派发失败: ${err.message}`));
  });
  adapter.addEventListener('ready', (ev) => {
    const detail = ev.detail ?? {};
    if (detail.selfId) adapter.selfId = String(detail.selfId);
    storage.kv.set('last_ready_at', Date.now());
    bus.emit(EVENTS.READY, detail).catch(() => {});
  });

  return {
    ...ctx,
    async start() {
      await adapter.connect();
      if (!adapter.selfId) {
        const info = await adapter.getLoginInfo().catch(() => null);
        if (info?.user_id) adapter.selfId = String(info.user_id);
      }
      return adapter.selfId;
    },
    async stop() {
      await adapter.disconnect();
    },
    /**
     * 供非适配器场景（回放、测试、CLI 演示）注入一条消息走完整链路。
     * 与适配器路径的区别是：这里 await 到所有订阅者处理结束，可直接断言结果。
     */
    async inject(message) {
      // 补全必要字段，让调用方只写关心的部分。
      // 注意展开顺序：显式字段放最后，避免 undefined 覆盖掉默认值。
      const groupId = message.groupId ?? null;
      const full = {
        platform: 'inject',
        selfId: adapter.selfId,
        nickname: '',
        role: 'member',
        segments: [],
        timestamp: Date.now(),
        ...message,
        userId: String(message.userId),
        groupId: groupId === null ? null : String(groupId),
        isGroup: groupId !== null,
      };
      await bus.emit(EVENTS.MESSAGE, full);
      return full;
    },
  };
}

async function handleMessage(ctx, message) {
  const { storage, logger, collector, detectEngine, moderator, config } = ctx;
  if (!storage.groups.isEnabled(message.groupId)) return;

  const parsed = message.text.startsWith('/') ? parseCommand(message.text) : null;

  // 1. 采集：命令本身也进明细（标记 is_command），但不参与活跃榜口径由报表层处理
  if (config.stats.enabled) {
    const group = storage.groups.ensure(message.groupId);
    if (withDefaults(group?.settings).stats.enabled) collector.record(message);
  }

  // 2. 检测：命令不走检测，避免管理员用命令时被自己的规则拦下
  if (!parsed) {
    const { findings, decision } = detectEngine.inspect(message);
    if (findings.length > 0) {
      // 同一事件窗口内的重复处置会被 moderator 跳过，
      // 只有真正执行了才写 punish 事件，避免一次刷屏把升级阶梯顶满
      const executed = await moderator.apply(message, decision);
      const didPunish = executed !== 'none' && executed !== 'skipped';
      detectEngine.commit(message, findings, decision, { executed: didPunish ? executed : null });
      if (decision.action !== 'none' && decision.action !== 'warn') return;
    }
  }

  // 3. 命令
  if (parsed) {
    await runCommand(ctx, message, parsed);
    return;
  }

  // 4. AI 触发
  await maybeReplyWithAi(ctx, message);
}

async function runCommand(ctx, message, parsed) {
  const { commands, storage, adapter, logger, config } = ctx;
  const spec = commands.get(parsed.name);
  if (!spec) return;

  if (!commands.canRun(spec, message, config.permission)) {
    await adapter.sendGroupMessage(message.groupId, '⛔ 该指令需要管理员权限');
    return;
  }

  try {
    const reply = await spec.run({ ...ctx, message, args: parsed.args, mentions: extractMentions(message.segments) });
    if (reply) await adapter.sendGroupMessage(message.groupId, reply);
  } catch (err) {
    logger.warn(`指令 ${parsed.name} 执行失败: ${err.message}`);
    await adapter.sendGroupMessage(message.groupId, `指令执行失败：${err.message}`);
  }
}

async function maybeReplyWithAi(ctx, message) {
  const { aiProvider, sessions, adapter, storage, logger } = ctx;
  if (!aiProvider) return;

  const group = storage.groups.ensure(message.groupId);
  const settings = withDefaults(group?.settings).ai;
  if (!settings.enabled) return;

  const mentioned = extractMentions(message.segments).some((id) => id === String(adapter.selfId));
  const prompt = message.text.trim();
  const shouldReply =
    settings.trigger === 'all' ||
    (settings.trigger === 'mention' && mentioned) ||
    (settings.trigger === 'prefix' && prompt.startsWith(settings.prefix));

  if (!shouldReply) return;

  const question = mentioned
    ? prompt.replace(new RegExp(`\\[CQ:at,qq=${adapter.selfId}\\]`, 'g'), '').trim()
    : settings.trigger === 'prefix'
      ? prompt.slice(settings.prefix.length).trim()
      : prompt;

  if (!question) {
    await adapter.sendGroupMessage(message.groupId, '嗯？你想问什么？');
    return;
  }

  try {
    const { scopeKey, messages } = await sessions.buildPrompt(
      { ...message, text: question },
      { systemPrompt: ctx.config.ai.systemPrompt ?? DEFAULT_PERSONA, contextLines: settings.contextLines },
    );
    const answer = await aiProvider.chat(messages);
    sessions.remember(scopeKey, question, answer.content);
    await adapter.sendGroupMessage(message.groupId, truncate(answer.content, settings.maxReplyLength));
  } catch (err) {
    logger.warn(`AI 回复失败: ${err.message}`);
    await adapter.sendGroupMessage(message.groupId, 'AI 服务暂时不可用，稍后再试');
  }
}

function registerCommands(commands, { storage, config, sessions, aiProvider, logger }) {
  commands.register('help', {
    description: '查看帮助',
    run: () => HELP,
  });

  commands.register('ping', {
    description: '存活检查',
    run: () => `pong 🏓 运行时长 ${formatDuration(process.uptime() * 1000)}`,
  });

  commands.register('stats', {
    description: '群聊统计',
    run: ({ storage: s, message, args }) => {
      const period = args.positional[0] ?? 'today';
      const top = Number(args.flags.top ?? 10);
      const report = buildGroupReport(s, message.groupId, { period, top });
      return renderReportText(report);
    },
  });

  commands.register('rank', {
    aliases: ['排行', '活跃榜'],
    description: '活跃榜',
    run: ({ storage: s, message, args }) => {
      const period = args.positional[0] ?? 'today';
      const report = buildGroupReport(s, message.groupId, { period, top: Number(args.flags.top ?? 10) });
      if (report.topUsers.length === 0) return `${report.period.label}暂无发言记录`;
      return [`🏆 ${report.period.label}活跃榜`, ...report.topUsers.map((u) => `${u.rank}. ${u.nickname} — ${u.count} 条`)].join('\n');
    },
  });

  commands.register('me', {
    description: '我的档案',
    run: ({ storage: s, message }) => {
      const profile = buildMemberProfile(s, message.groupId, message.userId);
      return profile ? renderMemberText(profile) : '还没有你的发言记录，先说句话吧';
    },
  });

  commands.register('whois', {
    description: '成员档案',
    run: ({ storage: s, message, mentions, args }) => {
      const target = mentions[0] ?? args.positional.find((p) => /^\d+$/.test(p));
      if (!target) return '用法：/whois @某人';
      const profile = buildMemberProfile(s, message.groupId, target);
      return profile ? renderMemberText(profile) : `没有找到 ${target} 的发言记录`;
    },
  });

  commands.register('config', {
    description: '群配置',
    run: ({ storage: s, message, args }) => {
      const sub = args.positional[0];
      if (!sub) return describeSettings(s.groups.get(message.groupId)?.settings ?? {});
      if (sub === 'keys') return ['可配置项：', ...Object.keys(SETTABLE_KEYS).map((k) => `- ${k}`)].join('\n');
      if (sub === 'set') {
        const [, key, value] = args.positional;
        if (!key || value === undefined) return '用法：/config set <键> <值>';
        const group = s.groups.ensure(message.groupId);
        const { settings, value: coerced } = applySetting(group, key, value);
        s.db.run('UPDATE groups SET settings = ?, updated_at = ? WHERE group_id = ?', JSON.stringify(settings), Date.now(), String(message.groupId));
        return `✅ 已设置 ${key} = ${JSON.stringify(coerced)}`;
      }
      return '用法：/config | /config keys | /config set <键> <值>';
    },
    level: 'admin',
  });

  commands.register('rules', {
    description: '检测规则',
    run: ({ storage: s, message }) => {
      const rules = s.rules.list(message.groupId);
      if (rules.length === 0) return '当前没有自定义规则（内置规则始终生效：刷屏/复读/广告/长文本/链接）';
      return [
        '📋 生效规则',
        ...rules.map((r) => `#${r.id} [${r.type}] ${r.pattern} → ${r.action} 命中${r.hitCount}次 ${r.enabled ? '' : '(已停用)'}`),
      ].join('\n');
    },
  });

  commands.register('rule', {
    description: '规则增删',
    level: 'admin',
    run: ({ storage: s, message, args }) => {
      const [sub, type, ...patternParts] = args.positional;
      if (sub === 'add') {
        if (!type || patternParts.length === 0) return '用法：/rule add <keyword|regex> <内容> [--action=warn|mute|kick]';
        const action = args.flags.action ?? 'warn';
        if (!['warn', 'mute', 'kick'].includes(action)) return '--action 只能是 warn/mute/kick';
        const rule = s.rules.add({ groupId: message.groupId, type, pattern: patternParts.join(' '), action });
        return `✅ 已添加规则 #${rule.id} [${rule.type}] ${rule.pattern} → ${rule.action}`;
      }
      if (sub === 'del' || sub === 'rm') {
        const id = Number(args.positional[1]);
        if (!Number.isInteger(id)) return '用法：/rule del <id>';
        return s.rules.remove(id) > 0 ? `✅ 已删除规则 #${id}` : `未找到规则 #${id}`;
      }
      if (sub === 'on' || sub === 'off') {
        const id = Number(args.positional[1]);
        const rule = s.rules.get(id);
        if (!rule) return `未找到规则 #${id}`;
        s.rules.toggle(id, sub === 'on');
        return `✅ 规则 #${id} 已${sub === 'on' ? '启用' : '停用'}`;
      }
      return '用法：/rule add|del|on|off';
    },
  });

  commands.register('approve', {
    aliases: ['reject'],
    description: '入群审核',
    level: 'admin',
    run: async ({ moderator, args, message }) => {
      const flag = String(args.positional[0] ?? '');
      if (!flag) return '用法：/approve <flag>（flag 见待审核日志）';
      const approve = message.text.trim().startsWith('/approve');
      await moderator.handleJoinRequest({ flag, subType: 'add' }, { approve, reason: approve ? '管理员批准' : '管理员拒绝' });
      return approve ? '✅ 已通过入群申请' : '⛔ 已拒绝入群申请';
    },
  });

  commands.register('purge', {
    description: '清理历史数据',
    level: 'owner',
    run: ({ storage: s, args }) => {
      const days = Number(args.positional[0] ?? config.stats.retentionDays);
      if (!Number.isFinite(days) || days < 1) return '用法：/purge <保留天数>';
      const cutoff = Date.now() - days * 86400_000;
      const removed = s.messages.purgeBefore(cutoff);
      s.violations.purgeBefore(cutoff);
      return `🧹 已清理 ${days} 天前的 ${removed} 条消息明细`;
    },
  });

  commands.register('ai', {
    description: '问 AI',
    run: async ({ message, args, aiProvider: provider, sessions: sess, storage: s, config: cfg }) => {
      if (!provider) return 'AI 功能未启用（请在配置中设置 ai.enabled 与 ai.apiKey）';
      const question = args.raw.replace(/^ai\s*/i, '').trim();
      if (!question) return '用法：/ai <你的问题>';
      const { scopeKey, messages: prompt } = await sess.buildPrompt({ ...message, text: question }, { systemPrompt: cfg.ai.systemPrompt ?? DEFAULT_PERSONA });
      const answer = await provider.chat(prompt);
      sess.remember(scopeKey, question, answer.content);
      void s;
      return truncate(answer.content, 800);
    },
  });

  commands.register('ai-stats', {
    description: '让 AI 解读统计数据',
    run: async ({ message, args, aiProvider: provider, storage: s }) => {
      if (!provider) return 'AI 功能未启用';
      const period = args.positional[0] ?? 'today';
      const { messages: prompt } = buildStatsAnswerPrompt(s, message.groupId, args.raw.replace(/^ai-stats\s*/i, '').trim() || '总结本群活跃情况并给出一条改进建议', { period });
      const answer = await provider.chat(prompt);
      return truncate(answer.content, 800);
    },
  });

  commands.register('ai-reset', {
    description: '清空会话记忆',
    run: ({ message, sessions: sess }) => {
      const key = message.isGroup ? `group:${message.groupId}` : `user:${message.userId}`;
      const cleared = sess.reset(key);
      logger.debug(`已清空会话 ${key}，共 ${cleared} 条`);
      return `🧽 已清空本会话记忆（${cleared} 条）`;
    },
  });
}

export { HELP };
