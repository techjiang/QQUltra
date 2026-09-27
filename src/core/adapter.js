import { AdapterError } from '../utils/errors.js';

/**
 * 适配器契约。QQUltra 的核心逻辑（统计/检测/AI/管理）只依赖这一层，
 * 换协议端（OneBot11 / OneBot12 / 其他）不影响业务模块。
 *
 * 子类需实现 _connect/_send/_disconnect，并调用 emitMessage / emitNotice / emitRequest。
 */
export class Adapter extends EventTarget {
  constructor({ logger } = {}) {
    super();
    this.logger = logger;
    this.connected = false;
    this.selfId = null;
  }

  get name() {
    return 'adapter';
  }

  async connect() {
    if (this.connected) return;
    try {
      await this._connect();
      this.connected = true;
      this.dispatchEvent(new CustomEvent('ready', { detail: { selfId: this.selfId } }));
      this.logger?.info(`${this.name} 已连接 (self=${this.selfId ?? '未知'})`);
    } catch (err) {
      throw err instanceof AdapterError ? err : new AdapterError(`${this.name} 连接失败: ${err.message}`, { cause: err });
    }
  }

  async disconnect() {
    if (!this.connected) return;
    await this._disconnect();
    this.connected = false;
    this.logger?.info(`${this.name} 已断开`);
  }

  /** 发送动作，如 send_group_msg / set_group_ban。未实现的动作抛错而非静默忽略。 */
  async send(action, params = {}) {
    if (!this.connected) throw new AdapterError('适配器尚未连接');
    return this._send(action, params);
  }

  // --- 便捷方法：业务层只用这些，避免到处拼 action 字符串 ---
  sendGroupMessage(groupId, message) {
    return this.send('send_group_msg', { group_id: Number(groupId), message });
  }

  sendPrivateMessage(userId, message) {
    return this.send('send_private_msg', { user_id: Number(userId), message });
  }

  deleteMessage(messageId) {
    return this.send('delete_msg', { message_id: Number(messageId) });
  }

  muteMember(groupId, userId, durationSeconds) {
    return this.send('set_group_ban', {
      group_id: Number(groupId),
      user_id: Number(userId),
      duration: durationSeconds,
    });
  }

  kickMember(groupId, userId, rejectAddRequest = false) {
    return this.send('set_group_kick', {
      group_id: Number(groupId),
      user_id: Number(userId),
      reject_add_request: rejectAddRequest,
    });
  }

  getGroupMemberList(groupId) {
    return this.send('get_group_member_list', { group_id: Number(groupId) });
  }

  getLoginInfo() {
    return this.send('get_login_info', {});
  }

  emitMessage(message) {
    this.dispatchEvent(new CustomEvent('message', { detail: message }));
  }

  emitNotice(notice) {
    this.dispatchEvent(new CustomEvent('notice', { detail: notice }));
  }

  emitRequest(request) {
    this.dispatchEvent(new CustomEvent('request', { detail: request }));
  }

  // eslint-disable-next-line no-unused-vars
  async _connect() {
    throw new AdapterError('子类必须实现 _connect');
  }

  // eslint-disable-next-line no-unused-vars
  async _send(action, params) {
    throw new AdapterError('子类必须实现 _send');
  }

  async _disconnect() {}
}
