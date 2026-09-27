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
        let deduped = false;
        storage.db.transaction(() => {
          storage.groups.ensure(message.groupId);
          // 明细始终记录（含指令），便于对账与审计
          const result = storage.messages.insert({ ...message, text, isCommand });
          deduped = result.deduped;

          // 重放的重复消息不能再累加成员汇总：否则「发言数」会随重放次数增长，
          // 与明细行数对不上。去重是整条链路的口径问题，不只是明细表的事。
          // 成员汇总本身只统计正常发言：指令是「对机器人下的操作」，
          // 计进去会让管理员每查一次统计就给自己刷一条发言数
          if (!isCommand && !deduped) {
            storage.members.upsert({
              groupId: message.groupId,
              userId: message.userId,
              nickname: message.nickname,
              timestamp: message.timestamp,
            });
          }
        });
        if (deduped) {
          logger?.debug(`跳过协议端重放的重复消息 group=${message.groupId} messageId=${message.messageId}`);
          return { recorded: false, reason: 'deduped' };
        }
      } catch (err) {
        logger?.error(`消息入库失败: ${err.message}`);
        return { recorded: false, reason: 'storage-error' };
      }

      return { recorded: true };
    },
  };
}
