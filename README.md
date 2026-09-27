# QQUltra

至尊 QQ 人工智能 · 群聊统计 · 自动化检测 · 群聊信息管理。

QQUltra 是一个常驻 QQ 群的机器人，把四件事做在一个进程里：

- **AI 对话** —— 群内 @ 或私聊触发，带多轮记忆，可被指令切换为前缀触发
- **群聊统计** —— 活跃榜、发言档案、活跃时段分布、环比涨跌
- **自动化检测** —— 刷屏、复读、广告引流、敏感词、灌链接，命中即处置
- **群聊管理** —— 入群审核、新人欢迎、规则增删、按群独立配置

## 快速开始

```bash
git clone <repo> && cd QQUltra
node bin/qqultra.js demo        # 离线跑一遍完整链路，不需要 QQ 环境
```

`demo` 用内存库 + 模拟适配器，会把「统计采集 → 广告检测 → 刷屏处置 → 指令查询」整条链路走一遍并打印结果，
用来验证环境是否就绪。

## 接入真实 QQ

QQUltra 通过 **OneBot 11** 协议与协议端通信，兼容 go-cqhttp、Lagrange、NapCat、LLOneBot 等。

**1. 准备协议端**，登录机器人 QQ 号，开启 OneBot 11 的 WebSocket。

**2. 配置 QQUltra**：

```bash
cp qqultra.config.example.json qqultra.config.json
# 至少改 onebot.wsUrl 与 onebot.accessToken
```

**3. 启动**：

```bash
node bin/qqultra.js start
```

### 两种连接方向

| 场景 | `onebot.mode` | 说明 |
| --- | --- | --- |
| 协议端与 QQUltra 在同一台机器 | `forward`（默认） | QQUltra 主动连协议端的正向 WebSocket |
| 机器人没有公网入口 | `reverse` | QQUltra 监听端口，等协议端反连 |

反向模式示例：

```json
{ "onebot": { "mode": "reverse", "listenHost": "0.0.0.0", "listenPort": 8642, "accessToken": "你的令牌" } }
```

### 环境变量覆盖

所有配置都能用环境变量覆盖，优先级高于配置文件。层级用 `__` 分隔：

```bash
QQU_ONEBOT__WSURL=ws://127.0.0.1:3001 \
QQU_ONEBOT__ACCESSTOKEN=你的令牌 \
QQU_AI__ENABLED=true \
QQU_AI__APIKEY=sk-xxx \
node bin/qqultra.js start
```

## 指令

群里发送，或私聊机器人。需要管理员权限的指令会校验发送者角色。

| 指令 | 权限 | 说明 |
| --- | --- | --- |
| `/help` | 所有人 | 指令一览 |
| `/stats [today\|week\|month\|all]` | 所有人 | 统计报告，可加 `--top=N` |
| `/rank [周期]` | 所有人 | 活跃榜 |
| `/me` | 所有人 | 我的发言档案 |
| `/whois @某人` | 所有人 | 查他人档案 |
| `/ai <问题>` | 所有人 | 问 AI |
| `/ai-stats [周期]` | 所有人 | 让 AI 解读统计数据 |
| `/ai-reset` | 所有人 | 清空本会话记忆 |
| `/rules` | 所有人 | 查看生效规则 |
| `/ping` | 所有人 | 存活检查 |
| `/config` / `/config keys` | 管理员 | 查看配置 / 可配置项 |
| `/config set <键> <值>` | 管理员 | 修改本群配置 |
| `/rule add\|del\|on\|off` | 管理员 | 维护检测规则 |
| `/approve <flag>` / `/reject <flag>` | 管理员 | 入群申请审核 |
| `/purge <天数>` | 群主 | 清理历史明细 |

## AI 接入

AI 走 **OpenAI 兼容协议**（`/chat/completions`），因此 DeepSeek、通义、自建 vLLM 都可直接用：

```json
{
  "ai": {
    "enabled": true,
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-xxx",
    "model": "deepseek-chat",
    "systemPrompt": "你是本群的助手，说话简短口语化"
  }
}
```

群内触发方式由 `ai.trigger` 控制：`mention`（默认，@ 才回）、`prefix`（`/ai` 开头）、`all`（所有消息）。

`/ai-stats` 会把真实统计数字注入提示词并要求模型以此为准，避免模型编造群活跃数据。

## 自动化检测

内置规则开箱可用，全部可在群维度调阈值或关闭：

