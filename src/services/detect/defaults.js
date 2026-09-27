/**
 * 检测默认配置的唯一来源。
 *
 * 单独成文件是为了打断 engine ↔ group-config 的循环依赖：
 * 群配置默认值要复用这份，引擎也要复用这份。
 */
export const DEFAULT_DETECT_CONFIG = {
  enabled: true,
  windowMs: 10_000,
  flood: { maxMessages: 8, windowMs: 10_000, action: 'mute' },
  repeat: { maxTimes: 4, action: 'warn' },
  link: { maxLinks: 3, whitelist: [], action: 'warn' },
  longText: { maxLength: 1000, action: 'warn' },
  newbie: { windowHours: 24 },
  punish: {
    enabled: true,
    muteSeconds: 600,
    escalate: true,
    /**
     * 各类违规的升级上限：累积多次后可加重到的最重动作。
     *
     * 显式列出而不是「一律升到踢出」，是因为不设上限时每类违规都能被顶到最重：
     * 复读的默认动作是 warn，且它没有自己的 action 配置项，
     * 运营根本无从察觉「复读几次也会被踢」。
     *
     * 规则：上限必须不低于该类违规自身的默认动作，
     * 未列出的类型视为「不加重」（上限 = 自身动作）。
     */
    escalateCeil: {
      flood: 'kick',
      ad: 'kick',
      repeat: 'mute',
      link: 'warn',
      long_text: 'warn',
      newbie_shill: 'kick',
    },
    /**
     * 同一用户在此时长内连续触发的违规算作同一次事件。
     * 一次刷屏会连续命中多条消息，没有这个窗口会被算成几十次违规，
     * 处罚瞬间从禁言跳到踢出。
     */
    incidentWindowMs: 60_000,
    // 白名单：管理员与被信任成员永不被自动处罚
    trustedRoles: ['owner', 'admin'],
  },
};
