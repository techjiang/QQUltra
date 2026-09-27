import { Adapter } from '../core/adapter.js';
import { createLogger } from '../utils/logger.js';

/**
 * 离线适配器：不连任何协议端，把发出的消息收进 outbox。
 * 用途是本地演示与端到端测试——统计、检测、处罚、AI 链路都能在没有 QQ 的环境里跑通。
 */
let messageIdSeq = 1000;
const nextMessageId = () => messageIdSeq++;

export class MockAdapter extends Adapter {
  constructor({ logger, selfId = '10000', groupId = '9527' } = {}) {
    super({ logger: logger ?? createLogger({ level: 'warn', scope: 'mock' }) });
    this.selfId = String(selfId);
    this.groupId = String(groupId);
    this.outbox = [];
    this.actions = [];
  }

  get name() {
    return 'mock';
  }

  async _connect() {
    // connected 由基类 Adapter.connect() 统一置位，这里不重复维护
  }

  async _send(action, params) {
    this.actions.push({ action, params });
    if (action === 'send_group_msg') this.outbox.push({ groupId: String(params.group_id), message: params.message });
    if (action === 'get_login_info') return { user_id: Number(this.selfId), nickname: 'QQUltra' };
    if (action === 'get_group_member_list') return [];
    return { status: 'ok' };
  }

  /** 与 OneBot11Adapter 保持能力对齐，供入群审核链路使用。 */
  setGroupAddRequest(flag, approve, reason = '') {
    return this.send('set_group_add_request', { flag, sub_type: 'add', approve, reason });
  }

  /**
   * 便捷入口：把文本当作某个群成员发来的消息注入。
   *
   * 返回一个 Promise，在事件被派发后 resolve——调用方可以 await 它，
   * 但不能据此断言业务处理已结束（派发链路是异步的）。
   * 需要「处理完再断言」时用 bot.inject()。
   */
  say({ userId, nickname = '', text, role = 'member', messageId = null, groupId = this.groupId, segments = null, timestamp = Date.now() }) {
    const message = {
      platform: 'mock',
      selfId: this.selfId,
      groupId,
      userId: String(userId),
      nickname: nickname || String(userId),
      role,
      // OneBot 的 delete_msg 只接受整数 message_id，这里不能用浮点拼接
      messageId: messageId ? String(messageId) : String(nextMessageId()),
      text,
      segments: segments ?? [
        { type: 'text', data: { text } },
        ...(text.includes('@bot') ? [{ type: 'at', data: { qq: this.selfId } }] : []),
      ],
      timestamp,
      isGroup: groupId !== null,
    };
    this.emitMessage(message);
    return message;
  }

  lastReply() {
    return this.outbox.at(-1)?.message ?? null;
  }

  clearOutbox() {
    this.outbox.length = 0;
    this.actions.length = 0;
  }
}
