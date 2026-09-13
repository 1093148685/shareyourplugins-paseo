# preset-switcher

Paseo 0.8 插件：一键以指定**人格 + 技能 + 模型**启动 agent。预设即数据——一个目录一个预设，扫描即注册；zip 预设包可导入导出，换机/分享直接带走。（要求 Paseo >= 0.8.0）

## 快速开始

**面板**：Paseo 侧边栏「预设切换」→ 点卡片选中 → 「启动此预设」。

**CLI**（无需打开面板）：

```bash
node preset.mjs list                        # 列出预设(来源/技能/persona 字数)
node preset.mjs run ctf-hunter "分析这个pcap"  # 物化目录 + paseo run 启动
node preset.mjs run pentest                 # 不带任务 → 发激活指令后待命
node preset.mjs materialize [id]            # 只重建目录文件(修复用)
node preset.mjs import web-recon.zip        # 导入预设包
node preset.mjs export ctf-hunter out.zip   # 导出(含引用技能,自包含)
node preset.mjs remove <id>                 # 删除预设(内置/导入均可)
```

需要 Node ≥ 22.6（用 `--experimental-strip-types` 直读 `.ts` 注册表，逻辑零重复）。

## 预设包格式（zip）

```
web-recon.zip
├── preset.json       # 必需：清单
├── PERSONA.md        # 可选：人格模板，支持 {{model}} / {{cwd}} 占位符
├── EXTRA.md          # 可选：额外上下文，追加在人格之后
├── EXTRA.agents.md   # 可选：仅追加进 AGENTS.md 的额外内容
├── CLAUDE.md         # 别名：导入时自动转为 EXTRA.md（兼容手打包）
├── AGENTS.md         # 别名：导入时自动转为 EXTRA.agents.md
└── skills/           # 可选：内嵌技能，导入时拷入共享技能库（已存在则跳过）
    └── my-skill/SKILL.md
```

`preset.json`：

```json
{
  "id": "web-recon",              // kebab-case，必填，全局唯一
  "name": "Web 侦察",              // 显示名
  "description": "…",
  "provider": "claude",           // claude / pi / codex / opencode / …
  "model": "claude-opus-5",
  "modeId": "bypassPermissions",  // 可省，缺省 bypassPermissions
  "skills": ["my-skill"]          // 可省，引用共享库或包内技能
}
```

约束：zip ≤ 64MB，单文件 ≤ 16MB，拒绝 `../` 路径穿越；包可以套一层同名顶层目录（zip 文件夹的常见情况），导入时自动剥掉。

## Provider 适配

daemon 会把 `systemPrompt` 映射到各 provider 的原生字段，人格注入是统一的；差异只在**上下文文件**和**技能挂载**，由 adapter 表决定：

| Provider | 上下文文件 | 技能挂载 |
|---|---|---|
| claude | `CLAUDE.md` | `.claude/skills` 目录联接 |
| pi | `AGENTS.md` | `.pi/settings.json` skills 数组 |
| codex | `AGENTS.md` | 无原生机制 |
| opencode | `AGENTS.md` | 无原生机制 |
| 未知 | 全写（CLAUDE.md + AGENTS.md） | 联接 + pi-settings 双挂 |

新增 provider = 在 `server/presets-data.ts` 的 `PROVIDER_ADAPTERS` 加一行。

## 目录结构

```
<presetHome>/
├── presets/
│   ├── .seeded.json        # 种子安装标记(删过的内置预设不会复活)
│   └── <id>/
│       ├── preset.json     # 源:清单
│       ├── PERSONA.md      # 源:人格(可手改,重新物化生效)
│       ├── EXTRA.md        # 源:额外上下文
│       ├── CLAUDE.md       # 生成:勿手改(头部有标记)
│       ├── AGENTS.md       # 生成:勿手改
│       ├── .claude/skills  # 生成:→ 共享技能库的联接
│       └── .pi/settings.json
└── .dsh-skills/ 或 skills/ # 共享技能库
```

**路径解析**（优先级从高到低）：

1. 环境变量 `PRESET_SWITCHER_HOME` / `PRESET_SWITCHER_SKILLS`
2. 遗留路径（老安装自动识别，零迁移）
3. `~/.paseo/preset-switcher`

## 内置预设（种子）

首次运行自动写入 `presets/`，之后就是普通预设——可改可删，删了不会复活。想换一批出厂预设：改 `seed-data.ts`（纯数据文件，无逻辑）。

## 移植到新机器

```bash
paseo plugin install <preset-switcher目录或git地址>
export PRESET_SWITCHER_HOME=/opt/presets       # 可选
export PRESET_SWITCHER_SKILLS=/opt/dsh-skills  # 指向技能库
# 或者用导出功能: 旧机 export 一圈 → 新机 import 一圈(技能随包走)
```

目标机需自行配好对应 provider（`paseo provider ls` 查看）。

## 文件说明（Paseo >= 0.8 架构）

| 文件 | 作用 |
|---|---|
| `server/presets-data.ts` | 路径解析、adapter 表、manifest schema、动态扫描注册（node-free，双端安全） |
| `server/seed-data.ts` | 内置预设内容（纯数据） |
| `server/preset-pack.ts` | zip 导入/导出/删除/种子安装（仅 daemon/CLI） |
| `server/preset-backend.ts` | 物化目录（adapter 驱动） |
| `server/zip.ts` | 零依赖 zip 读写（store 格式写出，deflate/store 读入） |
| `shared/contracts.ts` | RPC 契约（zod） |
| `index.server.ts` | daemon 端入口（RPC handler） |
| `index.client.tsx` | 客户端入口（surface + sidebar） |
| `client/Surface.tsx` | 面板 UI |
| `preset.mjs` | CLI 入口 |

修改代码后：`paseo plugin reload preset-switcher`。**只导入/删除预设不需要 reload**——注册表是扫描出来的。
