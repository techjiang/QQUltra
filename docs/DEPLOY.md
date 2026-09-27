# 部署与运维

> 相关文档：[配置手册](CONFIG.md) · [使用手册](USAGE.md) · [常见问题](FAQ.md) · [架构说明](ARCHITECTURE.md)

## 目录

- [上线前准备](#上线前准备)
- [场景：在 PC 端 QQ 里管理](#场景在-pc-端-qq-里管理)
- [前置：准备协议端](#前置准备协议端)
- [方式一：直接跑](#方式一直接跑)
- [方式二：systemd](#方式二systemd)
- [方式三：Docker](#方式三docker)
- [首次上线检查](#首次上线检查)
- [权限要求](#权限要求)
- [数据维护](#数据维护)
- [升级流程](#升级流程)
- [监控与告警](#监控与告警)
- [排障](#排障)

## 上线前准备

| 项 | 要求 |
| --- | --- |
| Node | ≥ 22.5（`node:sqlite`） |
| 依赖 | 无。不需要 `npm install`（CI 里用 `npm ci` 只是为了可复现） |
| 协议端 | 任一 OneBot 11 实现，已登录机器人账号 |
| 磁盘 | 数据量大头是消息明细。1 万条/群/月 × 180 天约数十 MB，按群数估算即可 |
| 网络 | `forward` 模式需要能访问协议端 WS 端口；`reverse` 模式需要协议端能访问本机端口 |

先跑一次离线自检确认环境本身没问题：

```bash
node --test "test/*.test.js" && node bin/qqultra.js demo
```

## 场景：在 PC 端 QQ 里管理

QQUltra 的管理入口就是 QQ 聊天窗口，不需要额外的 Web 服务或端口映射。

**四种用法**

1. **群内面板**：群里发 `/panel`，一屏列出所有可用指令，复制即用；
   `/panel --img` 出图文卡片，长清单不会被客户端折叠。
2. **私聊机器人**：PC 端 QQ 好友列表里直接找机器人对话，
   普通指令立即可用；管理指令需要把自己的 QQ 号写进 `permission.whiteList`。
3. **状态自检**：`/status` 检查群状态、数据流入、检测开关、连接新鲜度、数据保留策略。
4. **运营洞察**：`/vibe` 看群健康度，`/silent` 看谁不说话了，
   `/trend` 看话题升降，`/rules audit` 看哪些规则在空转。

**配置白名单**（私聊执行管理指令的前提）

```json
{ "permission": { "whiteList": ["你的QQ号"] } }
```

也可以用环境变量：`QQU_PERMISSION__WHITELIST='["123456"]'`

> 白名单是私聊唯一的提权途径。私聊里没有群角色，这是刻意的设计：
> 否则任何人私聊机器人都能触发 `/purge` 清库。

## 前置：准备协议端

QQUltra 不实现 QQ 协议本身，只做 OneBot 11 客户端。先选一个协议端并登录机器人账号：

| 协议端 | 说明 |
| --- | --- |
| NapCat | 基于 NTQQ，功能全，**可直接装进 PC 端 QQ**，推荐 |
| Lagrange.Core | 纯协议实现，资源占用低 |
| LLOneBot | LiteLoaderQQNT 插件形式 |
| go-cqhttp | 老牌，部分协议已失效 |

以 NapCat 为例，在配置里开启 OneBot 11 的 WebSocket 服务端：

```json
{
  "network": {
    "websocketServers": [
      { "name": "qqu", "enable": true, "host": "0.0.0.0", "port": 3001, "token": "换成你的令牌" }
    ]
  }
}
```

## 方式一：直接跑

```bash
cp qqultra.config.example.json qqultra.config.json
vim qqultra.config.json        # 填 wsUrl 与 accessToken
node bin/qqultra.js start
```

## 方式二：systemd

```ini
# /etc/systemd/system/qqultra.service
[Unit]
Description=QQUltra QQ Bot
After=network-online.target

[Service]
Type=simple
User=qqultra
WorkingDirectory=/opt/qqultra
Environment=QQU_ONEBOT__WSURL=ws://127.0.0.1:3001
Environment=QQU_ONEBOT__ACCESSTOKEN=你的令牌
Environment=QQU_AI__ENABLED=true
Environment=QQU_AI__APIKEY=sk-xxx
ExecStart=/usr/bin/node bin/qqultra.js start
Restart=always
RestartSec=5
# 加固：机器人只需要读写自己的数据目录
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/qqultra/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now qqultra
journalctl -u qqultra -f
```

## 方式三：Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY . .
VOLUME /app/data
CMD ["node", "bin/qqultra.js", "start"]
```

```bash
docker build -t qqu .
docker run -d --name qqu --restart unless-stopped \
  -e QQU_ONEBOT__WSURL=ws://host.docker.internal:3001 \
  -e QQU_ONEBOT__ACCESSTOKEN=你的令牌 \
  -v qqu-data:/app/data \
  qqu
```

反向模式需要额外映射端口：`-p 8642:8642` 并设 `QQU_ONEBOT__MODE=reverse`。

## 首次上线检查

1. `node bin/qqultra.js inspect` 确认真实生效的配置
2. 启动后日志出现 `已就绪，机器人 QQ: xxx`
3. 群里发 `/ping`，应回 `pong`
4. 发 `/panel`，确认面板可见（普通成员不应看到管理项）
5. 发 `/status`，确认自检全绿
6. 确认机器人有**管理员权限**——否则撤回/禁言/踢人会失败（会自动降级为提醒，且不计入升级阶梯）
7. 建议设 `permission.whiteList` 为管理员 QQ 号，便于私聊运维

## 权限要求

| 动作 | 所需权限 |
| --- | --- |
| 收发消息、统计 | 无特殊要求 |
| 撤回消息、禁言、踢人 | 群管理员 |
| 入群审核 | 群管理员或群主 |

机器人权限不足时不会崩溃：处置失败会降级为群内提醒，并在违规记录里标记 `degraded`，
且**不计入升级阶梯**（罚不成功不该变本加厉）。

## 数据维护

```bash
# 备份（含 WAL，必须一起复制）
sqlite3 data/qqultra.db ".backup backup-$(date +%F).db"

# 保留最近 30 天
node bin/qqultra.js purge 30

# 查看最近的处置记录
sqlite3 data/qqultra.db \
  "SELECT datetime(created_at/1000,'unixepoch','localtime'), user_id, kind, action
   FROM violations ORDER BY created_at DESC LIMIT 20"
```

`stats.retentionDays` 默认 180 天，到达后自动清理明细。清理会同步做三件事：
删除过期消息明细、删除过期违规记录、清掉「明细已删但汇总仍在」的成员行
（否则 `/whois` 会一直展出「累计发言 12 条」但明细里查不到的幽灵成员）。

清理执行后会写入 `retention_days` 与 `retention_last_run_at`，`/status` 的
「数据保留」自检项据此判断是否超期未跑——长期不跑时该项会变成 ⚠️ 警告。

## 升级流程

```bash
# 1. 备份（必须含 WAL，或直接用 .backup）
sqlite3 data/qqultra.db ".backup backup-$(date +%F).db"

# 2. 拉新版本
git pull

# 3. 跑测试与离线自检（迁移在真实库上执行前先确认代码是好的）
npm test && node bin/qqultra.js demo

# 4. 重启
sudo systemctl restart qqultra
journalctl -u qqultra -n 50 --no-pager
```

要点：

- **数据库迁移只在启动时执行**，升级前务必备份；迁移是增量的，不做破坏性改动。
- 老库若含历史重复消息，0.3.0 的迁移会先清理再建唯一索引（不清就建不上）。
  库很大时这一步耗时较长，首次启动请留出时间并观察日志。
- 升级后跑一次 `node bin/qqultra.js health`，再用 `/status` 确认自检全绿。
- 回滚：恢复备份的 `.db` 并切回旧代码即可；版本间没有不可逆的写入。

## 监控与告警

机器人最危险的失败方式是**静默失效**——群里看不出异常，直到发现数据缺了半个月。
三层兜底：

1. **`/status` 自检**（群内）：群状态、数据流入、检测开关、连接新鲜度、数据保留策略。
   任一项异常都会显示。
2. **异常预警**（群内，自动）：10 分钟内违规超过阈值就提醒管理员，30 分钟冷却。
   同时它也覆盖「突然有人批量灌广告」这类真实事件。
3. **每日简报**（群内，自动）：订阅后每天首次收到群消息时推送昨日摘要，
   **没有简报本身就是信号**——说明当天群里一条消息都没有，或进程已挂。

系统层面接你现有的监控：

```bash
# 活性探测：退出码非 0 即进程/配置有问题
node bin/qqultra.js health >/dev/null || echo "UNHEALTHY"

# 反向模式可以探 HTTP 端点（返回 {"status":"ok","app":"QQUltra"}）
curl -fsS http://127.0.0.1:8642/ || echo "UNREACHABLE"
```

日志用 `journalctl -u qqultra -f` 跟；需要更细的信息时把日志级别开到 `debug`。

## 排障

| 现象 | 排查 |
| --- | --- |
| 启动即 `无法连接 OneBot 服务端` | 协议端 WS 是否监听、`wsUrl` 端口是否对、token 是否正确 |
| 连上但收不到消息 | 协议端是否上报 `message` 事件；群是否已被 `/config` 停用 |
| 日志刷 `动作 ... 超时` | 协议端响应慢或断开；查协议端日志 |
| 机器人不撤回/不踢人 | 机器人是否群管理员 |
| AI 回 `服务暂时不可用` | 用 `QQU_LOGLEVEL=debug` 启动看上游原始错误（常见为 key 无效、余额不足、baseUrl 写错） |
| 统计条数偏少 | 检查 `/config` 里 `stats.enabled`；指令消息不计入活跃榜属预期 |
| 私聊管理指令提示需要权限 | 私聊没有群角色，需把 QQ 号写进 `permission.whiteList` |
| 新人广告从不触发 | 机器人必须在群内且能看到 `group_increase` 通知；用 `/status` 看数据流入 |
| 词云发的是文本不是图 | 协议端不支持本地文件发送；属预期降级（见日志 debug 级） |
| 面板里少了几条指令 | 普通成员看不到管理项，属预期；用管理员账号或 `/panel` 自查 |
| 预警刷屏 | 调高阈值 `/alert threshold 10`，或直接 `/alert off` |
| `/ai` 报 `Cannot read properties of undefined` | 0.3.0 之前的版本取参用了 `args.raw`，升级即可 |
| 统计数字比实际偏大 | 协议端重放消息所致；0.3.0 起按 `(群号, message_id)` 去重。若为老库，升级时迁移会自动清掉历史重复行 |
| `/trend` 说「上一周期无数据」 | 该周期确实没有消息明细；若肯定有，检查是否已被保留策略清理 |
| `/silent` 列表为空 | 没有「累计 ≥10 条且 14 天未发言」的人，属正常结论而非故障 |
| `/rules audit` 显示多条从未命中 | 这些规则的模式可能写错了。逐条核对，或 `/rule del <id>` 清理 |
| 临时目录里堆 `qqu-*.svg` | 0.3.0 起有 10 分钟 TTL 与启动回收；若仍堆积，检查进程是否被 `kill -9`（跳过退出清理） |
| 群里看不到 `/ai` 的回复 | 检查 `/config` 里 `ai.enabled` 与触发方式（默认 `mention`，即需要 @ 机器人） |
