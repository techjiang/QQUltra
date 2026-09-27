import { normalizeText, segmentsToText } from '../../utils/text.js';

/**
 * 统计采集器：把一条消息落成「明细 + 成员汇总」。
 *
 * 隐私边界写在这里而不是散在各处：
 * - 不存原始 IP / 客户端信息
 * - 机器人自己发的消息（message_sent）不入库，避免把自己算成活跃成员
 * - 撤回的消息不删明细，统计口径要能对得上历史
 */
export function createCollector({ storage, logger }) {
  return {
    /** @returns {{ recorded: boolean, reason?: string }} */
    record(message) {
      if (!message?.isGroup) return { recorded: false, reason: 'private' };
      if (message.userId === message.selfId) return { recorded: false, reason: 'self' };

      const text = normalizeText(message.text || segmentsToText(message.segments));
      const isCommand = text.startsWith('/');

      try {
        storage.db.transaction(() => {
          storage.groups.ensure(message.groupId);
          // 明细始终记录（含指令），便于对账与审计
          storage.messages.insert({ ...message, text, isCommand });

          // 但成员汇总只统计正常发言：指令是「对机器人下的操作」，
          // 计进去会让管理员每查一次统计就给自己刷一条发言数
          if (!isCommand) {
            storage.members.upsert({
              groupId: message.groupId,
              userId: message.userId,
              nickname: message.nickname,
              timestamp: message.timestamp,
            });
          }
        });
      } catch (err) {
        logger?.error(`消息入库失败: ${err.message}`);
        return { recorded: false, reason: 'storage-error' };
      }

      return { recorded: true };
    },
  };
}
