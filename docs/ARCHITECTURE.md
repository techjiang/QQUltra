# 架构说明

## 分层

```
┌─────────────────────────────────────────┐
│ 适配器  onebot11(forward/reverse) / mock │  唯一与 QQ 协议端耦合处
└────────────────┬────────────────────────┘
                 │ 统一消息实体（normalizeMessage）
┌────────────────▼────────────────────────┐
│ 事件总线  message / notice / request     │  顺序派发，异常隔离
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│ Bot 主循环 采集 → 检测 → 处置 → 指令 → AI │  装配与副作用顺序
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│ 业务：统计 / 检测 / AI / 管理            │  纯逻辑，可脱离 QQ 单测
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│ 存储 SQLite（明细/汇总/规则/违规/会话）  │
└─────────────────────────────────────────┘
```

## 为什么这么分

### 适配器隔离协议细节

业务模块只认 `normalizeMessage` 产出的统一实体，不碰 `message_type`、`sender.card` 这类协议字段。
换协议端或加新协议（如 OneBot 12）只需新增一个适配器。

### 检测与处置分离

检测引擎只产出 `Finding`（命中了什么）与 `Decision`（打算怎么做），不执行任何网络动作：

```js
const { findings, decision } = engine.inspect(message);
const executed = await moderator.apply(message, decision);   // 真正的撤回/禁言/踢人
engine.commit(message, findings, decision, { executed });    // 留痕
```

好处有二：检测逻辑可以在没有 QQ 环境的情况下完整单测；强制动作集中在一处，不会有规则偷偷绕过审计。

### 命令走独立路径

命令消息不参与检测——否则管理员改配置时可能被自己的规则拦下。
命令也不计入活跃榜：它是对机器人下的操作，不是群成员之间的交流。

### 统计实时聚合，不做预聚合表

群消息量级（万到十万行）SQLite 实时聚合完全够用，而预聚合引入的口径不一致风险更大
（明细与汇总对不上时，很难判断哪个才是真相）。`messages` 是唯一事实来源，`group_members` 只是便捷汇总。

## 关键不变量

这些是踩过坑后固定下来的约定，改动时不要破坏：

1. **活跃口径统一排除指令**：`is_command = 0` 由 `ACTIVE_ONLY` 常量统一下发，
   保证活跃榜、活跃人数、时段分布三个视图口径一致。
2. **一次事件一次处置**：`incidentWindowMs`（默认 60s）内的连续命中折叠为一个事件。
   一次刷屏会连续命中多条消息，不折叠会让处罚一步顶到踢出。
3. **升级阶梯只升不降**：`escalateAction` 保证 `mute` 不会被降成 `warn`。
4. **事件窗口用右开区间**：`[since, until)` 让相邻周期不重复计数；
   查询「当前时刻」时上界要 +1，否则刚入库的消息会被漏掉。
5. **检测默认值单一来源**：`detect/defaults.js` 是唯一出处，
   群配置与引擎都从这里取，避免两边各写一份导致默认值被挤掉。
6. **失败降级不崩溃**：订阅者异常被事件总线隔离；处置失败降级为提醒并标记 `degraded`。

## 数据模型

| 表 | 作用 | 说明 |
| --- | --- | --- |
| `messages` | 消息明细 | 唯一事实来源，含指令；按 `(group_id, created_at)` 索引 |
| `group_members` | 成员汇总 | 累计发言数、首末次发言；只统计非指令消息 |
| `groups` | 群与配置 | `settings` 存 JSON，读时与默认值深合并 |
| `rules` | 自定义规则 | `group_id` 为空表示全局规则 |
| `violations` | 违规记录 | `kind='punish'` 的行是升级阶梯的计数依据 |
| `ai_conversations` | 会话记忆 | 写入时按 `maxKeep` 裁剪 |
| `kv` | 杂项 | 运行状态等 |

迁移按 `MIGRATIONS` 数组顺序执行，已执行的版本记录在 `schema_migrations`。
**已发布的迁移不再修改，只追加新版本。**

## 扩展点

### 加一个检测器

```js
// src/services/detect/rules.js
export function myDetector({ message, text, rules, config, context }) {
  if (!config.myRule?.enabled) return null;
  return text.includes('坏东西')
    ? { kind: 'my_rule', detail: '命中坏东西', action: 'warn' }
    : null;
}
```

入参契约固定为 `{ message, text, rules, config, context }`，返回 `Finding`、`Finding[]` 或 `null`。
`config` 在顶层（通用配置），`context` 放跨检测器协作信息（如 `adFinding` 供新人检测复用）。
检测器顺序有意义，注册到 `BUILTIN_DETECTORS` 时注意依赖关系。

### 换 AI 服务

`createOpenAICompatibleProvider` 覆盖所有 OpenAI 兼容端点。
若上游协议不同，实现一个带 `chat(messages, opts) => { content }` 的对象，
通过 `createBot({ aiProvider })` 注入即可。

### 接新协议

继承 `Adapter`，实现 `_connect` / `_send` / `_disconnect`，
把平台事件翻译成 `normalizeMessage` 后调用 `emitMessage`。
不要动业务模块。
