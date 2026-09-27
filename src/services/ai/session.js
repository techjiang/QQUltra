import { buildGroupReport } from '../stats/report.js';

export const DEFAULT_PERSONA = [
  '你是 QQUltra，一名常驻 QQ 群聊的助手。',
  '说话简短、口语化，像群里的一员，不要长篇大论。',
  '群聊里没有排版空间，不要用 Markdown 标题、表格、代码块。',
  '不确定的事实要直说不确定，不要编造。',
  '遇到求助就给出可直接执行的答案，不做多余的铺垫和客套。',
].join('');

/**
 * 会话上下文管理。scopeKey 决定「谁和谁共享一段记忆」：
 * 群聊按群维度共享（群里 @ 机器人时所有人都能接上话），私聊按用户维度。
 */
export function createSessionManager({ storage, maxKeep = 40, historyLimit = 12, logger }) {
  const scopeKeyOf = (message) => (message.isGroup ? `group:${message.groupId}` : `user:${message.userId}`);

  return {
    scopeKeyOf,

    async buildPrompt(message, { systemPrompt = DEFAULT_PERSONA, contextLines = 0 } = {}) {
      const scopeKey = scopeKeyOf(message);
      const history = storage.conversations.history(scopeKey, historyLimit);

      const messages = [{ role: 'system', content: systemPrompt }];

      if (contextLines > 0 && message.isGroup) {
        const recent = storage.messages
          .recentInGroup(message.groupId, Date.now() - 10 * 60_000, contextLines)
          .reverse()
          .filter((r) => String(r.user_id) !== String(message.selfId))
          .map((r) => `${r.nickname || r.user_id}: ${r.text}`)
          .join('\n');
        if (recent) messages.push({ role: 'system', content: `群内最近聊天（供参考，不必逐条回应）：\n${recent}` });
      }

      messages.push(...history);
      messages.push({ role: 'user', content: `${message.nickname || message.userId}: ${message.text}` });
      return { scopeKey, messages };
    },

    remember(scopeKey, userContent, assistantContent) {
      storage.conversations.append(scopeKey, 'user', userContent, maxKeep);
      if (assistantContent) storage.conversations.append(scopeKey, 'assistant', assistantContent, maxKeep);
      logger?.debug(`会话已更新: ${scopeKey}`);
    },

    reset(scopeKey) {
      return storage.conversations.clear(scopeKey);
    },
  };
}

/** 把统计结果改写成给模型看的紧凑事实，避免模型自己编数据。 */
export function statsFactsForPrompt(report) {
  const lines = [
    `群号：${report.groupId}`,
    `统计周期：${report.period.label}`,
    `消息总数：${report.total}`,
    `活跃成员数：${report.activeUsers}`,
  ];
  if (report.topUsers.length) {
    lines.push('活跃榜：' + report.topUsers.map((u) => `${u.rank}.${u.nickname}(${u.count})`).join(' '));
  }
  return lines.join('\n');
}

export function buildStatsAnswerPrompt(storage, groupId, question, { period = 'today', now = Date.now() } = {}) {
  const report = buildGroupReport(storage, groupId, { period, top: 10, now });
  return {
    report,
    messages: [
      {
        role: 'system',
        content: `${DEFAULT_PERSONA}\n\n以下是本群的真实统计数据，回答必须以此为准，不得编造数字：\n${statsFactsForPrompt(report)}`,
      },
      { role: 'user', content: question },
    ],
  };
}
