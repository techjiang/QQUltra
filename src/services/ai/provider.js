import { ConfigError } from '../../utils/errors.js';

/**
 * OpenAI 兼容协议的 Chat Completions 客户端。
 * CNB / DeepSeek / 通义 / 自建 vLLM 都走这套接口，因此只实现一种协议。
 */
export function createOpenAICompatibleProvider({
  baseUrl = 'https://api.openai.com/v1',
  apiKey = '',
  model = 'gpt-4o-mini',
  temperature = 0.7,
  maxTokens = 512,
  timeout = 60_000,
  logger,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new ConfigError('AI 服务缺少 apiKey，请在配置中设置 ai.apiKey');

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    name: 'openai-compatible',
    model,
    async chat(messages, { signal, temperature: t, maxTokens: mt } = {}) {
      const controller = new AbortController();
      let externallyAborted = false;
      const timer = setTimeout(() => controller.abort(), timeout);
      const onAbort = () => {
        externallyAborted = true;
        controller.abort();
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: t ?? temperature,
            max_tokens: mt ?? maxTokens,
            stream: false,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`AI 接口返回 ${res.status}: ${body.slice(0, 300)}`);
        }

        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim() === '') {
          throw new Error('AI 接口未返回有效内容');
        }
        return {
          content: content.trim(),
          usage: data.usage ?? null,
          model: data.model ?? model,
        };
      } catch (err) {
        // 区分「自己超时」与「外部取消」：两者错误名相同，混在一起会把
        // 「进程退出/调用方主动放弃」报成「AI 请求超时」，排查时方向直接跑偏。
        if (err.name === 'AbortError') {
          throw new Error(externallyAborted ? 'AI 请求已取消' : 'AI 请求超时');
        }
        logger?.warn(`AI 请求失败: ${err.message}`);
        throw err;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
