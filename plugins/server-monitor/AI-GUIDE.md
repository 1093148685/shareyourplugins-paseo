# server-monitor — AI 操作速查

> 给 AI 助手看的一页纸。**不要**重新研究这个目录的源码，按本文档直接操作。

## 这是什么

Paseo 插件，监控多台服务器的 CPU/内存/磁盘/网络。UI 在 Paseo 侧边栏「服务器监控」。

## 快速添加服务器（首选）

```bash
cd <插件目录>/server-monitor
node manage.mjs add --host <IP> --name <名称> \
  --key <私钥绝对路径> \
  [--user root] [--port 22] \
  [--region Singapore] [--spec "2核 3.6GB"] [--cores 2] \
  [--tags "docker,live"] [--note "备注"]
```

- 私钥是 tar/zip 包里的 → 先 `node manage.mjs import-key <keyFile> <IP>` 拷进 keys 目录
- 密码认证 → `--password <密码>`（AES-256-GCM 加密存储；插件内置 `bin/plink.exe`，Windows 密码认证开箱即用）
- 添加后提示用户在 Paseo 里刷新面板即可（数据文件共享，无需重启 daemon）

## 其他命令

```bash
node manage.mjs list              # 列出所有服务器
node manage.mjs remove --host <IP>  # 或 --id srv-xxx
node manage.mjs path              # 打印数据目录
```

## 手动方式（不推荐，仅在 manage.mjs 不可用时）

数据文件：`%USERPROFILE%\.paseo\plugin-data\server-monitor\servers.json`（UTF-8 JSON 数组）。

每条记录字段（全部必填除非标注可选）：

```json
{
  "id": "srv-<13位毫秒时间戳>",
  "name": "显示名",
  "host": "1.2.3.4",
  "sshPort": 22,
  "sshUser": "root",
  "authMethod": "key",
  "sshKeyPath": "私钥绝对路径（key 认证必填）",
  "encPassword": "iv:tag:ciphertext 十六进制三段（password 认证必填，见加密节）",
  "region": "Singapore",
  "spec": "2核 3.6GB",
  "cores": 2,
  "cost": "",
  "tags": ["docker"],
  "note": ""
}
```

### 加密（encPassword）

AES-256-GCM，密钥在同目录 `.enc-key`（hex 编码 32 字节，不存在则生成）。
格式：`iv_hex:authTag_hex:ciphertext_hex`（iv 12 字节随机）。参考 `server/monitor-backend.ts` 的 `encryptSecret`。

## 常见任务配方

**用户给一个 tar.gz 密钥包**（如 small_vps_*.tar.gz）：
1. `python -c` 或 tar 列出内容，读 README 拿到 IP/规格/地区表
2. `node manage.mjs import-key <提取的key> <IP>` 每台一次
3. `node manage.mjs add ...` 每台一次（region/spec/cores/note 照抄 README）
4. 告知用户刷新 Paseo 面板

**用户口头报一台服务器**：直接 `manage.mjs add` 一条命令搞定。

## 目录结构（了解即可，勿修改）

| 文件 | 作用 |
|---|---|
| `manage.mjs` | 本 CLI（你主要用这个） |
| `server/monitor-backend.ts` | 插件后端（SSH 采集、加密），由 daemon 加载 |
| `client/Surface.tsx` | UI，React Native |
| `shared/contracts.ts` | RPC 契约 |
| `index.server.ts` / `index.client.tsx` | 插件入口（Paseo >= 0.8 双入口） |

修改插件代码后需要 `paseo plugin reload server-monitor`。
**只加服务器不需要 reload**——manage.mjs 直接写数据文件。
