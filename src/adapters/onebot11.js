import { Adapter } from '../core/adapter.js';
import { AdapterError } from '../utils/errors.js';
import { normalizeMessage } from '../core/events.js';
import { createLogger } from '../utils/logger.js';
import { segmentsToText } from '../utils/text.js';

/**
 * OneBot 11 适配器（兼容 go-cqhttp / Lagrange / NapCat / LLOneBot 等协议端）。
 *
 * 支持两种角色：
 * - forward（默认）：QQUltra 作为 ws 客户端连到协议端的正向 WebSocket
 * - reverse：QQUltra 起 ws 服务端，等协议端反连（适合机器人无公网入口的场景）
 */
export class OneBot11Adapter extends Adapter {
  constructor(options = {}) {
    super({ logger: options.logger ?? createLogger({ level: options.logLevel ?? 'info', scope: 'onebot11' }) });
    this.mode = options.mode ?? 'forward';
    this.wsUrl = options.wsUrl ?? 'ws://127.0.0.1:3001';
    this.accessToken = options.accessToken ?? '';
    this.listenHost = options.listenHost ?? '0.0.0.0';
    this.listenPort = options.listenPort ?? 8642;
    this.reconnectDelay = options.reconnectDelay ?? 3000;
    this.maxReconnectDelay = options.maxReconnectDelay ?? 60_000;
    this.heartbeatInterval = options.heartbeatInterval ?? 30_000;

    this.socket = null;
    this.server = null;
    this.clients = new Set();
    this.pending = new Map();
    this.echoSeq = 0;
    this.reconnectAttempts = 0;
    this.closing = false;
    this.heartbeatTimer = null;
  }

  get name() {
    return `onebot11:${this.mode}`;
  }

  // ---------------------------------------------------------------- 连接

  async _connect() {
    if (this.mode === 'reverse') return this._startServer();
    return this._connectForward();
  }

  async _connectForward() {
    const url = this.accessToken ? appendToken(this.wsUrl, this.accessToken) : this.wsUrl;
    await new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        reject(new AdapterError(`WebSocket 创建失败: ${err.message}`, { cause: err }));
        return;
      }

