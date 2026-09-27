import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeStorage, makeBot, silentLogger } from './helpers.js';
import { createOpenAICompatibleProvider } from '../src/services/ai/provider.js';
import { createSessionManager, buildStatsAnswerPrompt, statsFactsForPrompt, DEFAULT_PERSONA } from '../src/services/ai/session.js';
import { mergeDeep, DEFAULT_CONFIG } from '../src/config.js';

/** 用假 fetch 验证请求构造与错误处理，避免测试打真实网络。 */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return handler(calls.length, options);
  };
  return { impl, calls };
}

const okResponse = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 42 }, model: 'test-model' }),
});

describe('AI Provider（OpenAI 兼容）', () => {
  test('缺少 apiKey 直接拒绝构造', () => {
    assert.throws(() => createOpenAICompatibleProvider({ apiKey: '' }), /apiKey/);
  });

  test('请求体与鉴权头按协议构造', async () => {
    const { impl, calls } = fakeFetch(() => okResponse('你好'));
    const provider = createOpenAICompatibleProvider({ apiKey: 'sk-x', model: 'm1', baseUrl: 'https://api.example.com/v1', fetchImpl: impl });

    const result = await provider.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(result.content, '你好');
    assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions');
    assert.equal(calls[0].options.headers.authorization, 'Bearer sk-x');
    assert.equal(calls[0].body.model, 'm1');
    assert.equal(calls[0].body.stream, false);
  });

  test('baseUrl 结尾斜杠不会产生双斜杠', async () => {
    const { impl, calls } = fakeFetch(() => okResponse('x'));
    await createOpenAICompatibleProvider({ apiKey: 'k', baseUrl: 'https://a.com/v1///', fetchImpl: impl }).chat([]);
    assert.equal(calls[0].url, 'https://a.com/v1/chat/completions');
  });

  test('HTTP 错误带状态码与响应体片段', async () => {
    const { impl } = fakeFetch(() => ({ ok: false, status: 429, text: async () => 'rate limited' }));
    const provider = createOpenAICompatibleProvider({ apiKey: 'k', fetchImpl: impl });
    await assert.rejects(() => provider.chat([]), /429.*rate limited/);
  });

  test('响应缺少内容时报错而不是返回空串', async () => {
    const { impl } = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }));
    await assert.rejects(() => createOpenAICompatibleProvider({ apiKey: 'k', fetchImpl: impl }).chat([]), /未返回有效内容/);
  });

  test('超时被转换为可读错误', async () => {
    const impl = async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };
    await assert.rejects(() => createOpenAICompatibleProvider({ apiKey: 'k', fetchImpl: impl }).chat([]), /超时/);
  });
});

describe('AI 会话与提示词', () => {
  test('群聊共享一段记忆，私聊独立', () => {
    const storage = makeStorage();
    const sessions = createSessionManager({ storage, logger: silentLogger });
    assert.equal(sessions.scopeKeyOf({ isGroup: true, groupId: '9527', userId: 'a' }), 'group:9527');
    assert.equal(sessions.scopeKeyOf({ isGroup: false, groupId: null, userId: 'a' }), 'user:a');
    storage.close();
  });

  test('提示词包含人设、历史与当前提问', async () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const sessions = createSessionManager({ storage, logger: silentLogger });
    sessions.remember('group:9527', '第一个问题', '第一个回答');

    const { messages, scopeKey } = await sessions.buildPrompt({ isGroup: true, groupId: '9527', userId: 'a', nickname: '阿离', text: '第二个问题' });
    assert.equal(scopeKey, 'group:9527');
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, DEFAULT_PERSONA);
    assert.ok(messages.some((m) => m.content === '第一个问题'));
    assert.ok(messages.some((m) => m.content === '第一个回答'));
    assert.equal(messages.at(-1).content, '阿离: 第二个问题');
    storage.close();
  });

  test('历史条数受 historyLimit 限制', async () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const sessions = createSessionManager({ storage, historyLimit: 2, logger: silentLogger });
    for (let i = 0; i < 10; i += 1) sessions.remember('group:9527', `q${i}`, `a${i}`);

    const { messages } = await sessions.buildPrompt({ isGroup: true, groupId: '9527', userId: 'a', text: 'now' });
    const history = messages.filter((m) => m.role !== 'system');
    assert.equal(history.length, 3, '2 条历史 + 1 条当前提问');
    storage.close();
  });

  test('reset 清空该会话记忆', () => {
    const storage = makeStorage();
    const sessions = createSessionManager({ storage, logger: silentLogger });
    sessions.remember('group:1', 'q', 'a');
    assert.equal(sessions.reset('group:1'), 2);
    assert.deepEqual(storage.conversations.history('group:1'), []);
    storage.close();
  });

  test('统计事实注入提示词，防止模型编造数字', () => {
    const storage = makeStorage();
    storage.groups.ensure('9527');
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      storage.messages.insert({ groupId: '9527', userId: 'a', nickname: '阿离', text: 'x', segments: [], timestamp: now - i * 100 });
    }
    const { messages, report } = buildStatsAnswerPrompt(storage, '9527', '群里活跃吗', { period: 'all', now: now + 1000 });
    assert.equal(report.total, 3);
    assert.match(messages[0].content, /消息总数：3/);
    assert.match(statsFactsForPrompt(report), /活跃榜：1\.阿离\(3\)/);
    storage.close();
  });
});

