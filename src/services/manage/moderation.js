/**
 * 群聊管理：违规处置执行 + 入群审核。
 *
 * 这里是唯一真正调用适配器做「权限动作」的地方，
 * 所有动作都会留痕（storage.violations），便于事后查「机器人为什么踢了他」。
 *
 * 升级依据由 detectEngine.recordPunish 写入的 kind='punish' 记录提供，
 * 这里只负责执行动作，不重复计数。
 */
export function createModerator({ storage, adapter, logger, config = {} }) {
  const muteSeconds = config.muteSeconds ?? 600;
  // 事件窗口优先取群配置（/config set detect.punish.incidentWindowMs），
  // 再回落到全局默认值。之前这里只认构造参数，群配置里的值传不进来，
  // 于是「改了配置但行为没变」且完全静默。
  const resolveIncidentWindowMs =
    config.resolveIncidentWindowMs ?? (() => config.incidentWindowMs ?? 60_000);

  const notify = async (groupId, text) => {
    try {
      await adapter.sendGroupMessage(groupId, text);
    } catch (err) {
      logger?.warn(`处罚通知发送失败: ${err.message}`);
    }
  };

  return {
    /**
     * 执行检测引擎给出的决定。返回实际执行的动作（可能降级）。
     *
     * 同一用户在 incidentWindowMs 内的重复处罚会被跳过：
     * 一次刷屏会连续命中多条消息，逐条禁言既没意义又会把升级阶梯顶满。
     */
    async apply(message, decision) {
      if (!decision || decision.action === 'none') return 'none';

      const { groupId, userId, messageId } = message;

      if (['mute', 'kick'].includes(decision.action)) {
        const incidentWindowMs = Number(resolveIncidentWindowMs(groupId)) || 0;
        const sinceLast = storage.violations.msSinceLastPunish(groupId, userId);
        if (sinceLast !== null && sinceLast < incidentWindowMs) {
          logger?.debug(`同一事件窗口内已处罚过 ${userId}，跳过重复处置`);
          return 'skipped';
        }
      }

      let executed = decision.action;

      try {
        // 先撤回，再禁言：顺序反了会因发言者已被禁言而让撤回看起来失败
        if (['mute', 'kick'].includes(decision.action) && messageId) {
          await adapter.deleteMessage(messageId).catch((err) => {
            logger?.warn(`撤回失败（可能非管理员）: ${err.message}`);
          });
        }

        if (decision.action === 'mute') {
          const seconds = decision.muteSeconds || muteSeconds;
          await adapter.muteMember(groupId, userId, seconds);
          await notify(groupId, `🚫 ${message.nickname || userId} 因${decision.reason}被禁言 ${seconds} 秒`);
        } else if (decision.action === 'kick') {
          await adapter.kickMember(groupId, userId, true);
          await notify(groupId, `👢 ${message.nickname || userId} 因${decision.reason}被移出本群`);
        } else if (decision.action === 'warn') {
          await notify(groupId, `⚠️ ${message.nickname || userId} 请注意：${decision.reason}`);
        }
      } catch (err) {
        // 机器人权限不足（非管理员）时降级为提醒，不能因为执行失败就崩掉主循环
        logger?.warn(`处罚执行失败，降级为提醒: ${err.message}`);
        executed = 'degraded';
        await notify(groupId, `⚠️ ${message.nickname || userId} 请注意群规（自动处置失败，请管理员处理）`);
      }

      // punish 事件由 detectEngine.commit 统一写入，这里只回传实际执行结果
      return executed;
    },

    /** 入群申请人工审核：由 /approve 决定是否放行。 */
    async handleJoinRequest(request, { approve, reason = '' }) {
      if (request.subType !== 'add') return;
      await adapter.setGroupAddRequest(request.flag, approve, reason);
      logger?.info(`入群申请 ${request.userId} → ${approve ? '通过' : '拒绝'}`);
    },

    /**
     * 新人入群：登记入群时间 + 可选欢迎语。
     *
     * 登记必须先于一切分支执行，且不受 welcome.enabled 影响——
     * 入群时间是新成员风控的基准，关掉欢迎语不该顺带关掉「新人观察期」。
     */
    async handleMemberIncrease(notice) {
      const { withDefaults } = await import('./group-config.js');
      const settings = withDefaults(storage.groups.get(notice.groupId)?.settings ?? {});

      storage.members.markJoined({
        groupId: notice.groupId,
        userId: notice.userId,
        nickname: notice.senderName ?? null,
        timestamp: notice.timestamp ?? Date.now(),
      });

      if (!settings.welcome?.enabled) return;
      if (settings.welcome.text === '') return;

      const text = settings.welcome.text
        .replaceAll('{at}', `[CQ:at,qq=${notice.userId}]`)
        .replaceAll('{nickname}', notice.senderName ?? notice.userId)
        .replaceAll('{group}', storage.groups.get(notice.groupId)?.name ?? notice.groupId);
      await adapter.sendGroupMessage(notice.groupId, text).catch((err) => logger?.warn(`欢迎语发送失败: ${err.message}`));
    },
  };
}
