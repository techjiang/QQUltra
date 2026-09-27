<div align="center">

<img src="src/assets/logo.png" alt="QQUltra" width="180" />

# QQUltra

**至尊 QQ 人工智能 · 群聊统计 · 自动化检测 · 群聊信息管理**

<img src="https://img.shields.io/badge/Node-%E2%89%A522.5-339933?logo=node.js&logoColor=white" alt="node" />
<img src="https://img.shields.io/badge/dependencies-0-blue" alt="zero deps" />
<img src="https://img.shields.io/badge/tests-264%20passing-brightgreen" alt="tests" />
<img src="https://img.shields.io/badge/license-MIT-green" alt="license" />

[作者网站](https://docs.asoe.cn) · [论坛](https://forums.asoe.cn/) · [B 站](https://space.bilibili.com/1768832152) · [GitHub](https://github.com/techjiang/)

</div>

---

QQUltra 是一个常驻 QQ 群的机器人，**在 PC 端 QQ 的聊天窗口里直接使用和管理**，
不需要切浏览器开面板。四件事做在一个进程里：

- **AI 对话** —— 群内 @ 或私聊触发，带多轮记忆，可切换触发方式
- **群聊统计** —— 活跃榜、发言档案、活跃时段分布、环比涨跌、词云
- **自动化检测** —— 刷屏、复读、广告引流、敏感词、灌链接，命中即处置
- **群聊管理** —— 入群审核、新人欢迎、规则增删、按群独立配置、异常预警、每日简报

## 为什么在 PC 端 QQ 里用

PC 端 QQ 打开的就是聊天窗口，QQUltra 把「管理台」做成了群内消息：

| 方式 | 入口 | 说明 |
| --- | --- | --- |
| `/panel` | 群里或私聊机器人 | 一屏列出所有可用指令，**看到即用**，复制粘贴即可执行 |
| `/panel --img` | 同上 | 面板渲染成图文卡片，长清单不被客户端折叠 |
| 私聊机器人 | PC 端 QQ 好友列表 | 直接对话式操作，不用进群 |
| `/status` | 群里 | 运行自检，掉线、检测被关、权限缺失都会点出来 |

不需要额外登录、不需要开浏览器、不需要映射端口。

## 快速开始

```bash
git clone <repo> && cd QQUltra
node bin/qqultra.js demo        # 离线跑一遍完整链路，不需要 QQ 环境
```

`demo` 用内存库 + 模拟适配器，把「统计采集 → 广告检测 → 刷屏处置 → 指令查询」整条链路走一遍。

## 接入真实 QQ

QQUltra 通过 **OneBot 11** 协议与协议端通信，兼容 NapCat、Lagrange、LLOneBot、go-cqhttp 等。

**1. 准备协议端**（以 NapCat 为例，装进 PC 端 QQ 即可），登录机器人账号并开启 OneBot 11 的 WebSocket。

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

群里发送，或私聊机器人。需要管理员权限的指令会校验发送者角色；
**私聊里没有群角色，管理指令只认 `permission.whiteList`**（这是刻意的，否则任何人都能私聊清库）。

| 指令 | 权限 | 说明 |
| --- | --- | --- |
| `/help` | 所有人 | 指令一览（也支持中文别名，如 `/菜单`、`/统计`） |
| `/panel [--img]` | 所有人 | 管理面板，`--img` 出图卡 |
| `/status` | 所有人 | 运行状态与健康自检 |
| `/about` | 所有人 | 作者与项目信息 |
| `/ping` | 所有人 | 存活检查 |
| `/stats [today\|week\|month\|all]` | 所有人 | 统计报告，可加 `--top=N`，支持 `/stats 本周` |
| `/rank [周期]` | 所有人 | 活跃榜 |
| `/wordcloud [周期]` | 所有人 | 词云图（SVG 图片，失败自动退回文本） |
| `/trend [天数]` | 所有人 | 话题趋势：近 N 天 vs 前 N 天 |
| `/vibe` | 所有人 | 活跃总览与判断 |
| `/silent [天数]` | 所有人 | 沉默成员（谁不说话了） |
| `/newcomers [天数]` | 所有人 | 新成员观察 |
| `/me` | 所有人 | 我的发言档案 |
| `/whois @某人` | 所有人 | 查他人档案 |
| `/history [@某人]` | 所有人 | 最近发言回顾，可加 `--n=5` |
| `/rules` / `/rules audit` | 所有人 | 查看生效规则 / 规则命中效果评估 |
| `/violations` | 管理员 | 最近违规记录 |
| `/alert [on\|off\|threshold N]` | 管理员 | 异常预警开关与阈值 |
| `/subscribe` `/unsubscribe` | 管理员 | 每日简报订阅 |
| `/ai <问题>` | 所有人 | 问 AI |
| `/ai-stats [周期]` | 所有人 | 让 AI 解读统计数据 |
| `/ai-reset` | 所有人 | 清空本会话记忆 |
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
私聊不需要触发词，发什么回什么。

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
- **执行失败不升级**：机器人不是管理员时，处置降级为群内提醒，且**不计入升级阶梯**——罚不成功不该变本加厉
- **失败降级**：处置失败不中断主循环

加自定义规则：

```
/rule add keyword 违禁词 --action=mute
/rule add regex /广告\s*位/ --action=warn
```

## 主动运维

群聊机器人真正的死法是**静默失效**：掉线、权限被撤、检测被关，群里看不出异常，
直到某天发现统计里少了半个月数据。因此 QQUltra 把「需要人主动问」变成「机器人主动报」：

- **异常预警**：10 分钟内违规超过阈值（默认 5 次）就在群里提醒管理员，30 分钟冷却避免预警本身变成刷屏
- **每日简报**：订阅后每天首次收到群消息时推送昨日摘要（消息量、活跃人数、环比、风控命中）
- **`/status` 自检**：逐项检查群状态、数据流入、检测开关、连接新鲜度，任一项异常都会点出来

## 词云

`/wordcloud [周期]` 从群消息里抽高频词，渲染成 SVG 图卡发到群里。

不引第三方分词库（零依赖是硬约束），改用「中文二元切分 + 英文单词 + 停用词过滤」：
中文靠 bigram 抓「排位」「更新」这类高频组合，精度不如成熟分词但完全确定性、可单测。
副作用是会产出跨词边界的噪声词（`排位上分` → `位上`），靠 `minCount` 过滤。

## 群运营洞察

统计只回答「有多少消息、谁在说话」。真正需要人做决定的判断在另一层：
**谁不说话了、话题在变热还是变冷、有没有规则在空转。**

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

几个刻意的设计：

- **沉默成员用「历史发言 ≥10 条」做门槛**：只冒过一两次泡的人不算流失，
  而一个曾经活跃的人突然安静 14 天，才是值得有人去问一句的信号
- **话题趋势比「占比」而不是比「次数」**：群消息量本身波动很大（节假日能翻倍），
  直接比次数会把「群变热闹」误读成「这个话题变热」
- **规则效果评估专门挑「从未命中」**：长期运行的群会攒下一堆当时觉得有用的规则，
  没人会主动删。而一条写坏的正则只会安静地躺在库里，等一个误伤正常聊天的机会

## 群内配置

每个群可独立配置，互不影响：

```
/config set ai.trigger prefix       # 改用前缀触发
/config set ai.enabled false        # 关掉本群 AI
/config set detect.punish.enabled false   # 只检测不处罚
/config set alert.threshold 10      # 预警阈值调到 10 次
/config set welcome.enabled true
/config set welcome.text 欢迎 {at} 进群～
/config set stats.enabled false      # 本群不统计
```

## 运维

```bash
node bin/qqultra.js inspect        # 查看生效配置（密钥脱敏）
node bin/qqultra.js panel          # 预览群内管理面板
node bin/qqultra.js health         # 运行自检
node bin/qqultra.js report 123456  # 直接输出某群统计
node bin/qqultra.js wordcloud 123456 --period=week   # 终端词云
node bin/qqultra.js digest 123456  # 预览每日简报
node bin/qqultra.js purge 30       # 清理 30 天前明细
node bin/qqultra.js start          # 启动机器人
node bin/qqultra.js about          # 作者与项目信息
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
业务模块  统计采集 / 检测引擎 / AI 会话 / 群管理 / 面板 / 巡检
   ↓
存储层    SQLite：明细表 + 成员汇总 + 规则 + 违规 + 会话
```

关键设计：**检测引擎只输出「打算做什么」，不直接执行动作**。执行统一由 `moderator` 通过适配器完成，
因此检测逻辑可以脱离 QQ 环境单测，网络调用也不会散落在规则里。

```
src/
├── core/         事件总线、适配器契约、Bot 主循环
├── adapters/     onebot11（正向/反向）、mock（离线用）
├── assets/       Logo 与作者信息（唯一来源）
├── services/
│   ├── stats/    采集器、报表、词云、SVG 渲染、运营洞察
│   ├── detect/   规则、默认配置、检测引擎
│   ├── ai/       会话管理、OpenAI 兼容 provider
│   └── manage/   指令、群配置、处置执行、管理面板、巡检简报
├── storage/      数据库、迁移、仓储
└── utils/        日志、文本归一化、时间、临时文件生命周期
```

## 开发

```bash
node --test "test/*.test.js"   # 264 个用例
npm run demo                   # 离线端到端演示
```

零运行时依赖：数据库用 Node 内置 `node:sqlite`，HTTP/WebSocket 用内置 `fetch`/`WebSocket`。
要求 Node ≥ 22.5（`node:sqlite` 的引入版本）。

测试覆盖的三个层次：

- **单元**：文本归一化、时间计算、命令解析、各检测器、切词与排版
- **模块**：存储事务、统计口径、检测引擎决策、AI 提示词、面板权限、健康自检
- **端到端**：一条消息从注入到被统计、检测、处置、留痕的完整链路
- **发布回归**（`test/release.test.js`）：把每个修过的缺陷固定成断言，
  注释里写清「原来错在哪」，避免后来的人改回去

## 隐私边界

- 只存群号、QQ 号、昵称与消息文本，不采集 IP 或客户端信息
- 机器人自身消息不入库
- 数据只落本地 SQLite，不外传；AI 回复时仅发送当前会话上下文与提问
- 可用 `stats.enabled: false` 关闭统计，或 `/purge` 清理历史
- 出图用的临时文件登记 10 分钟 TTL，进程退出时清理；上次遗留的会在启动时回收

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
