# provider-switcher

Paseo 0.8 插件 —— 在 Paseo 侧边栏直接管理 **Claude Code / Pi / Paseo** 三个应用的 API 提供商，不用再单独打开 cc-switch。

逻辑严格移植自 [cc-switch](https://github.com/farion1231/cc-switch)：预设一键添加、切换写入对应应用的 live 配置文件、原子写 + 自动备份。

## 安装

```bash
paseo plugin install github.com/1093148685/shareyourplugins-paseo:plugins/provider-switcher
```

要求 **Paseo >= 0.8.0**（0.8 新插件架构：`index.client.tsx` + `index.server.ts`）。
安装后侧边栏出现「提供商切换」入口；如未生效，重启一次 Paseo。

## 功能

- **三个应用 tab**：Claude Code / Pi / Paseo，各自独立的提供商列表
- **预设库**：16 个 Claude 预设 + 7 个 Pi 预设（Kimi、DeepSeek、智谱 GLM、硅基流动、OpenRouter、火山、千问、百度千帆……），选中后填 API Key 即可
- **导入当前配置**：把 live 配置里正在用的提供商一键收编成卡片
- **模型拉取**：填好 Key 后从提供商 API 拉真实模型列表，下拉选择
- **端点测速**：对 `endpointCandidates` 逐个测延迟，自动选最快
- **排序模式**：▲▼ 调整卡片顺序并持久化
- **安全写入**：所有 live 写入均为原子写（temp + rename），写前自动备份到 `backups/`

### 各应用的切换语义

| 应用 | live 配置 | 切换行为 |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | 覆写 `env.ANTHROPIC_*`（切换前清除全部旧 `ANTHROPIC_*` 键，避免残留污染），非 env 字段原样保留 |
| Pi | `~/.pi/agent/models.json` | **累加模式**：启用的提供商共存于 `providers{}`，实际生效的是 `defaults.provider`。卡片三态：未启用 →「启用」；已启用非默认 →「设为默认」；默认 →「使用中」。不想保留的可点「移除」从配置中删掉 |
| Paseo | `~/.paseo/config.json` | 写 `agents.providers.claude` |

## 数据位置

插件自己的数据（提供商卡片、排序、API Key）存在：

```
~/.paseo/plugin-data/provider-switcher/
├── claude-providers.json
├── pi-providers.json
├── paseo-providers.json
└── backups/          # 每次写 live 配置前的自动备份
```

**API Key 只存在你本机的上述文件里**，插件不联网上传任何凭证；仓库源码中的预设 `apiKey` 字段全部为空。

> MCP / 提示词两个 tab 目前是占位，后续版本开放。

## 开发

```bash
npm install          # 依赖全在 devDependencies（daemon 从源码打包，无运行时依赖）
npm run typecheck    # tsc --noEmit
paseo plugin install .
paseo plugin reload provider-switcher   # 只重启 server worker；UI 改动需切换 surface 或重启 Paseo
```

目录结构（0.8 插件规范）：

```
├── index.client.tsx        # contribute(client)：surface + sidebar
├── index.server.ts         # contribute(server)：注册 13 个 RPC
├── client/Surface.tsx      # 全部 UI（react-native-web）
├── server/provider-backend.ts  # 文件读写 / 切换 / 测速 / 模型拉取
├── shared/contracts.ts     # defineRpc + zod schema
└── shared/presets-data.ts  # 预设目录
```

### 添加自己的预设

编辑 `shared/presets-data.ts`：

- Claude 预设：`settingsConfig.env` 里填 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`（留空让用户填）/ 各 `ANTHROPIC_*_MODEL`
- Pi 预设：`settingsConfig` 填 `name` / `baseUrl` / `api`（`openai-completions` 或 `anthropic-messages`）/ `models[]`
- 注意 Claude 官方 DeepSeek 的 anthropic 兼容端点是 `https://api.deepseek.com/anthropic`（不带 `/anthropic` 的 `/v1/messages` 会 404）

## License

MIT
