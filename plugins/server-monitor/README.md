# server-monitor

Paseo 插件：在一个面板里监控多台 VPS 的 **CPU / 内存 / 磁盘 / 网络**，SSH 采集，密钥与密码认证均可（密码用 AES-256-GCM 本地加密存储）。

## 功能

- 多服务器卡片式监控，实时刷新
- SSH 私钥 / 密码两种认证；Windows 下内置 `bin/plink.exe`，密码认证开箱即用
- 元数据管理：地区、规格、核数、标签、备注
- 附带 CLI（`manage.mjs`），适合让 AI 助手一键添加/导入服务器

## 快速开始

面板：Paseo 侧边栏「服务器监控」→ 添加服务器。

CLI（无需打开面板，也适合 AI 操作）：

```bash
node manage.mjs add --host <IP> --name <名称> --key <私钥路径> \
  [--user root] [--port 22] [--region Singapore] [--spec "2核 3.6GB"] [--cores 2] \
  [--tags "docker,live"] [--note "备注"]

node manage.mjs import-key <keyFile> <IP>   # 先把密钥包里的私钥拷进 keys 目录
node manage.mjs list                        # 列出所有服务器
node manage.mjs remove --host <IP>          # 删除（或 --id srv-xxx）
node manage.mjs path                        # 打印数据目录
```

添加后在 Paseo 面板刷新即见，无需重启 daemon。

## 数据与安全

- 数据文件：`~/.paseo/plugin-data/server-monitor/servers.json`（Windows 为 `%USERPROFILE%\.paseo\...`）
- 密码字段：`encPassword` = AES-256-GCM（`iv:tag:ciphertext` hex 三段），密钥在同目录 `.enc-key`（首次自动生成）
- **不要手改 servers.json**——有加密字段，统一用 `manage.mjs`

## 文件说明

| 文件 | 作用 |
|---|---|
| `manage.mjs` | CLI（添加/导入/删除服务器） |
| `monitor-backend.ts` | 插件后端（SSH 采集、加密） |
| `main.client.tsx` | 面板 UI |
| `contracts.ts` | RPC 契约（zod） |
| `index.ts` | 插件入口 |
| `AI-GUIDE.md` | 给 AI 助手的一页操作速查 |

修改代码后：`paseo plugin reload server-monitor`。只增删服务器不需要 reload。
