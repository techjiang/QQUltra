import { createEventBus, EVENTS } from './events.js';
import { createLogger } from '../utils/logger.js';
import { createCollector } from '../services/stats/collector.js';
import { buildGroupReport, renderReportText, buildMemberProfile, renderMemberText, resolvePeriod } from '../services/stats/report.js';
import { createDetectEngine, DEFAULT_DETECT_CONFIG } from '../services/detect/engine.js';
import { compileRegex, RULE_TYPES } from '../services/detect/rules.js';
import { createModerator } from '../services/manage/moderation.js';
import { createCommandRegistry, parseCommand, extractMentions, COMMAND_PREFIX } from '../services/manage/commands.js';
import { withDefaults, describeSettings, applySetting, SETTABLE_KEYS } from '../services/manage/group-config.js';
import { createSessionManager, DEFAULT_PERSONA, buildStatsAnswerPrompt } from '../services/ai/session.js';
import { createOpenAICompatibleProvider } from '../services/ai/provider.js';
import { truncate, normalizeText } from '../utils/text.js';
import { countWords, renderWordCloudText } from '../services/stats/wordcloud.js';
import { renderPanel } from '../services/manage/panel.js';
import { inspectGroupHealth, renderHealthText, evaluateAlert, buildDailyDigest } from '../services/manage/digest.js';
import { renderAboutText, PROJECT } from '../assets/brand.js';
import { VERSION } from '../version.js';
import { renderWordCloudSvg, renderPanelSvg } from '../services/stats/wordcloud-svg.js';
import { writeTempFile, sweepStale } from '../utils/tempfile.js';
import { formatDuration } from '../utils/time.js';

/**
 * 私聊里明确可用的指令（其余指令默认按「群专属」处理）。
 *
 * 用白名单而不是黑名单：新增指令时若忘了登记，默认是「私聊拒绝」——
 * 拒绝是安全的失败方向；反过来漏登记的指令会拿 groupId=null 去查库，
 * 在群里看起来像功能坏了，而且没人会立刻发现。
 */
export const PRIVATE_SAFE_COMMANDS = ['help', 'about', 'ping', 'status', 'panel', 'ai', 'ai-stats', 'ai-reset'];

/**
 * 判断一条指令在私聊里是否有意义。
 *
 * 除了白名单，还要看调用者有没有「把群号写进参数」的能力：
 * 已授权的运维可以私聊 /config keys 或 /rule on 这类不读群数据的操作，
 * 这类操作本身就无群上下文依赖，不该被一刀切拦掉。
 */
function isGroupOnlyCommand(spec, parsed) {
  if (PRIVATE_SAFE_COMMANDS.includes(spec.name)) return false;
  // 只读群数据的子命令：即使在白名单手里，没有群号也查不出东西
  if (spec.name === 'config') return parsed.args.positional[0] === undefined || parsed.args.positional[0] === 'set';
  if (spec.name === 'rule') return parsed.args.positional[0] === 'add' || parsed.args.positional[0] === 'del' || parsed.args.positional[0] === 'rm';
  return true;
}

/**
 * 校验 /rule add 的输入。
 *
 * 只允许两种可被检测器真正识别的类型（keyword / regex），
 * 并在写入前把正则编译一次——编译不过的规则是「死规则」，
 * 写进库里只会让人以为已经拦住了。
 */
function validateRuleInput(type, pattern) {
  const normalized = String(type).toLowerCase();
  if (!['keyword', 'regex'].includes(normalized)) {
    return { ok: false, message: `未知规则类型「${type}」，只能是 keyword（关键词）或 regex（正则）` };
  }
  if (pattern.trim() === '') {
    return { ok: false, message: '规则内容不能为空' };
  }
  if (normalized === 'regex') {
    const compiled = compileRegex(pattern);
    if (!compiled) return { ok: false, message: `正则表达式无效：${pattern}（无法编译，请检查括号与转义）` };
  }
  return { ok: true, type: normalized };
}

/**
 * 解析非负整数旗标。
 * 抽出来是因为 `Number(x) || fallback` 这个写法有坑：Number(true) === 1，
 * 于是 `--top`（不带值）会静默变成 1，`--top abc` 也会变成 1，
 * 用户看到的是「结果不对但没报错」。
 * @returns {number|undefined} 非法输入返回 undefined，由调用方决定报错还是用默认值
 */
