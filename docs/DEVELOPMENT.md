# 开发指南

面向二次开发者与贡献者。读完这篇你可以在本地跑通链路、加一个检测器或一条指令，并让测试与 CI 通过。

设计取舍与内部约定先看 [ARCHITECTURE.md](ARCHITECTURE.md)，这篇只讲「怎么动手」。

## 目录

- [环境与起步](#环境与起步)
- [常用命令](#常用命令)
- [代码地图](#代码地图)
- [测试分层与写法](#测试分层与写法)
- [加一个检测器](#加一个检测器)
- [加一条群内指令](#加一条群内指令)
- [加一个 CLI 子命令](#加一个-cli-子命令)
- [接一个新协议端](#接一个新协议端)
- [换一个 AI 服务](#换一个-ai-服务)
- [改数据库结构](#改数据库结构)
- [提交与评审](#提交与评审)

## 环境与起步

```bash
git clone https://cnb.cool/asoe/TechSauce/QQUltra.git
cd QQUltra
node bin/qqultra.js demo        # 立刻跑通完整链路，不需要任何配置
node --test "test/*.test.js"    # 270 个用例
```

- **Node ≥ 22.5**（`node:sqlite` 的引入版本）
- **零运行时依赖**，没有 `npm install` 这一步（`npm ci` 只用于 CI 一致性）
- 开发也不需要装数据库：用 `node:sqlite` + 内存库

写代码时不要引入运行时依赖。这不是洁癖：机器人是长期常驻进程，依赖越少，两年后还能跑起来的概率越高。
如果确实需要某个能力，先看内置模块能不能满足（`node:sqlite` / `fetch` / `WebSocket` / `node:test` 已经覆盖了核心需求）。

## 常用命令

```bash
npm test                          # 全量测试
npm run demo                      # 离线端到端演示
npm run panel                     # 预览管理面板
npm run health                    # 自检
node --test test/detect.test.js   # 只跑一个文件
node --test --test-name-pattern="词云" test/*.test.js   # 只跑匹配的用例

# 手动造数据后看效果（数据落在 data/qqultra.db）
node bin/qqultra.js report <群号> --period=all
node bin/qqultra.js insight <群号>
node bin/qqultra.js wordcloud <群号> --period=week
```

调试时把日志开到 debug：

```bash
QQU_LOGLEVEL=debug node bin/qqultra.js start
```

## 代码地图

```
src/
├── core/
│   ├── bot.js          主循环与全部指令注册（唯一把「事件 → 业务 → 回消息」串起来的地方）
│   ├── events.js       事件总线、normalizeMessage、EVENTS 常量
│   └── adapter.js      适配器契约（业务层只用它暴露的便捷方法）
├── adapters/
│   ├── onebot11.js     OneBot 11 正向 / 反向 WebSocket
│   └── mock.js         离线适配器：发出的消息进 outbox，供演示与测试断言
├── services/
│   ├── stats/          collector 采集 / report 报表 / insight 洞察 / wordcloud(-svg) 词云
│   ├── detect/         rules 检测器 / defaults 默认值 / engine 决策与留痕
│   ├── ai/             provider（OpenAI 兼容）/ session（记忆与提示词）
│   └── manage/         commands 解析 / group-config 群配置 / moderation 处置
│                       panel 面板 / digest 自检与简报
├── storage/            database / migrations / repositories
├── assets/             brand.js（作者信息唯一来源）、logo.png
└── utils/              logger / text 归一化 / time / tempfile / errors
```

**边界约定**：`core` 与 `services` 之间只能顺着「core 调 services」的方向，
`services` 不反向依赖 `core`；`adapters` 只被 `core` 装配。这样业务逻辑能被单测直接调用。

## 测试分层与写法

用 Node 内置的 `node:test`，没有测试框架依赖。四个层次：

| 层次 | 文件 | 关注 |
| --- | --- | --- |
| 单元 | `text` / `time` 相关 | 文本归一化、时间计算、命令解析、各检测器、切词与排版 |
| 模块 | `storage` / `stats` / `detect` / `ai` / `manage` | 事务、统计口径、检测决策、提示词、面板权限、健康自检 |
| 端到端 | `e2e.test.js` | 一条消息从注入到被统计、检测、处置、留痕的完整链路 |
| 发布回归 | `release.test.js` | 每个修过的缺陷固定成断言，注释写清「原来错在哪」 |

写测试的建议：

```js
import { makeBot, expectIncludes } from './helpers.js';   // 内存库 + MockAdapter + 可注入 AI provider

const { bot, storage, adapter } = await makeBot();
await bot.inject({ groupId: '1', userId: '2', text: '你好' });
```

- **用 `bot.inject()` 而不是 `adapter.say()`**：前者会 await 到全部订阅者处理结束，可以直接断言；
  后者只保证事件已派发。
- **时间要注入不要等**：检测与统计都能传 `now` / `timestamp`，构造确定场景而不是 `sleep`。
- **不要依赖执行顺序**：`node:test` 里同一文件的用例默认串行，但不同文件可能并行，各用例自己建库。
- **修 bug 必须补回归用例**，并写清「原来错在哪」。这一类测试的价值在于防止改回去，而不是证明现在是对的。

## 加一个检测器

检测器是**纯函数**：吃消息与上下文，吐「命中了什么」和「打算怎么做」，不执行任何网络动作。
因此可以在没有 QQ 环境的情况下完整单测。

```js
// src/services/detect/rules.js
export function myDetector({ message, text, rules, config, context }) {
  if (config.myRule?.enabled === false) return null;
  if (!text.includes('坏东西')) return null;
  return { kind: 'my_rule', detail: '命中坏东西', action: 'warn' };
}
```

入参契约固定为 `{ message, text, rules, config, context }`：

| 参数 | 说明 |
| --- | --- |
| `message` | 统一消息实体（`normalizeMessage` 的产物） |
| `text` | 已归一化的文本，反绕过匹配都用它 |
| `rules` | 该群生效的自定义规则（DB 规则） |
| `config` | 检测配置（`detect.*`），默认值来自 `defaults.js` |
| `context` | 跨检测器协作信息，例如 `adFinding` 供新人广告检测复用 |

返回值：`Finding`、`Finding[]` 或 `null`。`action` 取 `warn` / `mute` / `kick`。

然后：

1. 把函数注册进 `BUILTIN_DETECTORS`（**顺序有意义**，注意依赖关系，
   例如 `ad` 要排在 `newbie_shill` 之前，后者复用前者的结论）
2. 在 `RULE_TYPES` 里加类型常量
3. 在 `src/services/detect/defaults.js` 里加默认阈值和 `punish.escalateCeil` 上限
4. 补测试：命中、不命中、边界、以及「配置关掉后不生效」

检测器里不要写 `Date.now()`——需要用时间就从 `context` 取，否则测试会变成靠时钟运气。

## 加一条群内指令

在 `src/core/bot.js` 的 `registerCommands` 里注册，并在 `src/services/manage/panel.js` 的
`PANEL_SECTIONS` 登记一行。**两处都要改**：漏了面板会导致测试失败（有强制校验）。

```js
commands.register('mytool', {
  aliases: ['我的工具'],           // 可选，中文别名
  description: '我的工具',
  level: 'admin',                  // member | admin | owner
  run: ({ message, storage, args, mentions }) => {
    const n = positiveInt(args.flags.n) ?? 5;
    return `结果：${n}`;
  },
});
```

约定：

- **`run` 返回字符串即回消息**（群里回群、私聊回私聊）；返回 `null` 表示自己已经发过了。
- **用户输入错误**抛带 `expected: true` 的 `Error`，上层会渲染成 `⚠️ <你的提示>`；
  不要抛普通异常，那会被当成内部故障显示「指令执行失败」。
- **数值参数用 `positiveInt()` 而不是 `Number(x) || 1`**：后者会把 `--top abc` 静默变成 1。
- **查询语料要排除指令**：`messages.recentInGroup()` 默认已排除，需要连指令一起看时显式传
  `{ includeCommands: true }`。
- **私聊语义**：默认按「群专属」处理，若要允许私聊使用，把命令名加进 `PRIVATE_SAFE_COMMANDS`；
  否则未登记的指令会拿 `groupId=null` 去查库，返回看起来像坏了的假报告。
- **权限**：`level: 'admin'` 会在群里校验角色，私聊一律要求账号在 `permission.whiteList` 内。

## 加一个 CLI 子命令

`bin/qqultra.js` 是一个 switch 分发器，加分支即可：

```js
case 'mytool':
  cmdMyTool(rest);
  break;
```

要读本地库就用现成的 `openLocalStorage()`（自动装载配置、打开数据库、跑迁移）。
CLI 与群内指令**尽量共用同一批纯函数**，保证「命令行看到的」和「群里看到的」口径一致——
`insight` 就是这么做的。别忘了同步 `USAGE` 常量（`.cnb.yml` 里有 grep 冒烟检查）。

## 接一个新协议端

继承 `Adapter`，实现三个方法，把平台事件翻译成 `normalizeMessage` 后 emit：

```js
import { Adapter } from '../core/adapter.js';
import { normalizeMessage } from '../core/events.js';

export class MyPlatformAdapter extends Adapter {
  get name() { return 'myplatform'; }
  async _connect() { /* 建立连接，成功后设置 this.selfId */ }
  async _send(action, params) { /* 把 action 映射成平台 API 调用 */ }
  async _disconnect() { /* 收尾 */ }
  // 收到平台消息时：
  // this.emitMessage(normalizeMessage({ ... }));
}
```

要求：

- 三个方法都要能**失败时报错**，不要静默吞掉（业务层依赖异常做降级）
- `_send` 未实现的动作要抛错，不要返回假成功——否则处置会显示「已执行」而实际没有
- 新协议端只需在 `createApp` 之外自行组装（`createBot({ adapter })`），业务模块一行都不用改

`MockAdapter` 是最简参考实现，也是测试的注入点。

## 换一个 AI 服务

只要实现一个带 `chat(messages, opts) => { content }` 的对象即可：

```js
const bot = createBot({ config, storage, adapter, aiProvider: myProvider });
```

内置的 `createOpenAICompatibleProvider` 已覆盖所有 OpenAI 兼容端点（DeepSeek、通义、vLLM、Ollama）。
测试里直接注入假 provider，不依赖网络与密钥，也不怕被限流。

## 改数据库结构

**已发布的迁移不再修改，只追加新版本。** 迁移按 `MIGRATIONS` 数组顺序执行，
执行记录写在 `schema_migrations`。

```js
// src/storage/migrations.js
export const MIGRATIONS = [
  // …已有版本
  {
    version: 5,
    name: '给某表加索引',
    up: (db) => { db.run('CREATE INDEX IF NOT EXISTS ...'); },
  },
];
```

注意事项：

- **老库升级路径必须能跑通**：`v4` 加了 `(group_id, message_id)` 唯一索引，
  用的是「先清历史重复行再建索引」的形式——不清就建不上，老库会直接起不来。
  写迁移时先想「库里已经有脏数据会怎样」。
- 迁移里的语句要幂等（`IF NOT EXISTS`），因为 `resolve` 钩子会在某些场景重跑。
- 改完记得测：`storage.test.js` 里有针对迁移的用例，补一个「老库升级」场景。

## 提交与评审

**提交信息**用 Conventional Commits，中文描述：

```
fix: 协议端重放导致统计翻倍、事务嵌套崩溃风险
feat(stats): 词云支持 --img 出图卡
docs: 重写 README 并新增使用/配置/开发/FAQ 文档
perf: 缓存预编译语句，单条消息处理耗时降低约 30%
test: 新增发布回归集（44 例）
```

体例上注意：

- 一次提交做一件事，便于回滚与 review
- 提交信息里写清**为什么**，而不是复述 diff；修 bug 时说明「原来错在哪」
- 改动用户可见的行为要同步文档与 `CHANGELOG.md`

**提交前自检**：

```bash
npm test && node bin/qqultra.js demo && node bin/qqultra.js help > /dev/null
```

CI 会在 push 和 PR 上跑同一套 stages（YAML 锚点复用，避免「PR 绿了、合并到 main 却挂了」）：

1. `npm ci`
2. `npm test`
3. `node bin/qqultra.js demo`（离线链路自检）
4. 面板与自检命令可用（含 `panel` / `insight` / `about` / `help` 的 grep 冒烟）
5. 运营洞察相关指令出现在面板里

改文档时注意：`.cnb.yml` 里有对 CLI 输出内容做 grep 的检查，
改了 `USAGE`、面板文案或 `about` 的输出要同步确认这些检查仍然通过。