      const onOpen = () => {
        cleanup();
        this.socket = socket;
        this.reconnectAttempts = 0;
        this._attachSocket(socket, { resolveAction: false });
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new AdapterError(`无法连接 OneBot 服务端 ${this.wsUrl}`));
      };
      const cleanup = () => {
        socket.removeEventListener?.('open', onOpen);
        socket.removeEventListener?.('error', onError);
      };

      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
    });
  }

  async _startServer() {
    const { WebSocketServer } = await import('node:http');
    const http = await import('node:http');

    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', app: 'QQUltra', mode: 'reverse' }));
    });

    this.wss = new WebSocketServer({ server });
    this.wss.on('connection', (socket, req) => {
      if (this.accessToken && !checkToken(req, this.accessToken)) {
        this.logger.warn('反向连接鉴权失败，已拒绝');
        socket.close(4001, 'unauthorized');
        return;
      }
      this.logger.info('协议端已反向连接');
      this.clients.add(socket);
      socket.addEventListener('close', () => this.clients.delete(socket));
      this._attachSocket(socket, { resolveAction: true });
    });

    this.server = server;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.listenPort, this.listenHost, resolve);
    });
    this.logger.info(`反向 WebSocket 已监听 ${this.listenHost}:${this.listenPort}`);
  }

  _attachSocket(socket, { resolveAction }) {
    socket.addEventListener('message', (ev) => this._onData(ev.data, { resolveAction }));
    socket.addEventListener('close', () => {
      if (this.closing) return;
      this.logger.warn('与协议端的连接已断开');
      this.connected = false;
      this._scheduleReconnect();
    });
    socket.addEventListener('error', (ev) => {
      this.logger.debug(`socket 错误: ${ev?.message ?? 'unknown'}`);
    });
    this._startHeartbeat();
  }

  _scheduleReconnect() {
    if (this.mode !== 'forward' || this.closing) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(this.reconnectDelay * 2 ** (this.reconnectAttempts - 1), this.maxReconnectDelay);
    this.logger.info(`${Math.round(delay / 1000)}s 后重连（第 ${this.reconnectAttempts} 次）`);
    setTimeout(() => {
      if (this.closing) return;
      this._connectForward()
        .then(() => {
          this.connected = true;
          this.dispatchEvent(new CustomEvent('ready', { detail: { selfId: this.selfId, reconnected: true } }));
        })
        .catch((err) => {
          this.logger.warn(`重连失败: ${err.message}`);
          this._scheduleReconnect();
        });
    }, delay).unref?.();
  }

  _startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.getLoginInfo()
        .then((info) => {
          if (info?.user_id) this.selfId = String(info.user_id);
        })
        .catch(() => {});
    }, this.heartbeatInterval);
    this.heartbeatTimer.unref?.();
  }

  // ---------------------------------------------------------------- 收报

  async _onData(raw, { resolveAction }) {
    let payload;
    try {
      payload = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      this.logger.warn('收到非 JSON 报文，已忽略');
      return;
    }

    // API 响应：带 echo 且与已发出的请求匹配
    if (payload.echo !== undefined && this.pending.has(String(payload.echo))) {
      const { resolve, reject, timer } = this.pending.get(String(payload.echo));
      this.pending.delete(String(payload.echo));
      clearTimeout(timer);
      if (payload.status === 'ok' || payload.retcode === 0) resolve(payload.data);
      else reject(new AdapterError(`动作失败: ${payload.message ?? payload.wording ?? payload.retcode}`));
      return;
    }

    if (payload.post_type === 'meta_event' && payload.meta_event_type === 'lifecycle') {
      if (payload.self_id) this.selfId = String(payload.self_id);
      return;
    }

    if (payload.post_type === 'message' || payload.post_type === 'message_sent') {
      const message = this._translateMessage(payload);
      this.emitMessage(message);
      return;
    }

    if (payload.post_type === 'notice') {
      this.emitNotice(this._translateNotice(payload));
      return;
    }

    if (payload.post_type === 'request') {
      this.emitRequest(this._translateRequest(payload));
      return;
    }

    if (resolveAction) this.logger.debug(`未处理的事件类型: ${payload.post_type}`);
  }

  _translateMessage(payload) {
    const segments = Array.isArray(payload.message)
      ? payload.message
      : typeof payload.message === 'string'
        ? [{ type: 'text', data: { text: payload.message } }]
        : [];
    const sender = payload.sender ?? {};

    return normalizeMessage({
      platform: 'onebot11',
      selfId: payload.self_id ?? this.selfId,
      groupId: payload.message_type === 'group' ? payload.group_id : null,
      userId: payload.user_id,
      nickname: sender.card || sender.nickname || String(payload.user_id ?? ''),
      role: sender.role ?? 'member',
      messageId: payload.message_id,
      // message_sent（机器人自己发的）不进统计，避免把机器人算成活跃成员
      text: segmentsToText(segments),
      segments,
      timestamp: payload.time ? payload.time * 1000 : Date.now(),
      raw: payload,
    });
  }

  _translateNotice(payload) {
    return {
      platform: 'onebot11',
      subType: payload.notice_type,
      groupId: payload.group_id === undefined ? null : String(payload.group_id),
      userId: payload.user_id === undefined ? null : String(payload.user_id),
      operatorId: payload.operator_id === undefined ? null : String(payload.operator_id),
      targetId: payload.target_id === undefined ? null : String(payload.target_id),
      // group_recall 的 message_id 用于事后追查「我们漏了哪条」，
      // 之前没带出来，撤回通知即使被处理也无从对应到具体消息
      messageId: payload.message_id === undefined ? null : String(payload.message_id),
      duration: payload.duration,
      timestamp: payload.time ? payload.time * 1000 : Date.now(),
      raw: payload,
    };
  }

  _translateRequest(payload) {
    return {
      platform: 'onebot11',
      subType: payload.request_type,
      flag: payload.flag,
      groupId: payload.group_id === undefined ? null : String(payload.group_id),
      userId: payload.user_id === undefined ? null : String(payload.user_id),
      comment: payload.comment ?? '',
      timestamp: payload.time ? payload.time * 1000 : Date.now(),
      raw: payload,
    };
  }

  // ---------------------------------------------------------------- 发送

  async _send(action, params) {
    const payload = { action, params, echo: `qqu-${++this.echoSeq}-${Date.now()}` };
    const sockets =
      this.mode === 'reverse' ? [...this.clients].filter((s) => s.readyState === 1) : this.socket ? [this.socket] : [];

    if (sockets.length === 0) throw new AdapterError(`没有可用连接，无法执行 ${action}`);

    // 反向模式下协议端可能多开，任何一条响应都算数
    const responses = sockets.map((socket) => this._sendTo(socket, payload));
    return Promise.any(responses);
  }

  _sendTo(socket, payload) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(payload.echo));
        reject(new AdapterError(`动作 ${payload.action} 超时`));
      }, 15_000);
      this.pending.set(String(payload.echo), { resolve, reject, timer });
      try {
        socket.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(String(payload.echo));
        reject(new AdapterError(`发送失败: ${err.message}`, { cause: err }));
      }
    });
  }

  async _disconnect() {
    this.closing = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new AdapterError('连接已关闭'));
    }
    this.pending.clear();

    for (const client of this.clients) client.close?.(1000, 'bye');
    this.clients.clear();
    this.socket?.close?.(1000, 'bye');
    this.wss?.close?.();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }

  /** 供人工审核入群请求使用：approve/reject */
  setGroupAddRequest(flag, approve, reason = '') {
    return this.send('set_group_add_request', { flag, sub_type: 'add', approve, reason });
  }
}

function appendToken(url, token) {
  const u = new URL(url);
  u.searchParams.set('access_token', token);
  return u.toString();
}

function checkToken(req, token) {
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${token}`) return true;
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get('access_token') === token;
}
