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
  for (const token of rest) {
    const flag = /^--([a-zA-Z][\w-]*)(?:=(.*))?$/.exec(token);
    if (flag) {
      args.flags[flag[1]] = flag[2] ?? true;
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
    /** 权限判定：owner > admin > member；whiteList 为 userId 列表。 */
    canRun: (spec, message, { whiteList = [] } = {}) => {
      const level = spec.level ?? 'member';
      if (level === 'member') return true;
      if (whiteList.includes(String(message.userId))) return true;
      if (level === 'admin') return message.role === 'owner' || message.role === 'admin';
      return message.role === 'owner';
    },
  };
}
