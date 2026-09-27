<div align="center">

<img src="src/assets/logo.png" alt="QQUltra" width="180" />

# QQUltra

**至尊 QQ 人工智能 · 群聊统计 · 自动化检测 · 群聊信息管理**

<img src="https://img.shields.io/badge/Node-%E2%89%A522.5-339933?logo=node.js&logoColor=white" alt="node" />
<img src="https://img.shields.io/badge/dependencies-0-blue" alt="zero deps" />
<img src="https://img.shields.io/badge/tests-270%20passing-brightgreen" alt="tests" />
<img src="https://img.shields.io/badge/license-MIT-green" alt="license" />

[作者网站](https://docs.asoe.cn) · [论坛](https://forums.asoe.cn/) · [B 站](https://space.bilibili.com/1768832152) · [GitHub](https://github.com/techjiang/)

</div>

---

QQUltra 是一个常驻 QQ 群的机器人：**在 PC 端 QQ 的聊天窗口里直接使用和管理**，
不用切浏览器、不用开端口、不用再登一次。四件事做在一个零依赖进程里：

| 能力 | 一句话说明 | 主要入口 |
| --- | --- | --- |
| 🤖 **AI 对话** | 群内 @ 或私聊触发，多轮记忆，OpenAI 兼容协议 | `/ai`、`/ai-stats` |
| 📊 **群聊统计** | 活跃榜、发言档案、时段分布、环比、词云 | `/stats`、`/rank`、`/me` |
| 🛡 **自动化检测** | 刷屏、复读、广告引流、敏感词、灌链接，命中即处置 | `/rules`、`/violations` |
| ⚙️ **群聊管理** | 入群审核、新人欢迎、规则增删、按群独立配置、预警与简报 | `/config`、`/alert` |
| 🧠 **运营洞察** | 谁不说话了、话题在变热还是变冷、有没有规则在空转 | `/vibe`、`/silent`、`/trend` |

## 目录

- [60 秒上手](#60-秒上手)
- [为什么在 PC 端 QQ 里用](#为什么在-pc-端-qq-里用)
- [接入真实 QQ](#接入真实-qq)
- [指令速查](#指令速查)
- [四大能力详解](#四大能力详解)
- [运维与数据](#运维与数据)
- [文档导航](#文档导航)
- [常见问题](#常见问题)
- [项目状态](#项目状态)

## 60 秒上手

不需要 QQ 环境、不需要协议端、不需要配置文件：

```bash
git clone https://cnb.cool/asoe/TechSauce/QQUltra.git && cd QQUltra
node bin/qqultra.js demo
```

`demo` 用内存库 + 模拟适配器，把完整链路走一遍并打印结果：

```
注入 6 条聊天消息        → 统计采集
/stats --period=all     → 统计报告
"加我微信 abc12345…"     → 广告引流命中 → 禁言
连发 9 条               → 刷屏命中 → 折叠为 1 次事件
/me                     → 成员档案
最终统计快照            → 机器人自身消息与指令不计入活跃榜
```

先看效果再决定要不要接 QQ，是最省的验证顺序。

## 为什么在 PC 端 QQ 里用

PC 端 QQ 打开的就是聊天窗口，QQUltra 把「管理台」直接做成群内消息：

| 方式 | 入口 | 说明 |
| --- | --- | --- |
| `/panel` | 群里或私聊机器人 | 一屏列出所有可用指令，**按权限过滤**，看到即用、复制即执行 |
| `/panel --img` | 同上 | 面板渲染成图文卡片，长清单不被客户端折叠 |
| 私聊机器人 | PC 端 QQ 好友列表 | 直接对话式操作，不用进群 |
| `/status` | 群里 | 运行自检，掉线、检测被关、权限缺失都会点出来 |

几个刻意的决定：

- **不做 WebUI**。管理需求已经有一个天然宿主（聊天窗口），再维护一个前端等于多一份要同步的状态、多一个端口和一次登录。
- **面板不引入新状态**。它只是指令的分类投影，所以不存在「面板显示的能力和实际能力对不上」；有测试强制校验面板里每条指令都真实存在。
- **私聊没有群角色**。所以私聊执行管理指令只认 `permission.whiteList`——否则任何人都能私聊触发 `/purge` 清库。

## 接入真实 QQ

QQUltra 不实现 QQ 协议本身，只做 **OneBot 11** 客户端，兼容 NapCat、Lagrange、LLOneBot、go-cqhttp 等协议端。

**1. 准备协议端**（以 NapCat 为例，可直接装进 PC 端 QQ），登录机器人账号并开启 OneBot 11 的 WebSocket 服务端。

**2. 配置 QQUltra**：

```bash
cp qqultra.config.example.json qqultra.config.json
# 至少改 onebot.wsUrl 与 onebot.accessToken
```

**3. 启动**：

```bash
node bin/qqultra.js start
```

看到 `已就绪，机器人 QQ: xxx` 即接入成功，接着在群里发 `/ping` 应回 `pong`。

### 两种连接方向

| 场景 | `onebot.mode` | 说明 |
| --- | --- | --- |
| 协议端与 QQUltra 在同一台机器 | `forward`（默认） | QQUltra 主动连协议端的正向 WebSocket |
| 机器人没有公网入口 / 想让协议端反连 | `reverse` | QQUltra 监听端口，等协议端连进来 |

反向模式示例：

```json
{ "onebot": { "mode": "reverse", "listenHost": "0.0.0.0", "listenPort": 8642, "accessToken": "你的令牌" } }
```

配置全部支持环境变量覆盖（优先级高于配置文件），层级用 `__` 分隔：

```bash
QQU_ONEBOT__WSURL=ws://127.0.0.1:3001 \
QQU_ONEBOT__ACCESSTOKEN=你的令牌 \
QQU_AI__ENABLED=true \
QQU_AI__APIKEY=sk-xxx \
node bin/qqultra.js start
```

> 部署到 systemd / Docker，以及上线检查清单，见 **[docs/DEPLOY.md](docs/DEPLOY.md)**。

## 指令速查

群里发送，或私聊机器人。完整参数与场景配方见 **[docs/USAGE.md](docs/USAGE.md)**。

<details>
<summary><b>📊 洞察</b>（所有人）</summary>

| 指令 | 说明 |
| --- | --- |
| `/stats [today\|week\|month\|all] [--top=N]` | 统计报告与环比，支持 `/stats 本周` |
| `/rank [周期]` | 活跃榜 |
| `/wordcloud [周期]` | 词云图卡（渲染失败自动退回文本） |
| `/trend [天数]` | 话题趋势：近 N 天 vs 前 N 天 |
| `/vibe` | 活跃总览、活跃占比与一句判断 |
| `/silent [天数]` | 沉默成员：谁不说话了 |
| `/newcomers [天数]` | 新成员观察：潜水新成员 vs 正常新人 |
| `/me` | 我的发言档案 |
| `/whois @某人` | 查他人档案 |
| `/history [@某人] [--n=5]` | 最近发言回顾 |

</details>

<details>
<summary><b>🛡 风控</b></summary>

| 指令 | 权限 | 说明 |
| --- | --- | --- |
| `/rules` | 所有人 | 查看生效的自定义规则 |
| `/rules audit` | 所有人 | 规则命中效果评估，挑出空转的规则 |
| `/violations [--n=10]` | 管理员 | 最近违规记录（按事件聚合） |
| `/alert [on\|off\|threshold N]` | 管理员 | 异常预警开关与阈值 |
| `/rule add\|del\|on\|off` | 管理员 | 维护自定义规则 |

</details>

<details>
<summary><b>⚙️ 运维</b></summary>

| 指令 | 权限 | 说明 |
| --- | --- | --- |
| `/status` | 所有人 | 运行状态与健康自检 |
| `/config` / `/config keys` | 管理员 | 查看生效配置 / 可配置项 |
| `/config set <键> <值>` | 管理员 | 修改本群配置 |
| `/subscribe` / `/unsubscribe` | 管理员 | 每日简报订阅 |
| `/approve <flag>` / `/reject <flag>` | 管理员 | 入群申请审核 |
| `/purge <天数>` | 群主 | 清理历史明细 |

</details>

<details>
<summary><b>🤖 AI</b> 与 <b>🧭 面板</b></summary>

| 指令 | 说明 |
| --- | --- |
| `/ai <问题>` | 提问（群里需 @ 机器人，私聊直接发） |
| `/ai-stats [周期] [问题]` | 让 AI 基于真实统计数字解读 |
| `/ai-reset` | 清空本会话记忆 |
| `/panel [--img]` | 管理面板（`--img` 出图卡） |
| `/help` | 指令一览（支持中文别名，如 `/菜单`、`/统计`） |
| `/about` | 作者与项目信息 |
| `/ping` | 存活检查 |

</details>

## 四大能力详解

### 🤖 AI 对话

只实现 **OpenAI 兼容协议**（`/chat/completions`），因此 DeepSeek、通义、自建 vLLM 都能直接接：

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

- **触发方式**由 `ai.trigger` 控制：`mention`（默认，@ 才回）、`prefix`（`/ai` 开头）、`all`（所有消息）；私聊不需要触发词。
- **记忆分域**：群聊按群共享、私聊按用户隔离，写入时按 `maxKeep` 裁剪，不会无限膨胀。
- **`/ai-stats` 不编数据**：把真实统计数字注入提示词并要求模型以此为准，避免模型编造群活跃度。
- **可注入 provider**：`createBot({ aiProvider })` 可替换实现，测试不依赖真实网络与密钥。

### 📊 群聊统计

- 消息明细 + 成员汇总同事务写入；活跃榜、发言档案（今日/本周/本月/累计）
- 活跃时段分布（24 小时 + 7 天）
- 等长周期环比涨跌
- **活跃口径统一排除指令**：`/stats` 这类操作不计入活跃榜，否则「最活跃的人」会是最常查数据的人

统计口径的一致性靠一条 SQL 层的 `ACTIVE_ONLY` 常量保证：活跃榜、活跃人数、时段分布三个视图不会再各自跑偏。

### 🛡 自动化检测

内置规则开箱可用，全部可在群维度调阈值或关闭：

| 类型 | 判定 | 默认动作 | 升级上限 |
| --- | --- | --- | --- |
| `flood` 刷屏 | 10 秒内超过 8 条 | 禁言 | 可到踢出 |
| `repeat` 复读 | 连续 4 次相同内容 | 警告 | 最多禁言 |
| `ad` 引流广告 | 联系方式 + 引流动词同时出现 | 禁言 | 可到踢出 |
| `newbie_shill` 新人广告 | 入群 24h 内发广告 | 踢出 | — |
| `link` 灌链接 | 单条超过 3 个未授信链接 | 警告 | 不加重 |
| `long_text` 超长文本 | 单条超过 1000 字 | 警告 | 不加重 |
| `keyword` / `regex` | 自定义词 / 正则 | 可配 | — |

设计上的几个取舍：

- **反绕过**：所有匹配跑在归一化文本上，全角、零宽字符、插分隔符的写法（`加 微-信`）都会被击穿
- **广告用组合信号**：单看联系方式会误伤正常交流，因此要求「联系方式 + 引流动词」同时命中
- **一次事件一次处置**：一次刷屏连续命中多条消息，折叠成一个事件，不会瞬间把处罚顶到踢出
- **升级阶梯只升不降，且有上限**：`warn → mute → kick`，但每类违规有各自封顶（复读不会被累犯顶到踢出）
- **执行失败不升级**：机器人不是管理员时处置降级为群内提醒，且**不计入升级阶梯**——罚不成功不该变本加厉
- **豁免要留痕但不计风控**：管理员命中只记录不处置，且不把异常预警打到触发（预警变噪音就等于被关掉）

维护自定义规则：

```
/rule add keyword 违禁词 --action=mute    # 类型与正则当场校验，写错直接报错而不是静默失效
/rule add regex 广告\s*位 --action=warn
/rules audit                              # 挑出「启用却从未命中」的规则
```

### ⚙️ 群聊管理

```
/config set ai.trigger prefix             # 改用前缀触发
/config set ai.enabled false              # 关掉本群 AI
/config set detect.punish.enabled false   # 只检测不处罚
/config set alert.threshold 10            # 预警阈值调到 10 次
/config set welcome.enabled true
/config set welcome.text 欢迎 {at} 进群～
/config set stats.enabled false           # 本群不统计
/config keys                              # 看全部可配项
```

每个群独立配置、互不影响，`/config set` 只允许写白名单内的键，不会把任意键写进数据库。

**主动运维**——群聊机器人真正的死法是**静默失效**：掉线、权限被撤、检测被关，群里看不出异常，直到某天发现统计里少了半个月数据。因此 QQUltra 把「需要人主动问」变成「机器人主动报」：

- **异常预警**：10 分钟内违规超过阈值（默认 5 次）就在群里提醒管理员，30 分钟冷却，避免预警本身变成刷屏
- **每日简报**：订阅后每天首次收到群消息时推送昨日摘要（消息量、活跃人数、环比、风控命中）
- **`/status` 自检**：逐项检查群状态、数据流入、检测开关、连接新鲜度、数据保留策略，任一项异常都会点出来

### 🧠 群运营洞察

统计只回答「有多少消息、谁在说话」。真正需要人做决定的判断在另一层：**谁不说话了、话题在变热还是变冷、有没有规则在空转。**

```
/vibe              群活跃总览：今日/本周/本月 + 周活跃占比 + 一句判断
/silent 14         沉默成员：累计发言 ≥10 条但最近 14 天没说话的人
/trend 7           话题趋势：近 7 天 vs 前 7 天，分「变热/新话题/变冷/已消失」
/newcomers 7       新成员观察：区分「潜水新成员」与「正常新人」
/rules audit       规则效果：挑出启用却从未命中的规则
```

命令行等价入口（读本地库，不需要 QQ 环境）：

```bash
node bin/qqultra.js insight <群号>   # 一次输出上面全部内容
```

三个刻意的设计：

- **沉默成员用「历史发言 ≥10 条」做门槛**：只冒过一两次泡的人不算流失，而一个曾经活跃的人突然安静 14 天，才是值得有人去问一句的信号
- **话题趋势比「占比」而不是比「次数」**：群消息量本身波动很大（节假日能翻倍），直接比次数会把「群变热闹」误读成「这个话题变热」
- **规则效果评估专门挑「从未命中」**：长期运行的群会攒下一堆当时觉得有用的规则，没人会主动删；而一条写坏的正则只会安静地躺在库里，等一个误伤正常聊天的机会

## 运维与数据

### CLI 命令

```bash
node bin/qqultra.js start            # 启动机器人
node bin/qqultra.js demo             # 离线端到端演示（不需要 QQ 环境）
node bin/qqultra.js inspect          # 查看生效配置（密钥脱敏）
node bin/qqultra.js health [群号]    # 运行自检
node bin/qqultra.js panel            # 预览群内管理面板
node bin/qqultra.js report <群号>    # 输出某群统计报告
node bin/qqultra.js insight <群号>   # 群运营洞察
node bin/qqultra.js wordcloud <群号> --period=week   # 终端词云
node bin/qqultra.js digest <群号>    # 预览每日简报
node bin/qqultra.js purge [天数]     # 清理过期明细
node bin/qqultra.js about | version | help
```

### 数据

数据存在单个 SQLite 文件（默认 `data/qqultra.db`），按 `stats.retentionDays`（默认 180 天）自动清理过期明细。

```bash
# 备份（含 WAL，必须一起复制；或直接用 .backup）
sqlite3 data/qqultra.db ".backup backup-$(date +%F).db"

# 查最近的处置记录
sqlite3 data/qqultra.db \
  "SELECT datetime(created_at/1000,'unixepoch','localtime'), user_id, kind, action
   FROM violations ORDER BY created_at DESC LIMIT 20"
```

保留策略执行时会同步做三件事：删过期消息明细、删过期违规记录、清掉「明细已删但汇总仍在」的成员行（否则 `/whois` 会一直展出查不到明细的幽灵成员）。

### 隐私边界

- 只存群号、QQ 号、昵称与消息文本，不采集 IP 或客户端信息
- 机器人自身消息不入库
- 数据只落本地 SQLite，不外传；AI 回复时仅发送当前会话上下文与提问
- 可用 `stats.enabled: false` 关闭统计，或 `/purge` 清理历史
- 出图用的临时文件登记 10 分钟 TTL，进程退出时清理；上次遗留的会在启动时回收

## 文档导航

| 文档 | 内容 | 适合谁 |
| --- | --- | --- |
| [docs/USAGE.md](docs/USAGE.md) | 群内指令手册、参数细节、运营场景配方 | 群主 / 管理员 / 日常使用者 |
| [docs/CONFIG.md](docs/CONFIG.md) | 全局配置项、环境变量、群级配置、检测默认值速查 | 部署与调参的人 |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 上线步骤、systemd / Docker、权限要求、排障表 | 运维 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层设计、关键不变量、数据模型、扩展点 | 二次开发者 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 本地开发、测试分层、加检测器/指令/适配器的完整步骤 | 贡献者 |
| [docs/FAQ.md](docs/FAQ.md) | 常见问题与真实踩坑 | 所有人 |
| [CHANGELOG.md](CHANGELOG.md) | 逐版本变更，含「原来错在哪」 | 升级的人 |

## 常见问题

**Q：需要装 Node 吗？什么版本？**
需要 Node ≥ 22.5（`node:sqlite` 的引入版本），无需 `npm install`——零运行时依赖。

**Q：一定要用 NapCat 吗？**
不用。任何实现 OneBot 11 的协议端都可以（NapCat / Lagrange / LLOneBot / go-cqhttp）。NapCat 的优势是能直接装进 PC 端 QQ。

**Q：机器人明明在线，为什么不撤回 / 不踢人？**
机器人需要群管理员权限。权限不足时不会崩，但处置会降级为群内提醒，并在违规记录里标记 `degraded`（且不计入升级阶梯）。

**Q：统计数字比实际偏大？**
0.3.0 之前会被协议端重放的消息重复计数。现在按 `(群号, message_id)` 唯一索引去重，老库升级时迁移会自动清理历史重复行。

**Q：AI 不回话？**
先确认 `ai.enabled`、`ai.apiKey`，再看触发方式（默认 `mention`，群里需要 @ 机器人）。用 `QQU_LOGLEVEL=debug` 启动能看到上游原始错误。

更多见 **[docs/FAQ.md](docs/FAQ.md)** 与 [docs/DEPLOY.md 排障表](docs/DEPLOY.md#排障)。

## 项目状态

- **版本**：v0.4.0（文档完善版，已发布 Release）
- **测试**：270 个用例全部通过，覆盖单元 / 模块 / 端到端 / 发布回归四层
- **依赖**：运行时 0 个（数据库用 `node:sqlite`，网络用内置 `fetch` / `WebSocket`）
- **性能**：单条消息完整处理（入库 → 检测 → 处置 → 主动服务）实测约 **0.66ms**
- **CI**：push 与 PR 共用同一套 stages（YAML 锚点），避免「PR 绿了、合并到 main 却挂了」

```bash
node --test "test/*.test.js"   # 270 个用例
npm run demo                   # 离线端到端演示
npm run health                 # 自检
```

## 作者

| | |
| --- | --- |
| 作者 | 科技酱 |
| 网站 | <https://docs.asoe.cn> |
| GitHub | <https://github.com/techjiang/> |
| 哔哩哔哩 | <https://space.bilibili.com/1768832152> |
| 玲珑论坛 | <https://forums.asoe.cn/> |
| QQ 群 | 291974598 / 474819022 |

## License

MIT
