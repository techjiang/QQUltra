# 部署

## 前置：准备协议端

QQUltra 不实现 QQ 协议本身，只做 OneBot 11 客户端。先选一个协议端并登录机器人账号：

| 协议端 | 说明 |
| --- | --- |
| NapCat | 基于 NTQQ，功能全，推荐 |
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
4. 发 `/stats`，确认统计可用
5. 确认机器人有**管理员权限**——否则撤回/禁言/踢人会失败（会自动降级为提醒）

## 权限要求

| 动作 | 所需权限 |
| --- | --- |
| 收发消息、统计 | 无特殊要求 |
| 撤回消息、禁言、踢人 | 群管理员 |
| 入群审核 | 群管理员或群主 |

机器人权限不足时不会崩溃：处置失败会降级为群内提醒，并在违规记录里标记 `degraded`。

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

`stats.retentionDays` 默认 180 天，到达后自动清理明细（成员汇总与违规记录同步清理）。

## 排障

| 现象 | 排查 |
| --- | --- |
| 启动即 `无法连接 OneBot 服务端` | 协议端 WS 是否监听、`wsUrl` 端口是否对、token 是否正确 |
| 连上但收不到消息 | 协议端是否上报 `message` 事件；群是否已被 `/config` 停用 |
| 日志刷 `动作 ... 超时` | 协议端响应慢或断开；查协议端日志 |
| 机器人不撤回/不踢人 | 机器人是否群管理员 |
| AI 回 `服务暂时不可用` | 用 `QQU_LOGLEVEL=debug` 启动看上游原始错误（常见为 key 无效、余额不足、baseUrl 写错） |
| 统计条数偏少 | 检查 `/config` 里 `stats.enabled`；指令消息不计入活跃榜属预期 |
