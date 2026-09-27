/**
 * 领域事件总线。适配器只负责把平台事件翻译成 QQUltraEvent；
 * 统计、检测、管理各模块都订阅同一条事件流，互不感知。
 *
 * 用 async 串行派发而非并行：检测模块要能在统计写入前拦下消息（撤回/禁言），
 * 顺序错乱会导致「先计数后封禁」的脏数据。
 */
export const EVENTS = {
  MESSAGE: 'message',
  NOTICE: 'notice',
  REQUEST: 'request',
  READY: 'ready',
  ERROR: 'error',
};

export function createEventBus({ logger } = {}) {
  const handlers = new Map();

  const on = (event, handler, { name } = {}) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push({ handler, name: name ?? handler.name ?? 'anonymous' });
    return () => off(event, handler);
  };

  const off = (event, handler) => {
    const list = handlers.get(event);
    if (!list) return;
    const idx = list.findIndex((h) => h.handler === handler);
    if (idx >= 0) list.splice(idx, 1);
  };

  const emit = async (event, payload) => {
    // 事件名写错（例如把 payload 当第一个参数传）在旧实现里是「静默什么都不做」，
    // 排查起来像业务逻辑失灵。这里直接拒绝，让错误出现在它发生的地方。
    if (typeof event !== 'string' || event === '') {
      throw new TypeError('事件总线 emit(event, payload) 缺少事件名');
    }
    const list = handlers.get(event) ?? [];
    const results = [];
    for (const { handler, name } of list) {
      try {
        results.push(await handler(payload));
      } catch (err) {
        // 单个订阅者出错不能拖垮整条链路：群里最怕的是机器人因一条脏消息彻底静默。
        logger?.error(`事件处理失败 [${event}/${name}]: ${err.message}`);
        logger?.debug(err.stack);
        results.push(undefined);
      }
    }
    return results;
  };

  return {
    on,
    off,
    emit,
    listenerCount: (event) => (handlers.get(event) ?? []).length,
    clear: () => handlers.clear(),
  };
}

/** 构造统一消息实体，屏蔽不同适配器的字段差异。 */
export function normalizeMessage(input) {
  if (!input || typeof input !== 'object') throw new TypeError('normalizeMessage 需要消息对象');
  return {
    platform: input.platform ?? 'onebot11',
    selfId: String(input.selfId ?? ''),
    groupId: input.groupId === undefined || input.groupId === null ? null : String(input.groupId),
    userId: String(input.userId),
    nickname: input.nickname ?? '',
    role: input.role ?? 'member',
    messageId: input.messageId === undefined || input.messageId === null ? null : String(input.messageId),
    text: String(input.text ?? ''),
    segments: Array.isArray(input.segments) ? input.segments : [],
    timestamp: Number(input.timestamp ?? Date.now()),
    raw: input.raw ?? null,
    isGroup: (input.groupId ?? null) !== null,
  };
}
