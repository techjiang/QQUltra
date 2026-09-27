# 配置手册

QQUltra 的配置分两层：

| 层级 | 作用范围 | 载体 | 怎么改 |
| --- | --- | --- | --- |
| **全局配置** | 整个进程 | `qqultra.config.json` 或环境变量 | 改文件 / 环境变量后重启 |
| **群级配置** | 单个群，互不影响 | 数据库 `groups.settings`（JSON） | 群内 `/config set`，立即生效 |

优先级：**默认值 < 配置文件 < 环境变量 <（群级配置，仅群维度项）**。

改完先确认真正生效的值：

```bash
node bin/qqultra.js inspect      # 输出生效配置，密钥自动脱敏
```

## 目录

- [全局配置](#全局配置)
  - [顶层](#顶层)
  - [onebot](#onebot协议端连接)
  - [ai](#ai对话)
  - [stats](#stats统计)
  - [detect](#detect检测)
  - [permission](#permission权限)
  - [retention](#retention保留策略)
- [环境变量](#环境变量)
- [群级配置](#群级配置)
- [检测默认值速查](#检测默认值速查)
- [配置的坑](#配置的坑)

## 全局配置

完整可复制的模板见仓库根目录 [`qqultra.config.example.json`](../qqultra.config.example.json)。

### 顶层

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `logLevel` | string | `info` | `debug` / `info` / `warn` / `error`。排障用 `debug`，会打印上游原始错误、降级原因等 |
| `dataFile` | string | `data/qqultra.db` | SQLite 文件路径；设为 `:memory:` 用于临时验证 |

### onebot（协议端连接）

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `mode` | `forward` / `reverse` | `forward` | 连接方向 |
| `wsUrl` | string | `ws://127.0.0.1:3001` | `forward` 模式下协议端的正向 WS 地址 |
| `accessToken` | string | `""` | 令牌。`forward` 会带在 URL 查询参数里；`reverse` 用于校验反连请求 |
| `listenHost` | string | `0.0.0.0` | `reverse` 模式监听地址 |
| `listenPort` | number | `8642` | `reverse` 模式监听端口 |
| `reconnectDelay` | number | `3000` | 重连基础延迟（ms），掉线后指数退避，上限 60s |

```json
{
  "onebot": {
    "mode": "forward",
    "wsUrl": "ws://127.0.0.1:3001",
    "accessToken": "换成你的令牌"
  }
}
```

反向模式（机器人没有公网入口 / 想由协议端主动连进来）：

```json
{
  "onebot": {
    "mode": "reverse",
    "listenHost": "0.0.0.0",
    "listenPort": 8642,
    "accessToken": "你的令牌"
  }
}
```

> 反向模式下，鉴权令牌既接受 `Authorization: Bearer <token>`，也接受 URL 查询参数 `access_token`；
> 校验失败会以 `4001 unauthorized` 关闭连接，日志有 `反向连接鉴权失败，已拒绝`。
> 反向模式的端口只对协议端开放，不要暴露到公网。

### ai（对话）

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | 总开关 |
| `baseUrl` | string | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `apiKey` | string | `""` | 密钥 |
| `model` | string | `deepseek-chat` | 模型名 |
| `temperature` | number | `0.7` | 采样温度 |
| `maxTokens` | number | `512` | 单次生成上限 |
| `timeout` | number | `60000` | 请求超时（ms） |
| `systemPrompt` | string \| null | `null` | 系统提示词；`null` 用内置人设 |

推荐配置（DeepSeek 示例）：

```json
{
  "ai": {
    "enabled": true,
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-xxx",
    "model": "deepseek-chat",
    "systemPrompt": "你是本群的助手，说话简短口语化，不要暴露自己是模型"
  }
}
```

换成通义、自建 vLLM 等只需改 `baseUrl` 与 `model`——QQUltra 只依赖 `/chat/completions` 这一个接口。

### stats（统计）

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否采集群消息明细 |
| `retentionDays` | number | `180` | 明细保留天数，到点自动清理 |

### detect（检测）

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 检测总开关（群级可再关） |

> 详细的阈值、动作与升级上限属于**群级配置**，全局默认值定义在
> [`src/services/detect/defaults.js`](../src/services/detect/defaults.js)，见下文[检测默认值速查](#检测默认值速查)。

### permission（权限）

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `whiteList` | string[] | `[]` | 白名单 QQ 号。**私聊执行管理指令的唯一途径**；白名单成员在群里也不会被自动处罚 |

```json
{ "permission": { "whiteList": ["10001", "10002"] } }
```

### retention（保留策略）

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `checkIntervalHours` | number | `24` | 自动清理的执行间隔（小时） |

实际保留天数取 `stats.retentionDays`。清理执行后会写入 `retention_days` 与 `retention_last_run_at`，
`/status` 的「数据保留」自检项据此判断是否超期未跑。

## 环境变量

所有全局配置都能用环境变量覆盖，**优先级高于配置文件**。规则：

- 前缀 `QQU_`
- 层级用 **双下划线** `__` 分隔
- 键名内部的下划线会被忽略，因此 `QQU_STATS__RETENTIONDAYS` 能正确落到 `stats.retentionDays`
  （只按大小写不敏感匹配默认配置里的真实键名，不是简单转小写）

| 环境变量 | 对应配置 |
| --- | --- |
| `QQU_CONFIG` | 配置文件路径（默认 `./qqultra.config.json`） |
| `QQU_LOGLEVEL` | `logLevel` |
| `QQU_DATAFILE` | `dataFile` |
| `QQU_ONEBOT__MODE` | `onebot.mode` |
| `QQU_ONEBOT__WSURL` | `onebot.wsUrl` |
| `QQU_ONEBOT__ACCESSTOKEN` | `onebot.accessToken` |
| `QQU_ONEBOT__LISTENHOST` | `onebot.listenHost` |
| `QQU_ONEBOT__LISTENPORT` | `onebot.listenPort` |
| `QQU_ONEBOT__RECONNECTDELAY` | `onebot.reconnectDelay` |
| `QQU_AI__ENABLED` | `ai.enabled` |
| `QQU_AI__BASEURL` | `ai.baseUrl` |
| `QQU_AI__APIKEY` | `ai.apiKey` |
| `QQU_AI__MODEL` | `ai.model` |
| `QQU_AI__TEMPERATURE` | `ai.temperature` |
| `QQU_AI__MAXTOKENS` | `ai.maxTokens` |
| `QQU_AI__TIMEOUT` | `ai.timeout` |
| `QQU_AI__SYSTEMPROMPT` | `ai.systemPrompt` |
| `QQU_STATS__ENABLED` | `stats.enabled` |
| `QQU_STATS__RETENTIONDAYS` | `stats.retentionDays` |
| `QQU_DETECT__ENABLED` | `detect.enabled` |
| `QQU_PERMISSION__WHITELIST` | `permission.whiteList`（JSON 数组字符串） |
| `QQU_RETENTION__CHECKINTERVALHOURS` | `retention.checkIntervalHours` |

值的类型会自动推断：`true`/`false` → 布尔，纯数字 → 数字，`[...]`/`{...}` → JSON 解析。

```bash
QQU_ONEBOT__WSURL=ws://127.0.0.1:3001 \
QQU_ONEBOT__ACCESSTOKEN=你的令牌 \
QQU_AI__ENABLED=true \
QQU_AI__APIKEY=sk-xxx \
QQU_PERMISSION__WHITELIST='["123456"]' \
QQU_LOGLEVEL=debug \
node bin/qqultra.js start
```

`node bin/qqultra.js inspect` 会打印「配置来源：文件 + 环境变量（…）」，可确认覆盖是否生效。

## 群级配置

群级配置存在数据库里，改完**立即生效**，不需要重启。用 `/config keys` 查看全部可改项。

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `stats.enabled` | boolean | `true` | 本群是否统计 |
| `alert.enabled` | boolean | `true` | 本群异常预警开关 |
| `alert.threshold` | number | `5` | 预警阈值（命中次数 / 10 分钟） |
| `ai.enabled` | boolean | `true` | 本群 AI 开关 |
| `ai.trigger` | `mention` / `prefix` / `all` | `mention` | 群内触发方式 |
| `ai.prefix` | string | `/ai` | `prefix` 触发方式使用的前缀 |
| `ai.maxReplyLength` | number | `400` | 单条回复最长字符数 |
| `ai.contextLines` | number | `0` | 注入的群上下文行数 |
| `detect.enabled` | boolean | `true` | 本群检测开关 |
| `detect.punish.enabled` | boolean | `true` | 是否真的执行处罚（关掉＝只记录） |
| `detect.punish.muteSeconds` | number | `600` | 禁言时长（秒） |
| `welcome.enabled` | boolean | `false` | 新人入群欢迎 |
| `welcome.text` | string | 内置模板 | 欢迎语，`{at}` 会被替换成 @ 新人 |
| `antispam.enabled` | boolean | `true` | 入群审核开关 |
| `antispam.autoApprove` | boolean | `false` | 是否自动通过入群申请（默认人工） |

```
/config set ai.trigger prefix
/config set detect.punish.enabled false
/config set alert.threshold 10
```

`/config set` 只接受上表内的键，写入时会做类型校验（布尔必须 `true`/`false`，枚举必须取值合法），
非法输入直接报错，不会写入半截配置。

> 群级配置不可用的项（如 `onebot.wsUrl`）属于进程级，必须改配置文件后重启——
> 一个群不该有能力改掉所有群的连接地址。

### 检测的群级默认值（只读，用于理解行为）

下面这些值来自全局默认（[`src/services/detect/defaults.js`](../src/services/detect/defaults.js)），
当前没有开放 `/config set`，只能改代码或等后续版本开放：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `detect.windowMs` | `10000` | 刷屏统计窗口 |
| `detect.flood.maxMessages` | `8` | 窗口内允许的最大条数 |
| `detect.repeat.maxTimes` | `4` | 连续相同内容的判定次数 |
| `detect.link.maxLinks` | `3` | 单条允许的未授信链接数 |
| `detect.link.whitelist` | `[]` | 链接白名单域名 |
| `detect.longText.maxLength` | `1000` | 超长文本阈值（字符） |
| `detect.newbie.windowHours` | `24` | 新人广告判定窗口（小时） |
| `detect.punish.escalate` | `true` | 累犯是否升级 |
| `detect.punish.incidentWindowMs` | `60000` | 同一事件的合并窗口 |
| `detect.punish.trustedRoles` | `['owner','admin']` | 永不被自动处罚的角色 |

## 检测默认值速查

各类违规的默认动作与**升级上限**（累犯加重时最多到哪一档）：

| 类型 | 默认动作 | 升级上限 |
| --- | --- | --- |
| `flood` 刷屏 | `mute` | `kick` |
| `repeat` 复读 | `warn` | `mute` |
| `ad` 引流广告 | `mute` | `kick` |
| `newbie_shill` 新人广告 | `kick` | `kick` |
| `link` 灌链接 | `warn` | `warn`（不加重） |
| `long_text` 超长文本 | `warn` | `warn`（不加重） |
| `keyword` / `regex` | 按规则配置 | 不加重 |

为什么每种类型单独封顶：不设上限时任何违规都能被累犯顶到踢出，
而复读的默认动作是警告、也没有自己的动作配置项，运营根本无从察觉这条升级路径。

## 配置的坑

**1. 环境变量写对了却被忽略？**

检查层级分隔符是双下划线 `__`。`QQU_STATS_RETENTIONDAYS` 会被解析成一个不存在的层级，
`QQU_STATS__RETENTIONDAYS` 才对。用 `inspect` 确认。

**2. `QQU_PERMISSION__WHITELIST` 必须是 JSON 数组**

```
QQU_PERMISSION__WHITELIST='["123456","234567"]'    ✅
QQU_PERMISSION__WHITELIST=123456                   ❌ 解析失败会退化成字符串比较
```

**3. 群配置把全局默认挤掉**

群配置读出来会与全局默认**深合并**，所以 `/config set welcome.enabled true` 不会丢掉
`welcome.text` 的默认值。如果你在数据库里手写 `settings`，也请只写要覆盖的字段。

**4. 配置改了但群里行为没变**

顺序检查：`inspect` 看进程是否读到新配置（进程级要重启）→ `/config` 看本群是否被单独覆盖 →
`/status` 看检测是否被关掉。群级配置优先于全局。

**5. 反向模式连不上**

确认 `listenHost`/`listenPort` 对协议端可达（Docker 里要映射端口），
以及协议端配置的 token 与 `onebot.accessToken` 一致。
