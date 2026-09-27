import { escapeRegExp } from '../../utils/text.js';

/**
 * 词云 SVG 渲染。
 *
 * 为什么选 SVG 而不是 PNG：生成图片需要 canvas 或图片库（破坏零依赖），
 * 而 SVG 是纯字符串拼接，同时 NapCat / Lagrange 等协议端会自行转码后发出。
 * 需要 PNG 的协议端也能直接处理 SVG 里的文字。
 *
 * 布局用「黄金角螺旋 + 矩形碰撞盒」：不需要字体度量就能得到不重叠的紧凑排布，
 * 且完全确定性——同样的词频永远得到同样的图，便于回归测试。
 */
const PALETTE = ['#1e90ff', '#00c2a8', '#7c5cff', '#ff7a45', '#12b886', '#e8590c', '#0ea5e9', '#a855f7'];

/**
 * 粗略估算文本宽度，避免引入字体度量依赖。
 *
 * CJK 按 1.05 em（方块字实际略宽于字号），西文按 0.6 em。
 * 估宽偏小会导致词与词视觉重叠——因为碰撞盒比实际字形小，
 * 螺旋算法以为放得下。宁可估宽一点，留白比重叠好看。
 */
export function estimateTextWidth(text, fontSize) {
  let units = 0;
  for (const ch of String(text)) units += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1.05 : 0.6;
  return units * fontSize;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * 螺旋布局：从中心向外找第一个不与已有盒子相交的位置。
 *
 * 两个关键修正（都是靠「用真实词长做压力测试」才暴露的）：
 *
 * 1. **放弃螺旋时必须挑「最好的那个位置」，而不是最后试的那个。**
 *    旧实现在 step 用尽后直接采用最后一次的坐标——那些坐标往往在画布外
 *    （因为螺旋半径一直涨），于是出现「词跑出画布」。
 *    现在记录遍历途中「最接近可用」的候选，超限时回退到它。
 *
 * 2. **螺旋半径必须被画布限制住。** 半径随 sqrt(step) 无限增长，
 *    而 2000 步后半径已经达到 sqrt(2000)*5.2 ≈ 232，再乘 x 方向 1.6 的拉伸
 *    就是 370——早超出 640x400 的范围。取半径上限后可搜索区域才是有意义的。
 *
 * 3. 词排不下时**宁可少放几个**，也不要有词叠在一起：重叠的词云是错的，
 *    少两个词的词云只是不够满。返回的 placed 因此可能短于输入，
 *    由调用方（/wordcloud）在文本里说明实际用了几个词。
 */
export function layoutWords(words, { width = 640, height = 400, maxFont = 52, minFont = 14 } = {}) {
  if (words.length === 0) return [];
  const max = words[0].count;
  const min = words.at(-1).count;
  const scale = (count) => {
    if (max === min) return (maxFont + minFont) / 2;
    const ratio = (count - min) / (max - min);
    return Math.round(minFont + ratio * (maxFont - minFont));
  };

  const cx = width / 2;
  const cy = height / 2;
  // 安全区：上方留标题、下方留水印，左右留边距
  const bounds = { left: 6, top: 44, right: width - 6, bottom: height - 22 };
  const boxes = [];
  const placed = [];

  for (const [i, item] of words.entries()) {
    const size = scale(item.count);
    const w = estimateTextWidth(item.word, size) + 6;
    // CJK 的 em 盒高度接近字号，行盒按 1.15 倍留出上下呼吸位
    const h = size * 1.15;

    // 搜索区域的半径上限：由安全区尺寸反推，保证螺旋不会跑出画布
    const spanX = (bounds.right - bounds.left) / 2;
    const spanY = (bounds.bottom - bounds.top) / 2;
    const maxRadius = Math.min(spanX / 1.6, spanY);

    let best = null; // 最接近可用的候选（越早越靠近中心）
    let bestPenalty = Infinity;
    let chosen = null;

    for (let step = 0; step < 3000; step += 1) {
      // 螺旋半径按平方根增长（面积均匀），再对 x 做 1.6 倍拉伸贴合 16:10 画布
      const radius = Math.min(5.2 * Math.sqrt(step), maxRadius);
      const angle = step * GOLDEN_ANGLE;
      const x = cx + radius * Math.cos(angle) * 1.6;
      const y = cy + radius * Math.sin(angle);
      const box = { x: x - w / 2, y: y - h / 2, w, h };
      const inside = box.x >= bounds.left && box.y >= bounds.top && box.x + box.w <= bounds.right && box.y + box.h <= bounds.bottom;

      // 越界或撞车都算「不可用」，但记录一个惩罚分：越界距离 + 重叠面积
      const penalty = collisionPenalty(box, boxes, bounds);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        best = { x, y };
      }
      if (penalty === 0) {
        chosen = { x, y, box };
        break;
      }
      // 半径已到上限且绕完一整圈仍无空位，再搜下去也不会更好
      if (radius >= maxRadius && step > 400) break;
    }

    if (!chosen) {
      // 找不到空位：宁可放弃这个词，也不让它叠在别的词上
      continue;
    }

    boxes.push(chosen.box);
    placed.push({
      word: item.word,
      count: item.count,
      x: Number(chosen.x.toFixed(1)),
      y: Number(chosen.y.toFixed(1)),
      size,
      color: PALETTE[i % PALETTE.length],
    });
  }
  return placed;
}

