const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const COLORS = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};

/**
 * 极简结构化日志。QQUltra 需要长时间挂在群里，日志必须能直接进 journald
 * 或按行 grep，因此固定单行输出并带 scope 前缀。
 */
export function createLogger({ level = 'info', scope = 'qqultra', sink = console } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;

  const emit = (lvl, args) => {
    if (LEVELS[lvl] < min) return;
    const line = args
      .map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return `${a.stack ?? a.message}${a.cause ? `\n  cause: ${a.cause.stack ?? a.cause.message}` : ''}`;
        return JSON.stringify(a);
      })
      .join(' ');
    const ts = new Date().toISOString();
    const color = COLORS[lvl] ?? '';
    const reset = color ? '\u001b[0m' : '';
    sink[lvl === 'debug' ? 'log' : lvl](`${color}[${ts}] ${lvl.toUpperCase()} (${scope})${reset} ${line}`);
  };

  return {
    level,
    child: (sub) => createLogger({ level, scope: `${scope}:${sub}`, sink }),
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
  };
}