function positiveInt(raw) {
  if (raw === undefined || raw === null || raw === true) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** --top 的统一解析：显式非法时抛可预期错误，缺省用默认值。 */
function parseTop(raw, fallback) {
  if (raw === undefined) return fallback;
  const n = positiveInt(raw);
  if (n === undefined) {
    const err = new Error(`--top 需要正整数，收到「${raw === true ? '(空)' : raw}」`);
    err.expected = true;
    throw err;
  }
  return n;
}

const HELP = [
  '🤖 QQUltra 指令一览',
  '/help — 查看帮助',
  '/panel — 打开管理面板（PC 端 QQ 内直接操作）',
  '/panel --img — 面板以图卡形式发送',
  '/status — 运行状态与自检',
  '/about — 作者与项目信息',
  '/ping — 存活检查',
  '',
  '📊 洞察',
  '/stats [today|week|month|all] [--top=N] — 统计报告',
  '/rank [周期] — 活跃榜',
  '/wordcloud [周期] — 词云图',
  '/me — 我的发言档案',
  '/whois @某人 — 成员档案',
  '/history [@某人] — 最近发言回顾',
  '',
  '🛡 风控（管理员）',
  '/rules — 查看检测规则',
  '/violations — 最近违规记录',
  '/alert — 异常预警开关',
  '/rule add <类型> <内容> [--action=mute] | /rule del <id>',
  '',
  '⚙️ 运维',
  '/config — 查看配置 | /config keys 看可配项（管理员）',
  '/config set <键> <值> — 改配置（管理员）',
  '/subscribe /unsubscribe — 每日简报（管理员）',
  '/approve <flag> | /reject <flag> — 入群审核（管理员）',
  '/purge <天数> — 清理历史（群主）',
  '',
  '🤖 AI',
  '/ai <问题> — 提问（群里需 @ 机器人，私聊直接发）',
  '/ai-stats [周期] — 让 AI 解读数据',
  '/ai-reset — 清空会话记忆',
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
  // 启动时回收上次进程遗留的出图临时文件（定时器不跨进程）。
  sweepStale({ logger });

  const bus = createEventBus({ logger });
  const collector = createCollector({ storage, logger });
  const detectEngine = createDetectEngine({ storage, logger, config: config.detect });
  // moderator 的兜底参数来自全局 detect 默认值，而不是各写一个魔法数字。
  // 曾经这里写死 { muteSeconds: 600 }，于是群配置里的 incidentWindowMs 根本传不进来：
  // /config set detect.punish.incidentWindowMs 改完毫无效果，且没有任何地方会报错。
  const moderator = createModerator({
    storage,
    adapter,
    logger,
    config: {
      muteSeconds: DEFAULT_DETECT_CONFIG.punish.muteSeconds,
      incidentWindowMs: DEFAULT_DETECT_CONFIG.punish.incidentWindowMs,
      resolveIncidentWindowMs: (groupId) =>
        withDefaults(storage.groups.get(groupId)?.settings ?? {}).detect?.punish?.incidentWindowMs ??
        DEFAULT_DETECT_CONFIG.punish.incidentWindowMs,
    },
  });
  const commands = createCommandRegistry();
  const sessions = createSessionManager({ storage, logger });

  const aiProvider =
    injectedAiProvider !== undefined
      ? injectedAiProvider
      : config.ai.enabled && config.ai.apiKey
        ? createOpenAICompatibleProvider({ ...config.ai, logger })
        : null;


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
    startedAt: Date.now(),
    stats: { buildGroupReport, renderReportText, buildMemberProfile, renderMemberText, resolvePeriod },
  };

  registerCommands(commands, ctx);

  // ---- 事件装配顺序很重要：采集 → 检测 → 处置 → 命令 ----
  bus.on(EVENTS.MESSAGE, (message) => handleMessage(ctx, message));

  bus.on(EVENTS.NOTICE, async (notice) => {
    if (notice.subType === 'group_increase') {
      await moderator.handleMemberIncrease(notice);
    } else if (notice.subType === 'group_decrease') {
      // OneBot 的 group_decrease 把离开者放在 target_id（operator_id 才是操作者），
      // 用 userId 会一直拿到 undefined，汇总永远不会被清理。
      const left = notice.targetId ?? notice.userId;
      if (left) {
        storage.members.remove(notice.groupId, left);
        logger.debug(`成员退群/被踢，已清理汇总: ${notice.groupId}/${left}`);
      }
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
  const { storage, collector, config } = ctx;

  // 私聊走独立路径：没有群统计、没有群风控，只有指令与 AI。
  // 混进群链路会让 /stats 拿着 null 群号去查库，也会把私聊算进某个群。
  if (!message.isGroup) {
    await handlePrivateMessage(ctx, message);
    return;
  }

  if (!storage.groups.isEnabled(message.groupId)) return;

  const parsed = message.text.startsWith(COMMAND_PREFIX) ? parseCommand(message.text) : null;

  // 群配置只取一次：下面采集/检测/主动服务都要读，重复 withDefaults 会做无谓的深拷贝
  const settings = withDefaults(storage.groups.ensure(message.groupId)?.settings ?? {});

  // 1. 采集：命令本身也进明细（标记 is_command），但不参与活跃榜口径由报表层处理
  if (config.stats.enabled && settings.stats.enabled) {
    collector.record(message);
  }

  // 2. 检测：命令不走检测，避免管理员用命令时被自己的规则拦下
  if (!parsed) {
    await runDetection(ctx, message);
  }

  // 3. 命令
  if (parsed) {
    await runCommand(ctx, message, parsed);
    return;
  }

  // 4. 主动服务：异常预警与每日简报。
  // 挂在消息路径上而不是独立定时器——群里没消息就没有推送的意义，
  // 且省掉一个常驻定时器与它带来的跨进程唤醒。
  await runProactiveServices(ctx, message, settings);

  // 5. AI 触发
  await maybeReplyWithAi(ctx, message);
}

/**
 * 主动服务。两个都必须「低频且可关」：
 * 群机器人最讨人厌的失败方式不是不回消息，而是天天刷屏。
 */
async function runProactiveServices(ctx, message, groupSettings) {
  const { storage, adapter, logger } = ctx;

  // ---- 异常预警 ----
  const alertConf = groupSettings.alert ?? {};
  if (alertConf.enabled !== false) {
    const result = evaluateAlert({
      storage,
      groupId: message.groupId,
      threshold: alertConf.threshold ?? 5,
      windowMs: alertConf.windowMs ?? 10 * 60_000,
    });
    // 冷却：同一群 30 分钟内只提醒一次，避免违规刷屏时预警本身变成刷屏
    const lastAt = storage.kv.get(`alert_sent:${message.groupId}`, 0);
    if (result.triggered && Date.now() - lastAt > 30 * 60_000) {
      storage.kv.set(`alert_sent:${message.groupId}`, Date.now());
      await adapter
        .sendGroupMessage(message.groupId, `🚨 异常预警：${result.reason}\n（如需关闭：/alert off）`)
        .catch((err) => logger.warn(`预警推送失败: ${err.message}`));
    }
  }

  // ---- 每日简报 ----
  const sub = storage.kv.get(`digest_subscribe:${message.groupId}`, null);
  if (!sub?.enabled) return;

  const today = new Date().setHours(0, 0, 0, 0);
  const lastDate = storage.kv.get(`digest_sent:${message.groupId}`, 0);
  if (lastDate >= today) return;

  storage.kv.set(`digest_sent:${message.groupId}`, Date.now());
  const digest = buildDailyDigest(storage, message.groupId, { now: Date.now() });
  await adapter
    .sendGroupMessage(message.groupId, `${digest.text}\n（/unsubscribe 退订）`)
    .catch((err) => logger.warn(`简报推送失败: ${err.message}`));
}

/** 检测 → 处置 → 留痕。返回值表示消息是否已被「拦截」（后续不再当作普通消息处理）。 */
async function runDetection(ctx, message) {
  const { detectEngine, moderator } = ctx;
  const { findings, decision } = detectEngine.inspect(message);
  if (findings.length === 0) return false;

  // 同一事件窗口内的重复处置会被 moderator 跳过，
  // 只有真正执行了才写 punish 事件，避免一次刷屏把升级阶梯顶满
  const executed = await moderator.apply(message, decision);
  const didPunish = executed !== 'none' && executed !== 'skipped';
  detectEngine.commit(message, findings, decision, { executed: didPunish ? executed : null });

  return executed === 'mute' || executed === 'kick';
}

/**
 * 私聊路径。私聊没有角色概念，管理指令一律要求账号在 permission.whiteList 内
 * （见 commands.canRun），否则任何人都能私聊机器人清空数据。
 */
async function handlePrivateMessage(ctx, message) {
  const { adapter, logger } = ctx;
  const text = normalizeText(message.text).trim();

  const parsed = text.startsWith(COMMAND_PREFIX) ? parseCommand(text) : null;
  if (parsed) {
    // 群维度指令在私聊里没有语义：/stats 会拿着 groupId=null 去查库，
    // 回一句「📊 群 null · 今日统计」，看起来像功能坏了。
    // 与其返回一个「群 null」的假报告，不如直接说清怎么用。
    //
    // 顺序很重要：先判定权限。未授权的人问 /purge，该看到的是「需要权限」，
    // 而不是「这是群内指令」——后者会让对方以为只要换个地方就能用。
    const spec = ctx.commands.resolve(parsed.name);
    const allowed = spec ? ctx.commands.canRun(spec, message, ctx.config.permission) : false;
    if (spec && allowed && isGroupOnlyCommand(spec, parsed)) {
      await adapter.sendPrivateMessage(
        message.userId,
        `⚠️ /${spec.name} 是群内指令，请在群里使用（私聊可用：${PRIVATE_SAFE_COMMANDS.map((c) => `/${c}`).join(' ')}）`,
      );
      return;
    }
    await runCommand(ctx, message, parsed);
    return;
  }

  // 私聊里没有 @ 目标，直接当作对话（触发方式只在群聊里生效）
  await replyWithAi(ctx, message, text, { scopeKey: `user:${message.userId}` });
}

async function runCommand(ctx, message, parsed) {
  const { commands, adapter, logger, config } = ctx;
  const spec = commands.resolve(parsed.name);
  if (!spec) return;

  // 回复一律回到消息来的地方：群里回群、私聊回私聊。
  // 私聊里调 sendGroupMessage(groupId=null) 会直接抛错，用户看到的只有沉默。
  const reply = (text) => (message.isGroup ? adapter.sendGroupMessage(message.groupId, text) : adapter.sendPrivateMessage(message.userId, text));

  if (!commands.canRun(spec, message, config.permission)) {
    await reply('⛔ 该指令需要管理员权限（私聊使用请把 QQ 号加入 permission.whiteList）');
    return;
  }

  try {
    const out = await spec.run({ ...ctx, message, args: parsed.args, mentions: extractMentions(message.segments) });
    if (out) await reply(out);
  } catch (err) {
    // 用户输入错（周期写错、参数缺）属于可预期的操作失误，直接给出正确用法；
    // 只有真正的内部错误才打日志并按「执行失败」上报，避免日志被用法错误淹没。
    if (err.expected || err instanceof TypeError) {
      logger.debug(`指令 ${parsed.name} 参数不合法: ${err.message}`);
      await reply(`⚠️ ${err.message}`);
      return;
    }
    logger.warn(`指令 ${parsed.name} 执行失败: ${err.message}`);
    await reply(`指令执行失败：${err.message}`);
  }
}

/** 触发判定 + 提示词构造 + 回复，群聊与私聊共用。 */
async function replyWithAi(ctx, message, question, { scopeKey }) {
  const { aiProvider, sessions, adapter, storage, logger } = ctx;
  if (!aiProvider) return;

  const group = message.isGroup ? storage.groups.ensure(message.groupId) : null;
  const settings = withDefaults(group?.settings).ai;
  if (message.isGroup && !settings.enabled) return;

  if (!question.trim()) {
    await (message.isGroup
      ? adapter.sendGroupMessage(message.groupId, '嗯？你想问什么？')
      : adapter.sendPrivateMessage(message.userId, '嗯？你想问什么？'));
    return;
  }

  try {
    const { messages } = await sessions.buildPrompt(
      { ...message, text: question },
      {
        systemPrompt: ctx.config.ai.systemPrompt ?? DEFAULT_PERSONA,
        contextLines: message.isGroup ? settings.contextLines : 0,
      },
    );
    // 只有多轮对话才写记忆：一次性问答（/ai）不该污染上下文
    const answer = await aiProvider.chat(messages);
    sessions.remember(scopeKey, question, answer.content);
    const maxLen = message.isGroup ? settings.maxReplyLength : Math.max(settings.maxReplyLength, 800);
    const text = truncate(answer.content, maxLen);
    await (message.isGroup ? adapter.sendGroupMessage(message.groupId, text) : adapter.sendPrivateMessage(message.userId, text));
  } catch (err) {
    logger.warn(`AI 回复失败: ${err.message}`);
    const text = `AI 服务暂时不可用，稍后再试（${truncate(err.message, 80)}）`;
    await (message.isGroup ? adapter.sendGroupMessage(message.groupId, text) : adapter.sendPrivateMessage(message.userId, text));
  }
}

async function maybeReplyWithAi(ctx, message) {
  const { aiProvider, adapter, storage } = ctx;
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

  await replyWithAi(ctx, message, question, { scopeKey: `group:${message.groupId}` });
}

function registerCommands(commands, { storage, config, sessions, aiProvider, logger, adapter, startedAt }) {
  commands.register('help', {
    description: '查看帮助',
    run: () => HELP,
  });

  commands.register('ping', {
    description: '存活检查',
    run: () => `pong 🏓 运行时长 ${formatDuration(process.uptime() * 1000)}`,
  });

  commands.register('about', {
    description: '作者与项目信息',
    run: () => `${renderAboutText({ version: VERSION })}\n\n数据只落本地 SQLite，不外传。`,
  });

  commands.register('panel', {
    description: '管理面板',
    run: async ({ message, config: cfg, args }) => {
      const text = renderPanel({
        role: message.role,
        whiteListed: (cfg.permission?.whiteList ?? []).map(String).includes(String(message.userId)),
        groupName: message.isGroup ? (storage.groups.get(message.groupId)?.name ?? null) : null,
      });
      // --img：把面板渲染成图文卡片。PC 端 QQ 的聊天窗口对长文本会自动折叠，
      // 图卡能一屏看完，更适合当「操作台」用。
      if (args?.flags?.img === undefined) return text;
      try {
        // 临时文件登记 TTL 后再交给适配器：协议端是异步读文件的，
        // 所以不能发完就删（会变破图），但也不能永不删除（旧实现会在
        // tmpdir 里无限堆积 SVG）。生命周期统一交给 tempfile 模块。
        const file = writeTempFile({
          name: `panel-${message.isGroup ? `g${message.groupId}` : `u${message.userId}`}-${Date.now()}.svg`,
          content: renderPanelSvg(text, { title: 'QQUltra 管理面板' }),
          logger,
        });
        await (message.isGroup ? adapter.sendGroupImage(message.groupId, file) : adapter.sendPrivateImage(message.userId, file));
        return null;
      } catch (err) {
        logger.debug(`面板图卡发送失败，退回文本: ${err.message}`);
        return text;
      }
    },
  });

  commands.register('status', {
    description: '运行状态与自检',
    run: ({ message }) => {
      const lastReadyAt = storage.kv.get('last_ready_at', null);
      const health = inspectGroupHealth({
        storage,
        groupId: message.groupId,
        lastReadyAt,
        adapterName: adapter?.name ?? 'unknown',
      });
      const lines = [
        `🛰 ${PROJECT.name} v${VERSION} | 运行 ${formatDuration(Date.now() - (startedAt ?? Date.now()))}`,
        `适配器 ${adapter?.name ?? 'unknown'} | 机器人 ${adapter?.selfId ?? '未知'}`,
        `数据库 ${config.dataFile}`,
      ];
      return [...lines, '', renderHealthText(health)].join('\n');
    },
  });

  commands.register('wordcloud', {
    description: '词云图',
    run: async ({ message, args, storage: s, adapter: ad }) => {
      const period = args.positional[0] ?? 'week';
      const { since, until, label } = resolvePeriod(period, message.timestamp);
      const top = Math.min(positiveInt(args.flags.top) ?? 20, 50);
      // recentWindow 同时带 until 上界与「排除指令」过滤：
      // 词云是给成员看的话题画像，把 /wordcloud、--top 这类指令词算进去会污染结果。
      const rows = s.messages.recentWindow(message.groupId, since, until, 5000);
      const words = countWords(rows.map((r) => r.text), { top, minCount: 2 });
      if (words.length === 0) return `${label}语料不足，无法生成词云`;

      const header = `☁️ ${label}词云（${rows.length} 条消息 / ${words.length} 个高频词）`;
      // 先尝试渲染成图片发出去，失败就退回纯文本——不退化的炫技等于故障
      if (args?.flags?.img === false) return `${header}\n${renderWordCloudText(words)}`;
      try {
        const svg = renderWordCloudSvg(words, { title: `${label}群聊词云` });
        const file = writeTempFile({
          name: `wordcloud-${message.isGroup ? `g${message.groupId}` : `u${message.userId}`}-${Date.now()}.svg`,
          content: svg,
          logger,
        });
        await (message.isGroup ? ad.sendGroupImage(message.groupId, file) : ad.sendPrivateImage(message.userId, file));
        return null;
      } catch (err) {
        logger.debug(`词云图片发送失败，退回文本: ${err.message}`);
        return `${header}\n${renderWordCloudText(words)}`;
      }
    },
  });

  commands.register('history', {
    description: '最近发言回顾',
    run: ({ message, mentions, args, storage: s }) => {
      const target = mentions[0] ?? args.positional.find((p) => /^\d+$/.test(p)) ?? null;
      const limit = Math.min(positiveInt(args.flags.n) ?? 5, 20);
      if (target) {
        const rows = s.messages.lastMessages(message.groupId, target, limit);
        if (rows.length === 0) return `没有找到 ${target} 的发言记录`;
        return [`🕓 ${target} 最近 ${rows.length} 条发言`, ...rows.map((r) => `· ${truncate(r.text, 60)}`)].join('\n');
      }
      // 排除指令：否则这条回顾的第一行永远是「刚才那条 /history」本身
      const rows = s.messages.recentInGroup(message.groupId, Date.now() - 24 * 3600_000, limit);
      if (rows.length === 0) return '近 24 小时没有群消息记录';
      return ['🕓 近 24 小时最新发言', ...rows.map((r) => `${r.nickname || r.user_id}：${truncate(r.text, 50)}`)].join('\n');
    },
  });

  commands.register('violations', {
    description: '最近违规记录',
    level: 'admin',
    run: ({ message, storage: s, args }) => {
      const want = Math.min(positiveInt(args.flags.n) ?? 10, 30);
      // 按「事件」展示而不是按「命中行」：一次广告会命中 ad + newbie_shill 并写一条 punish 摘要，
      // 按行展示会让 --n 10 只装得下 3 次真实违规，且同一事件重复出现三遍。
      const rows = s.violations.incidents(message.groupId, want);
      if (rows.length === 0) return '✅ 最近没有任何违规记录';
      const exemptCount = rows.filter((v) => v.exempt).length;
      const title =
        exemptCount === 0
          ? `🚨 最近 ${rows.length} 次违规`
          : exemptCount === rows.length
            ? `ℹ️ 最近 ${rows.length} 次命中均由白名单/仅记录策略放行，未产生处置`
            : `🚨 最近 ${rows.length} 次触发（其中 ${exemptCount} 次豁免）`;
      return [
        title,
        ...rows.map((v) => {
          const at = new Date(v.createdAt).toLocaleString('zh-CN', { hour12: false });
          const kinds = v.kinds.length ? v.kinds.join('+') : '记录';
          // 豁免命中（白名单角色 / 仅记录）要显式标出来。
          // 否则管理员看到自己说的话被列成「违规」，第一反应是关掉整个检测。
          const mark = v.action === 'none' || v.exempt ? '（仅记录，未处置）' : `→${v.action}`;
          return `· ${at} ${v.userId} [${kinds}] ${mark} ${truncate(v.detail, 40)}`;
        }),
      ].join('\n');
    },
  });

  commands.register('alert', {
    description: '异常预警',
    level: 'admin',
    run: ({ message, args, storage: s }) => {
      const sub = args.positional[0];
      const group = s.groups.ensure(message.groupId);
      const current = withDefaults(group.settings).alert;
      if (sub === 'on' || sub === 'off') {
        const { settings } = applySetting(group, 'alert.enabled', sub === 'on' ? 'true' : 'false');
        s.db.run('UPDATE groups SET settings = ?, updated_at = ? WHERE group_id = ?', JSON.stringify(settings), Date.now(), String(message.groupId));
        return `🔔 异常预警已${sub === 'on' ? '开启' : '关闭'}`;
      }
      if (sub === 'threshold') {
        const n = Number(args.positional[1]);
        if (!Number.isInteger(n) || n < 1) return '用法：/alert threshold <正整数>';
        const { settings } = applySetting(group, 'alert.threshold', String(n));
        s.db.run('UPDATE groups SET settings = ?, updated_at = ? WHERE group_id = ?', JSON.stringify(settings), Date.now(), String(message.groupId));
        return `🔔 预警阈值已设为 ${n} 次/10 分钟`;
      }
      const live = evaluateAlert({ storage: s, groupId: message.groupId, threshold: current.threshold });
      return [
        `🔔 异常预警：${current.enabled ? '开' : '关'}`,
        `阈值：${current.threshold} 次 / ${Math.round(current.windowMs / 60000)} 分钟`,
        `当前窗口命中：${live.count} 次${live.triggered ? '（已触发）' : ''}`,
        '用法：/alert on | /alert off | /alert threshold 5',
      ].join('\n');
    },
  });

  commands.register('subscribe', {
    description: '订阅每日简报',
    level: 'admin',
    run: ({ message, storage: s }) => {
      s.kv.set(`digest_subscribe:${message.groupId}`, { enabled: true, since: Date.now() });
      return '📮 已订阅每日简报，机器人会在每天首次收到消息时推送昨日摘要（/unsubscribe 退订）';
    },
  });

  commands.register('unsubscribe', {
    description: '退订每日简报',
    level: 'admin',
    run: ({ message, storage: s }) => {
      s.kv.set(`digest_subscribe:${message.groupId}`, { enabled: false, since: Date.now() });
      return '📮 已退订每日简报';
    },
  });

  commands.register('stats', {
    description: '群聊统计',
    run: ({ storage: s, message, args }) => {
      const period = args.positional[0] ?? 'today';
      // --top 非法时不再静默退回 1（Number(true) === 1），而是给出明确用法
      const top = parseTop(args.flags.top, 10);
      const report = buildGroupReport(s, message.groupId, { period, top });
      return renderReportText(report);
    },
  });

  commands.register('rank', {
    aliases: ['排行', '活跃榜'],
    description: '活跃榜',
    run: ({ storage: s, message, args }) => {
      const period = args.positional[0] ?? 'today';
      const report = buildGroupReport(s, message.groupId, { period, top: parseTop(args.flags.top, 10) });
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

        // 类型与正则都必须当场校验。
        // 曾经 /rule add keywrod 词 会「✅ 已添加规则」，但 keywrod 不在检测器识别的
        // 类型里，规则永远不生效；/rule add regex [未闭合 同样入库成功，
        // 而 compileRegex 只返回 null。两种情况都没有任何报错，
        // 表现为「配了规则但垃圾消息照样过」——最难排查的一类故障。
        const pattern = patternParts.join(' ');
        const validation = validateRuleInput(type, pattern);
        if (!validation.ok) return validation.message;

        const rule = s.rules.add({ groupId: message.groupId, type: validation.type, pattern, action });
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
      // 汇总表要跟着清理：只删明细会让 /whois、成员列表继续展示
      // 一个「累计发言 12 条」但明细里一条都查不到的幽灵成员
      const goneMembers = s.members.purgeBefore(cutoff);
      s.kv.set('retention_days', days);
      s.kv.set('retention_last_run_at', Date.now());
      return `🧹 已清理 ${days} 天前的 ${removed} 条消息明细、${goneMembers} 条成员汇总`;
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
