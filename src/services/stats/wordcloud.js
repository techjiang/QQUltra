/**
 * 词云：从群消息里抽高频词。
 *
 * 不引第三方分词库（项目零依赖是硬约束，也是长期可维护的前提），
 * 改用「中文二元切分 + 英文单词 + 停用词过滤」：
 * 中文没有词库也能靠 bigram 抓到「排位」「更新」这类高频组合，
 * 精度不如成熟分词，但用于群活跃画像足够，且完全确定性、可单测。
 */

/** 高频到没有信息量的词。表要短而准，长了会误删真实话题。 */
export const STOP_WORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '在', '有', '和', '就', '都', '也', '不', '这', '那', '吗',
  '呢', '吧', '啊', '呀', '哦', '嗯', '哈', '嘛', '什么', '怎么', '可以', '一个', '我们', '你们', '他们', '自己',
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'it', 'this', 'that', 'with',
  '图片', '表情', '哈哈', '哈哈哈', '哈哈哈哈哈',
]);

/** CQ 码与占位标记不该进词云。 */
const NOISE = /\[CQ:[^\]]*\]|\[图片\]|\[表情\]|\[自定义表情\]|\[语音\]|\[视频\]|\[文件\]/g;

/**
 * 切词：英文/数字按单词，中文按 2-gram。
 * @returns {string[]} 归一化后的候选词
 */
export function tokenize(text) {
  const cleaned = String(text ?? '')
    .replace(NOISE, ' ')
    .toLowerCase()
    // 只保留中日韩、字母、数字，其余当分隔符
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ')
    .trim();
  if (!cleaned) return [];

  const tokens = [];
  for (const chunk of cleaned.split(/\s+/)) {
    if (!chunk) continue;
    if (/^[a-z0-9]+$/.test(chunk)) {
      if (chunk.length <= 20) tokens.push(chunk);
      continue;
    }
    // 中文串：长度 1 时保留单字（如「早」），否则滑窗取 2-gram
    if (chunk.length === 1) {
      tokens.push(chunk);
      continue;
    }
    for (let i = 0; i + 2 <= chunk.length; i += 1) tokens.push(chunk.slice(i, i + 2));
  }
  return tokens;
}

/**
 * 统计词频。
 * @returns {{ word: string, count: number }[]} 按词频降序，同频时按词序稳定排序
 */
export function countWords(texts, { top = 30, minCount = 2, stopWords = STOP_WORDS } = {}) {
  const freq = new Map();
  for (const text of texts) {
    // 同一句话里的重复词只算一次，否则一句「哈哈哈笑死哈哈哈」就能刷满
    for (const word of new Set(tokenize(text))) {
      if (stopWords.has(word)) continue;
      if (word.length < 1) continue;
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([word, count]) => ({ word, count }));
}

/** 词云 → 纯文本渲染（群里可贴，无需图片即可读）。 */
export function renderWordCloudText(words, { limit = 20 } = {}) {
  if (words.length === 0) return '暂无足够语料生成词云（至少需要几条正常发言）';
  const max = words[0].count;
  return words
    .slice(0, limit)
    .map(({ word, count }) => {
      // 用方块表示权重，避免依赖终端/客户端的富文本能力
      const bars = '█'.repeat(Math.max(1, Math.round((count / max) * 10)));
      return `${bars} ${word} ×${count}`;
    })
    .join('\n');
}