| 类型 | 判定 | 默认动作 |
| --- | --- | --- |
| `flood` 刷屏 | 10 秒内超过 8 条 | 禁言 |
| `repeat` 复读 | 连续 4 次相同内容 | 警告 |
| `ad` 引流广告 | 联系方式 + 引流动词同时出现 | 禁言 |
| `newbie_shill` 新人广告 | 入群 24h 内发广告 | 踢出 |
| `link` 灌链接 | 单条超过 3 个未授信链接 | 警告 |
| `long_text` 超长文本 | 单条超过 1000 字 | 警告 |
| `keyword` / `regex` | 自定义词/正则 | 可配 |

设计上的几个取舍：

- **反绕过**：所有匹配跑在归一化文本上，全角、零宽字符、插分隔符的写法（`加 微-信`）都会被击穿
- **广告用组合信号**：单看联系方式会误伤正常交流，因此要求「联系方式 + 引流动词」同时命中
- **一次事件一次处置**：一次刷屏会连续命中多条消息，QQUltra 把它折叠成一个事件，不会瞬间把处罚顶到踢出
- **只升不降的阶梯**：`warn → mute → kick`，管理员白名单内只记录不处置
- **失败降级**：机器人不是管理员时，处置失败会降级成群内提醒，不中断主循环

加自定义规则：

```
/rule add keyword 违禁词 --action=mute
/rule add regex /广告\s*位/ --action=warn
```

## 群内配置

每个群可独立配置，互不影响：

```
/config set ai.trigger prefix       # 改用前缀触发
/config set ai.enabled false        # 关掉本群 AI
/config set detect.punish.enabled false   # 只检测不处罚
/config set welcome.enabled true
/config set welcome.text 欢迎 {at} 进群～
/config set stats.enabled false      # 本群不统计
```

## 运维

```bash
node bin/qqultra.js inspect        # 查看生效配置（密钥脱敏）
node bin/qqultra.js report 123456  # 直接输出某群统计
node bin/qqultra.js purge 30       # 清理 30 天前明细
node bin/qqultra.js start          # 启动机器人
```

数据存在单个 SQLite 文件（默认 `data/qqultra.db`），按 `stats.retentionDays` 自动清理过期明细。

- 备份：直接复制 `.db` 文件（连同 `-wal`、`-shm`），或用 `sqlite3 qqultra.db ".backup ..."`
- 查历史：`sqlite3 data/qqultra.db "SELECT * FROM violations ORDER BY created_at DESC LIMIT 20"`

## 架构

```
适配器层  onebot11 / mock         ← 唯一与 QQ 协议端耦合的地方
   ↓ 统一消息实体
事件总线  顺序派发，单订阅者异常不影响其他订阅者
   ↓
业务模块  统计采集 / 检测引擎 / AI 会话 / 群管理
   ↓
存储层    SQLite：明细表 + 成员汇总 + 规则 + 违规 + 会话
```

关键设计：**检测引擎只输出「打算做什么」，不直接执行动作**。执行统一由 `moderator` 通过适配器完成，
因此检测逻辑可以脱离 QQ 环境单测，网络调用也不会散落在规则里。

```
src/
├── core/         事件总线、适配器契约、Bot 主循环
├── adapters/     onebot11（正向/反向）、mock（离线用）
├── services/
│   ├── stats/    采集器、报表生成
│   ├── detect/   规则、默认配置、检测引擎
│   ├── ai/       会话管理、OpenAI 兼容 provider
│   └── manage/   指令、群配置、处置执行
├── storage/      数据库、迁移、仓储
└── utils/        日志、文本归一化、时间
```

## 开发

```bash
node --test "test/*.test.js"   # 141 个用例
npm run demo                   # 离线端到端演示
```

零运行时依赖：数据库用 Node 内置 `node:sqlite`，HTTP/WebSocket 用内置 `fetch`/`WebSocket`。
要求 Node ≥ 22.5（`node:sqlite` 的引入版本）。

测试覆盖的三个层次：

- **单元**：文本归一化、时间计算、命令解析、各检测器
- **模块**：存储事务、统计口径、检测引擎决策、AI 提示词
- **端到端**：一条消息从注入到被统计、检测、处置、留痕的完整链路

## 隐私边界

- 只存群号、QQ 号、昵称与消息文本，不采集 IP 或客户端信息
- 机器人自身消息不入库
- 数据只落本地 SQLite，不外传；AI 回复时仅发送当前会话上下文与提问
- 可用 `stats.enabled: false` 关闭统计，或 `/purge` 清理历史

## License

MIT
