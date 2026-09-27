/**
 * 命令层：把「文本 → 命令」与「命令 → 执行」拆开。
 * 解析是纯函数（可单测），执行才碰存储与适配器。
 */
export const COMMAND_PREFIX = '/';

export function parseCommand(text, { prefix = COMMAND_PREFIX } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw.startsWith(prefix)) return null;

  const body = raw.slice(prefix.length).trim();
  if (!body) return null;

  const parts = body.split(/\s+/);
  const name = parts[0].toLowerCase();
  const rest = parts.slice(1);

  const args = { positional: [], flags: {} };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    const flag = /^--([a-zA-Z][\w-]*)(?:=(.*))?$/.exec(token);
    if (flag) {
      if (flag[2] !== undefined) {
        args.flags[flag[1]] = flag[2];
      } else {
        // 支持 `--n 2` 这种空格分隔写法：下一个 token 若不是新的旗标，
        // 就当作本旗标的值。曾经只认 `--n=2`，空格写法会得到 `true`，
        // 而 Number(true) === 1，于是 /violations --n 2 只显示 1 条、
        // /rank --top 5 变成 top=1，且不报任何错。
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          args.flags[flag[1]] = next;
          i += 1;
        } else {
          args.flags[flag[1]] = true;
        }
      }
      continue;
    }
    const at = /^\[CQ:at,qq=(\d+)\]$/.exec(token);
    if (at) {
      args.positional.push(at[1]);
      continue;
    }
    args.positional.push(token);
  }

  return { name, args, raw: body };
}

/** 从消息段里找 @ 目标，命令里带 @ 时用它拿 userId。 */
/** 命令可用的旗标白名单：出现未知旗标说明用户打错了，必须报错而不是当参数吞掉。 */
export const KNOWN_FLAGS = {
  stats: ['top', 'period'],
  rank: ['top', 'period'],
  wordcloud: ['top', 'period', 'img'],
  history: ['n'],
  violations: ['n'],
  panel: ['img'],
  purge: ['dry'],
};

export function extractMentions(segments = []) {
  return segments.filter((s) => s?.type === 'at' && s.data?.qq && s.data.qq !== 'all').map((s) => String(s.data.qq));
}

export function createCommandRegistry() {
  const commands = new Map();

  const register = (name, spec) => {
    if (commands.has(name)) throw new Error(`命令重复注册: ${name}`);
    commands.set(name, { name, ...spec });
    for (const alias of spec.aliases ?? []) commands.set(alias, { name, ...spec, isAlias: true });
    return spec;
  };

  return {
    register,
    get: (name) => commands.get(name),
    list: () => [...new Set([...commands.values()].map((c) => c.name))],
    /**
     * 权限判定：owner > admin > member；whiteList 为 userId 列表。
     *
     * 私聊没有群角色，因此只有显式列入 whiteList 的账号才能私聊执行管理指令。
     * 少了这条，任何人都能私聊机器人触发 /purge、/config set 这类破坏性操作。
     */
    canRun: (spec, message, { whiteList = [] } = {}) => {
      const level = spec.level ?? 'member';
      if (level === 'member') return true;
      if (whiteList.map(String).includes(String(message.userId))) return true;
      if (!message.isGroup) return false;
      if (level === 'admin') return message.role === 'owner' || message.role === 'admin';
      return message.role === 'owner';
    },

    /**
     * 按名称或别名解析命令。别名只映射到主命令名，
     * 不重复注册，否则同一命令会在 /help 里出现两次。
     */
    resolve(name) {
      const key = String(name ?? '').toLowerCase();
      const direct = commands.get(key);
      if (direct) return direct;
      const target = ALIASES[key];
      return target ? commands.get(target) : undefined;
    },
  };
}

/** 中文/简写别名表：键是用户输入，值主命令名。 */
export const ALIASES = {
  帮助: 'help',
  菜单: 'help',
  统计: 'stats',
  活跃榜: 'rank',
  排行: 'rank',
  我的: 'me',
  规则: 'rules',
  群规: 'rules',
  违规: 'violations',
  记录: 'violations',
  历史: 'history',
  词云: 'wordcloud',
  预警: 'alert',
  订阅: 'subscribe',
  退订: 'unsubscribe',
  ai统计: 'ai-stats',
  ai记忆: 'ai-reset',
  状态: 'status',
  面板: 'panel',
};
