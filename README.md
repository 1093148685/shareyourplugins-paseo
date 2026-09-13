# shareyourplugins-paseo

Paseo 插件分享仓库 —— 一个目录一个插件，持续更新。

## 插件列表

| 插件 | 说明 | 文档 |
|---|---|---|
| [preset-switcher](plugins/preset-switcher/) | 一键以指定**人格 + 技能 + 模型**启动 agent；预设即数据（扫描即注册），zip 预设包可导入导出，支持 claude / pi / codex / opencode 多 CLI 适配（要求 Paseo >= 0.8.0） | [README](plugins/preset-switcher/README.md) |
| [server-monitor](plugins/server-monitor/) | 多 VPS 监控面板（CPU/内存/磁盘/网络，SSH 采集）；密码 AES-256-GCM 本地加密；附带 `manage.mjs` CLI，AI 助手可一行命令添加/导入服务器（要求 Paseo >= 0.8.0） | [README](plugins/server-monitor/README.md) · [AI-GUIDE](plugins/server-monitor/AI-GUIDE.md) |
| [provider-switcher](plugins/provider-switcher/) | 在 Paseo 侧边栏直接切换 **Claude Code / Pi / Paseo** 的 API 提供商，不用再打开 cc-switch；16+7 个预设、模型拉取、端点测速、原子写 + 自动备份（要求 Paseo >= 0.8.0） | [README](plugins/provider-switcher/README.md) |

## 安装

通过 Paseo 的 git 安装源，用 `:路径` 指定子目录：

```bash
paseo plugin install github.com/1093148685/shareyourplugins-paseo:plugins/preset-switcher
```

或手动：把 `plugins/<插件名>/` 整个目录拷到 Paseo 插件目录，然后在面板里启用。

## 目录约定

全部插件均为 Paseo 0.8 架构 —— 拆 client/server/shared 三目录：

```
plugins/
└── <plugin-name>/
    ├── paseo-plugin.json   # 需含 "requirements": {"paseo": ">=0.8.0"}
    ├── package.json
    ├── index.client.tsx    # contribute(client)：surface + sidebar
    ├── index.server.ts     # contribute(server)：注册 RPC handler
    ├── client/             # UI（react-native-web）
    ├── server/             # Node 后端逻辑
    ├── shared/             # contracts（defineRpc + zod）+ 静态数据
    └── README.md
```

## 贡献 / 分享自己的插件

1. Fork 本仓库
2. 在 `plugins/` 下新建你的插件目录（带上 `paseo-plugin.json` 和 README）
3. 提 PR

插件里**不要**提交 `node_modules/`、个人密钥、服务器地址等敏感信息（`.gitignore` 已挡掉常见情况，提交前请自查）。

## License

MIT
