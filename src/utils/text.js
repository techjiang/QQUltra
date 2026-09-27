/**
 * 文本归一化：自动化检测里所有关键词/风控规则都跑在归一化结果上。
 * 中文群里最常见的规避手段是「全角字符、零宽字符、插空格、拼音分隔」，
 * 因此这里把它们统一抹平，避免规则被轻易绕过。
 */
const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

export function normalizeText(input) {
  if (input === null || input === undefined) return '';
  let text = String(input);
  text = text.replace(ZERO_WIDTH, '');
  text = toHalfWidth(text);
  return text;
}

export function toHalfWidth(text) {
  return text.replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ');
}

/**
 * 抹掉「插在字与字之间的分隔符」，用于对抗 "加 微 信" / "加-微-信" 这类规避写法。
 * 只在检测阶段使用，不用于展示。
 */
export function defuse(text) {
  return normalizeText(text)
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

export function truncate(text, max = 200) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从事件消息段里抽出纯文本，图片/表情等非文本段折算为占位标记。 */
export function segmentsToText(segments = []) {
  if (typeof segments === 'string') return segments;
  return segments
    .map((seg) => {
      switch (seg?.type) {
        case 'text':
          return seg.data?.text ?? '';
        case 'image':
          return '[图片]';
        case 'face':
          return '[表情]';
        case 'at':
          return `@${seg.data?.qq ?? 'unknown'}`;
        case 'reply':
          return '';
        default:
          return '';
      }
    })
    .join('')
    .trim();
}
