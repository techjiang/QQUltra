/**
 * 管理面板：把「机器人能做什么」变成一条条可点开的指令清单。
 *
 * 为什么不做 WebUI：Issue 要求「在 PC 端 QQ APP 内直接使用、管理」。
 * PC 端 QQ 打开的是聊天窗口，WebUI 要在浏览器里再登一次，路径更长；
 * 而群里的面板消息本身就是 QQ 原生的交互面，管理员看到即用、零迁移成本。
 *
 * 面板不引入任何状态：它只是指令的分类投影，
 * 因此新增指令只要在 PANEL_SECTIONS 里登记一行就会出现在面板中，
 * 不存在「面板和实际能力对不上」的问题。
 */

export const PANEL_SECTIONS = [
  {
    key: 'insight',
    title: '📊 洞察',
    items: [
      { cmd: '/stats [today|week|month|all]', desc: '统计报告与环比' },
      { cmd: '/rank [周期]', desc: '活跃榜' },
      { cmd: '/wordcloud [周期]', desc: '生成词云图' },
      { cmd: '/me', desc: '我的发言档案' },
      { cmd: '/whois @某人', desc: '查看成员档案' },
      { cmd: '/history [@某人]', desc: '最近发言回顾' },
    ],
  },
  {
    key: 'guard',
    title: '🛡 风控',
    items: [
      { cmd: '/alert', desc: '异常预警开关与阈值' },
      { cmd: '/rules', desc: '查看检测规则' },
      { cmd: '/violations', desc: '最近违规记录' },
      { cmd: '/rule add <类型> <内容>', desc: '新增规则（管理员）' },
    ],
  },
  {
    key: 'ops',
    title: '⚙️ 运维',
    items: [
      { cmd: '/status', desc: '运行状态与自检' },
      { cmd: '/config', desc: '查看本群配置' },
      { cmd: '/config set <键> <值>', desc: '修改配置（管理员）' },
      { cmd: '/subscribe', desc: '订阅每日简报（管理员）' },
      { cmd: '/approve <flag>', desc: '入群审核（管理员）' },
      { cmd: '/purge <天数>', desc: '清理历史（群主）' },
    ],
  },
  {
    key: 'ai',
    title: '🤖 AI',
    items: [
      { cmd: '/ai <问题>', desc: '提问（群里需 @ 机器人）' },
      { cmd: '/ai-stats [周期]', desc: '让 AI 解读数据' },
      { cmd: '/ai-reset', desc: '清空会话记忆' },
    ],
  },
  {
    key: 'meta',
    title: '🧭 面板',
    items: [
      { cmd: '/panel --img', desc: '面板换成图文卡片' },
      { cmd: '/help', desc: '完整指令说明' },
      { cmd: '/about', desc: '作者与项目信息' },
      { cmd: '/ping', desc: '存活检查' },
    ],
  },
];

export const PANEL_FOOTER = '直接回复上面任意指令即可执行 · 管理员项需群主/管理员或白名单身份';

/**
 * 渲染面板。按权限过滤：普通成员看不到管理项，
 * 否则面板会变成「教普通成员怎么找管理员权限漏洞」的说明书。
 */
export function renderPanel({ role = 'member', whiteListed = false, groupName = null } = {}) {
  const isAdmin = whiteListed || role === 'owner' || role === 'admin';
  const lines = [`🧭 QQUltra 管理面板${groupName ? ` · ${groupName}` : ''}`];
  for (const section of PANEL_SECTIONS) {
    lines.push('');
    lines.push(section.title);
    for (const item of section.items) {
      const adminOnly = /（管理员）|（群主）/.test(item.desc);
      if (adminOnly && !isAdmin) continue;
      // /subscribe 与 /unsubscribe 共用一个入口；面板只展示订阅侧，
      // 退订写在使用说明里，避免面板被成对的开关塞满
      if (item.cmd === '/unsubscribe') continue;
      lines.push(`${item.cmd} — ${item.desc}`);
    }
  }
  lines.push('');
  lines.push(PANEL_FOOTER);
  return lines.join('\n');
}

/**
 * 面板分区键 → 指令前缀集合，用于「面板里有哪些指令能直接在群里跑」的一致性自检。
 * 新增指令时若忘了登记面板，测试会失败。
 */
export function panelCommands() {
  return PANEL_SECTIONS.flatMap((s) => s.items.map((i) => i.cmd.split(/\s+/)[0]));
}
