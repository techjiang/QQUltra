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
 * @returns {{ word:string, count:number, x:number, y:number, size:number, color:string }[]}
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
  const boxes = [];
  const placed = [];

  for (const [i, item] of words.entries()) {
    const size = scale(item.count);
    // padding 是视觉留白，不参与碰撞判定时的「可利用面积」，因此只加一点
    const w = estimateTextWidth(item.word, size) + 6;
    // CJK 的 em 盒高度接近字号，行盒按 1.15 倍留出上下呼吸位
    const h = size * 1.15;
    let x = cx;
    let y = cy;

    for (let step = 0; step < 2000; step += 1) {
      // 螺旋半径按平方根增长（面积均匀），再对 x 做 1.6 倍拉伸贴合 16:10 画布，
      // 否则词会全挤在中心的一小块圆形区域里，四周大片留白。
      const radius = 5.2 * Math.sqrt(step);
      const angle = step * GOLDEN_ANGLE;
      x = cx + radius * Math.cos(angle) * 1.6;
      y = cy + radius * Math.sin(angle);
      const box = { x: x - w / 2, y: y - h / 2, w, h };
      const inside = box.x >= 6 && box.y >= 44 && box.x + box.w <= width - 6 && box.y + box.h <= height - 22;
      if (inside && !boxes.some((b) => overlaps(b, box))) {
        boxes.push(box);
        break;
      }
    }

    placed.push({
      word: item.word,
      count: item.count,
      x: Number(x.toFixed(1)),
      y: Number(y.toFixed(1)),
      size,
      color: PALETTE[i % PALETTE.length],
    });
  }
  return placed;
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function renderWordCloudSvg(words, { width = 640, height = 400, title = '群聊词云' } = {}) {
  const placed = layoutWords(words, { width, height });
  const body = placed
    .map(
      (p) =>
        `  <text x="${p.x}" y="${p.y}" font-size="${p.size}" fill="${p.color}" text-anchor="middle" dominant-baseline="middle" font-family="'PingFang SC','Microsoft YaHei',sans-serif" font-weight="600">${escapeXml(p.word)}</text>`,
    )
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" rx="16" fill="#0b1220"/>
  <text x="24" y="36" font-size="18" fill="#7dd3fc" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${escapeXml(title)}</text>
  <line x1="24" y1="46" x2="${width - 24}" y2="46" stroke="#1e293b" stroke-width="1"/>
${body}
  <text x="${width - 16}" y="${height - 14}" font-size="11" fill="#475569" text-anchor="end" font-family="sans-serif">QQUltra</text>
</svg>
`;
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
