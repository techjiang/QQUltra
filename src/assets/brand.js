/**
 * 品牌与作者信息唯一来源。
 *
 * 集中在一处的原因：README、/about 指令、面板页脚、CLI banner 都要用同一份，
 * 散开写必然出现「某处还留着旧群号」这类问题。
 */
export const AUTHOR = {
  name: '科技酱',
  site: 'https://docs.asoe.cn',
  github: 'https://github.com/techjiang/',
  bilibili: 'https://space.bilibili.com/1768832152',
  forum: 'https://forums.asoe.cn/',
  qqGroups: ['291974598', '474819022'],
};

export const PROJECT = {
  name: 'QQUltra',
  slogan: '至尊QQ人工智能 · 群聊统计 · 自动化检测 · 群聊信息管理',
};

/** 群内可直接发出的作者名片（纯文本，群聊里不渲染 Markdown）。 */
export function renderAboutText(extra = {}) {
  const lines = [
    `🛰 ${PROJECT.name} — ${PROJECT.slogan}`,
    `作者：${AUTHOR.name}`,
    `网站：${AUTHOR.site}`,
    `GitHub：${AUTHOR.github}`,
    `哔哩哔哩：${AUTHOR.bilibili}`,
    `玲珑：${AUTHOR.forum}`,
    `QQ群：${AUTHOR.qqGroups[0]} / ${AUTHOR.qqGroups[1]}`,
  ];
  if (extra.version) lines.splice(1, 0, `版本：v${extra.version}`);
  return lines.join('\n');
}

/**
 * 终端 banner。用纯 ASCII，避免不同终端字体下汉字宽度错位。
 */
export const ASCII_LOGO = [
  '  ▄█████▄  ▄█████▄  ██   ██  ██    ██  ██      ████████  ██████   ▄█████▄ ',
  ' ██     ██ ██     ██ ██   ██  ██    ██  ██         ██    ██   ██ ██     ██',
  ' ██     ██ ██     ██ ██   ██  ██    ██  ██         ██    ██████  █████████',
  ' ██  ▄  ██ ██     ██ ██   ██  ██    ██  ██         ██    ██   ██ ██     ██',
  '  ▀███▀██   ▀█████▀   ▀████▀   ▀████▀   ████████   ██    ██   ██ ██     ██',
].join('\n');

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Logo 路径。文件是仓库自带的 PNG（无背景），随包分发而不是外链——
 * 外链会在协议端没有外网权限时静默失败，群里只看到一个破图。
 */
export function logoPath() {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'logo.png');
  return existsSync(file) ? file : null;
}
