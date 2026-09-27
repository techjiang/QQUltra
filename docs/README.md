# QQUltra 文档

先看哪一篇，取决于你现在的身份：

| 你想做的事 | 看这篇 |
| --- | --- |
| 5 分钟内看到效果 | [../README.md](../README.md#60-秒上手) —— `node bin/qqultra.js demo` |
| 日常使用 / 运营一个群 | [USAGE.md](USAGE.md) —— 指令手册与场景配方 |
| 部署上线、systemd / Docker | [DEPLOY.md](DEPLOY.md) |
| 调参数：配置项、环境变量 | [CONFIG.md](CONFIG.md) |
| 遇到问题、想知道为什么这样设计 | [FAQ.md](FAQ.md) |
| 改代码、加功能 | [DEVELOPMENT.md](DEVELOPMENT.md) |
| 想理解内部结构与取舍 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 升级前看变更 | [../CHANGELOG.md](../CHANGELOG.md) |

## 文档约定

- **数字与行为都来自代码**：指令、配置项、默认值、测试数量都能在仓库里对上。
  改了代码要同步改文档（对照表见 [ARCHITECTURE.md 的「文档与代码的对应关系」](ARCHITECTURE.md#文档与代码的对应关系)）。
- **写「为什么」而不只是「是什么」**：每个刻意的取舍都说明放弃了什么、代价是什么。
- **踩过的坑写进文档**：`CHANGELOG.md` 的每条修复都写清「原来错在哪」，
  FAQ 与排障表里保留这些现象，避免下一个人重新踩一遍。