/** 当前位置的「糟糕程度」：0 表示完全可用。用于在螺旋搜不到空位时挑最好的退路。 */
function collisionPenalty(box, boxes, bounds) {
  const outside =
    Math.max(0, bounds.left - box.x) +
    Math.max(0, box.y - bounds.bottom) * 0 + // 保持表达式对称易读
    Math.max(0, bounds.top - box.y) +
    Math.max(0, box.x + box.w - bounds.right) +
    Math.max(0, box.y + box.h - bounds.bottom);
  let area = 0;
  for (const b of boxes) area += overlapArea(box, b);
  // 越界按「绝对不可接受」处理：给一个足够大的权重
  return outside * 1000 + area;
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * 渲染词云 SVG。
 *
 * 返回对象而不是裸字符串：布局在放不下时会主动丢词（见 layoutWords 第 3 点），
 * 调用方需要知道「实际画了几个」，否则标题写着 20 个词、图里只有 7 个，
 * 看起来像渲染出错。`svg` 字段是拼好的文档。
 */
export function renderWordCloudSvg(words, { width = 640, height = 400, title = '群聊词云' } = {}) {
  const placed = layoutWords(words, { width, height });
  const body = placed
    .map(
      (p) =>
        `  <text x="${p.x}" y="${p.y}" font-size="${p.size}" fill="${p.color}" text-anchor="middle" dominant-baseline="middle" font-family="'PingFang SC','Microsoft YaHei',sans-serif" font-weight="600">${escapeXml(p.word)}</text>`,
    )
    .join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" rx="16" fill="#0b1220"/>
  <text x="24" y="36" font-size="18" fill="#7dd3fc" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${escapeXml(title)}</text>
  <line x1="24" y1="46" x2="${width - 24}" y2="46" stroke="#1e293b" stroke-width="1"/>
${body}
  <text x="${width - 16}" y="${height - 14}" font-size="11" fill="#475569" text-anchor="end" font-family="sans-serif">QQUltra</text>
</svg>
`;
  return { svg, placed: placed.length, dropped: words.length - placed.length, words: placed };
}

function escapeXml(text) {
  return String(text)
    .replace(new RegExp(escapeRegExp('&'), 'g'), '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 把等宽文本渲染成图文卡片。
 *
 * 用途：群聊客户端对长文本会自动折叠，管理面板这种「清单」被折叠后
 * 就失去了「一眼扫完、直接点用」的意义，因此提供图卡版。
 * 每行独立成 <text>，不做自动换行——调用方给的就是已经排好版的文本。
 */
export function renderPanelSvg(text, { title = 'QQUltra', width = 720, lineHeight = 26, padding = 28 } = {}) {
  const lines = String(text).split('\n');
  const height = padding * 2 + 44 + lines.length * lineHeight;
  const body = lines
    .map((line, i) => {
      const y = padding + 44 + i * lineHeight;
      const isTitle = /^(📊|🛡|⚙️|🤖|🧭)/u.test(line);
      const isCmd = line.trimStart().startsWith('/');
      const fill = isTitle ? '#7dd3fc' : isCmd ? '#a5b4fc' : '#cbd5e1';
      const [cmd, ...desc] = line.split(' — ');
      if (isCmd && desc.length > 0) {
        return (
          `  <text x="${padding}" y="${y}" font-size="14" fill="#818cf8" font-family="'JetBrains Mono',Consolas,monospace">${escapeXml(cmd)}</text>\n` +
          `  <text x="${padding + 300}" y="${y}" font-size="14" fill="#94a3b8" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${escapeXml(desc.join(' — '))}</text>`
        );
      }
      return `  <text x="${padding}" y="${y}" font-size="${isTitle ? 16 : 14}" fill="${fill}" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${escapeXml(line)}</text>`;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" rx="16" fill="#0b1220"/>
  <text x="${padding}" y="${padding + 12}" font-size="20" fill="#e2e8f0" font-family="'PingFang SC','Microsoft YaHei',sans-serif" font-weight="600">${escapeXml(title)}</text>
  <line x1="${padding}" y1="${padding + 26}" x2="${width - padding}" y2="${padding + 26}" stroke="#1e293b" stroke-width="1"/>
${body}
</svg>
`;
}