describe('AI 对话接入（通过 mock provider）', () => {
  /**
   * 构造带受控 AI provider 的 bot。
   * provider 通过 createBot 注入而非事后赋值——bot 内部的 maybeReplyWithAi
   * 捕获的是装配时的引用，事后改属性不会生效。
   */
  async function botWithAi(overrides = {}) {
    const storage = overrides.storage ?? makeStorage();
    const { makeBot: make } = await import('./helpers.js');
    const config = mergeDeep(
      { ...DEFAULT_CONFIG, logLevel: 'silent', ai: { ...DEFAULT_CONFIG.ai, enabled: true, apiKey: 'sk-test' } },
      overrides.config ?? {},
    );

    const calls = [];
    const provider = {
      chat: async (messages) => {
        calls.push(messages);
        return { content: `收到：${messages.at(-1).content}`, usage: null };
      },
    };

    const finalProvider = overrides.aiProvider ?? provider;
    const { bot, adapter } = await make({ storage, config, aiProvider: finalProvider });
    return { bot, storage, adapter, calls, provider: finalProvider };
  }

  test('群里 @ 机器人才回复', async () => {
    const { bot, storage, adapter } = await botWithAi();

    await bot.inject({ groupId: '9527', userId: 'a', nickname: '阿离', text: '普通聊天' });
    assert.equal(adapter.outbox.length, 0, '未 @ 不应回复');

    await bot.inject({
      groupId: '9527',
      userId: 'a',
      nickname: '阿离',
      text: '今天天气如何',
      segments: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '今天天气如何' } }],
    });
    assert.equal(adapter.outbox.length, 1);
    assert.match(adapter.lastReply(), /收到：/);
    storage.close();
  });

  test('触发方式可切换为 prefix', async () => {
    const { bot, storage, adapter } = await botWithAi();
    storage.groups.setSetting('9527', 'ai', { trigger: 'prefix', prefix: '/ai' });

    await bot.inject({ groupId: '9527', userId: 'a', text: '没前缀' });
    assert.equal(adapter.outbox.length, 0);

    await bot.inject({ groupId: '9527', userId: 'a', text: '/ai 有问题' });
    assert.equal(adapter.outbox.length, 1);
    storage.close();
  });

  test('trigger=all 时普通消息也回复', async () => {
    const { bot, storage, adapter } = await botWithAi();
    storage.groups.setSetting('9527', 'ai', { trigger: 'all' });
    await bot.inject({ groupId: '9527', userId: 'a', text: '随便说点什么' });
    assert.equal(adapter.outbox.length, 1);
    storage.close();
  });

  test('回复长度受 maxReplyLength 截断', async () => {
    const { bot, storage, adapter, calls } = await botWithAi({ aiProvider: { chat: async () => ({ content: 'x'.repeat(500) }) } });
    storage.groups.setSetting('9527', 'ai', { maxReplyLength: 10 });
    await bot.inject({
      groupId: '9527',
      userId: 'a',
      text: '问',
      segments: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '问' } }],
    });
    assert.equal(adapter.lastReply().length, 10);
    assert.equal(calls.length, 0, '应替换为定长 provider，不产生额外记录');
    storage.close();
  });

  test('未配置 provider 时给出明确提示', async () => {
    const { makeBot } = await import('./helpers.js');
    const { bot, storage, adapter } = await makeBot({ aiProvider: null });
    await bot.inject({ groupId: '9527', userId: 'a', text: '/ai 你好' });
    assert.match(adapter.lastReply(), /AI 功能未启用/);
    storage.close();
  });

  test('provider 抛错时回友好提示且不中断后续消息', async () => {
    let shouldFail = true;
    const provider = {
      chat: async () => {
        if (shouldFail) throw new Error('上游 500');
        return { content: '恢复正常' };
      },
    };
    const { bot, storage, adapter } = await botWithAi({ aiProvider: provider });

    const at = (text) => [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text } }];
    await bot.inject({ groupId: '9527', userId: 'a', text: '问', segments: at('问') });
    assert.match(adapter.lastReply(), /AI 服务暂时不可用/);

    shouldFail = false;
    await bot.inject({ groupId: '9527', userId: 'a', text: '再问', segments: at('再问') });
    assert.equal(adapter.lastReply(), '恢复正常');
    storage.close();
  });

  test('连续对话会带上上一轮上下文', async () => {
    const { bot, storage, calls } = await botWithAi();
    const at = (text) => ({ type: 'at', data: { qq: '10000' } });
    await bot.inject({ groupId: '9527', userId: 'a', nickname: '阿离', text: '我叫阿离', segments: [at(), { type: 'text', data: { text: '我叫阿离' } }] });
    await bot.inject({ groupId: '9527', userId: 'a', nickname: '阿离', text: '我叫什么', segments: [at(), { type: 'text', data: { text: '我叫什么' } }] });

    const secondPrompt = calls[1].map((m) => m.content).join('|');
    assert.match(secondPrompt, /我叫阿离/, '第二轮应带上第一轮内容');
    storage.close();
  });

  test('/ai-reset 清空记忆后不再带历史', async () => {
    const { bot, storage, calls } = await botWithAi();
    const at = (text) => ({ type: 'at', data: { qq: '10000' } });
    await bot.inject({ groupId: '9527', userId: 'a', text: '记住这句话', segments: [at('记住这句话')] });
    await bot.inject({ groupId: '9527', userId: 'a', text: '/ai-reset' });
    await bot.inject({ groupId: '9527', userId: 'a', text: '新话题', segments: [at('新话题')] });

    const lastPrompt = calls.at(-1).map((m) => m.content).join('|');
    assert.equal(lastPrompt.includes('记住这句话'), false);
    storage.close();
  });
});
