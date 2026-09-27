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

/**
 * 免责声明：所有渠道共用同一份文案，理由与 AUTHOR 相同。
 *
 * 放在 brand 模块而非散落在 README / 指令 / 面板里，是为了保证
 * 「群里看到的」和「文档里写的」永远是同一条，不会各自漏掉一句。
 */
export const DISCLAIMER = {
  /** 版本号：法律文本改一次就该升一次，便于回溯用户当时同意的是哪一版 */
  version: '1.0',
  /** 群内 /about 用的短版（纯文本，QQ 不渲染 Markdown，需控制行数） */
  short: [
    '⚠️ 免责声明（使用本机器人即表示已知悉并同意）',
    '1. 本软件按「现状」提供，不附带任何明示或默示担保',
    '2. 使用风险与后果由使用者自行承担，作者不承担任何责任',
    '3. 因违规使用（外挂、盗号、骚扰、违法内容等）产生的后果由使用者自负',
    '4. 数据仅存本地自建库，作者不收集、不上传、不接触你的聊天数据',
    '5. 与腾讯及 QQ 官方无任何关联，相关商标归其各自所有者',
    '6. 作者保留随时修改或停止更新本软件的权利',
    '完整条款见仓库 DISCLAIMER.md（群内发 /disclaimer full 亦可查看）',
  ],
  /** 文档 / CLI 用的长版章节 */
  sections: [
    {
      title: '一、软件性质',
      items: [
        '本软件（QQUltra，下称「本软件」）为开源的个人技术学习与研究项目，免费提供，不构成任何形式的商品或服务承诺。',
        '本软件并非腾讯或 QQ 官方产品，与腾讯公司及其关联方无任何隶属、代理、赞助或背书关系；QQ、腾讯等商标归其各自所有者。',
      ],
    },
    {
      title: '二、按现状提供',
      items: [
        '本软件按「现状」（AS IS）与「现有」（AS AVAILABLE）提供，不作任何明示或默示的担保，包括但不限于适销性、特定用途适用性、不中断、无错误、无病毒或不侵权的担保。',
        '作者不保证本软件的功能满足你的需求，也不保证其运行不中断、不出错，更不保证任何统计结果、检测结论或 AI 生成内容的准确性、完整性与时效性。',
      ],
    },
    {
      title: '三、责任限制',
      items: [
        '你理解并同意：在适用法律允许的最大范围内，作者、贡献者及分发者不对任何直接、间接、偶然、特殊、惩罚性或后果性损失承担责任，包括但不限于数据丢失、账号被限制或封禁、群聊或好友关系受损、业务中断、利润或商誉损失。',
        '上述限制不因本软件是否被告知可能发生该类损失而改变；即使本软件存在缺陷或被证明不可用，本条款依然有效。',
      ],
    },
    {
      title: '四、使用者责任',
      items: [
        '你是否使用本软件、如何配置与部署，完全由你自己决定并自行承担风险；因使用或无法使用本软件产生的一切后果由你自负。',
        '用于他人所在的群时，你应事先取得群主与群成员的必要授权，并自行确保统计、检测与自动处置行为符合当地法律法规、平台规则与群规。',
        '你不得将本软件用于外挂、盗号、爬取他人隐私、骚扰、刷量、传播违法或侵权内容等用途；因此产生的任何后果由使用者承担，与作者无关。',
      ],
    },
    {
      title: '五、数据与隐私',
      items: [
        '本软件默认把群号、QQ 号、昵称与消息文本存入你自己部署环境下的本地 SQLite 文件，作者不收集、不上传、不存储、也不接触这些数据。',
        '数据是否会离开你的运行环境，取决于你自己配置的 AI 服务、协议端等第三方组件；请自行阅读并遵守其条款与隐私政策，相关风险与责任由你承担。',
        '请自行做好数据备份、访问控制与保留期限管理（可用 `stats.enabled: false` 关闭统计、`/purge` 清理历史）。因未备份或误清理导致的数据丢失，作者不承担责任。',
      ],
    },
    {
      title: '六、禁止用途',
      items: [
        '禁止将本软件用于任何违反中华人民共和国法律法规及你所在司法辖区法律的用途。',
        '禁止将本软件用于各类违反平台规则的作弊、外挂或破坏性程序，禁止将其作为唯一的风控或处罚依据。',
      ],
    },
    {
      title: '七、条款变更',
      items: [
        '作者可在不另行通知的情况下修改本声明、变更功能或停止维护；更新后的条款随仓库发布，继续使用即视为接受新版本。',
        '本声明是 MIT License 的补充说明，前者的免责条款与后者如有冲突，以更有利于作者免责的表述为准。',
      ],
    },
  ],
};

/** 渲染群内 / CLI 可见的完整免责声明文本。 */
export function renderDisclaimerText({ version } = {}) {
  const head = version
    ? `⚠️ ${PROJECT.name} 免责声明（v${DISCLAIMER.version} · 软件 v${version}）`
    : `⚠️ ${PROJECT.name} 免责声明（v${DISCLAIMER.version}）`;
  const lines = [head];
  for (const s of DISCLAIMER.sections) {
    lines.push('', s.title);
    for (const item of s.items) lines.push(`· ${item}`);
  }
  lines.push('', '使用本软件即表示你已阅读、理解并同意上述全部条款。');
  return lines.join('\n');
}
