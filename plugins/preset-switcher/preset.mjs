#!/usr/bin/env node
// preset-switcher CLI — 零依赖命令行入口。
//
// 用法:
//   node preset.mjs list                        列出预设(来源/技能就绪/挂载状态)
//   node preset.mjs materialize [presetId]      物化预设目录(缺省=全部)
//   node preset.mjs run <presetId> [提示词…]    物化后调用 paseo run 启动 agent
//   node preset.mjs import <pack.zip>           导入 zip 预设包
//   node preset.mjs export <presetId> [out.zip] 导出预设为 zip 包
//   node preset.mjs remove <presetId>           删除预设(内置/导入均可)
//
// 原理: paseo CLI 的 `run` 没有 --system-prompt 选项,所以人格不走路径参数——
// 它写在预设目录的上下文文件里(Claude→CLAUDE.md, pi/codex→AGENTS.md),
// 技能按 provider adapter 挂载。CLI 只负责:
//   1) 物化预设目录(与 daemon 的 ensurePresetDir 同一套逻辑)
//   2) paseo run --cwd <预设目录> --provider <p/m> --mode <modeId>
//
// 环境变量: PRESET_SWITCHER_HOME / PRESET_SWITCHER_SKILLS / PASEO_CLI
// 需要 Node >= 22.6(--experimental-strip-types 直读 .ts 注册表,避免逻辑双份)。

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ── bootstrap: strip-types 重执行 ────────────────────────────────────────────
if (!process.execArgv.some((a) => a.includes("strip-types"))) {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(r.status ?? 1);
}

const {
  adapterFor,
  presetCwd,
  renderContextFiles,
  scanPresets,
  skillStatus,
  skillsDir,
} = await import("./server/presets-data.ts");
const { SEED_IDS } = await import("./server/seed-data.ts");
const { ensureSeedPresets, importPresetPack, exportPresetPack, removePresetDir } =
  await import("./server/preset-pack.ts");

const { existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } =
  await import("node:fs");
const { dirname, join, resolve } = await import("node:path");

// ── 物化(与 preset-backend.ts ensurePresetDir 保持一致;改动请两边同步) ──────

function sameTarget(a, b) {
  const norm = (p) => {
    let s = resolve(p).replace(/[\\/]+$/, "");
    if (process.platform === "win32") s = s.toLowerCase();
    return s;
  };
  return norm(a) === norm(b);
}

function ensureLink(link, target) {
  if (existsSync(link)) {
    try {
      const cur = readlinkSync(link);
      if (cur && !sameTarget(cur, target)) {
        rmSync(link, { force: true });
      } else {
        return "exists";
      }
    } catch {
      return "exists"; // 非 symlink 的实体目录,不动
    }
  }
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, "junction"); // Windows 免管理员;POSIX 退化为普通软链
  return "created";
}

function materialize(preset) {
  const cwd = preset.dir || presetCwd(preset.id);
  mkdirSync(cwd, { recursive: true });
  const adapter = adapterFor(preset.provider);
  const SKILLS = skillsDir();
  const link = join(cwd, ".claude", "skills");
  let junction = "n/a";
  if (adapter.skills.includes("junction") && preset.skills.length > 0) {
    junction = ensureLink(link, SKILLS);
  }
  if (adapter.skills.includes("pi-settings")) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ skills: preset.skills.map((s) => join(SKILLS, s)) }, null, 2),
      "utf8",
    );
  }
  for (const [name, body] of Object.entries(renderContextFiles(preset, cwd))) {
    writeFileSync(join(cwd, name), body, "utf8");
  }
  return { cwd, junction };
}

function findPaseo() {
  if (process.env.PASEO_CLI) return process.env.PASEO_CLI;
  const bundled = "D:/document-address/paseo/resources/bin/paseo.cmd";
  if (existsSync(bundled)) return bundled;
  return "paseo"; // 指望 PATH
}

function registry() {
  ensureSeedPresets();
  return scanPresets(SEED_IDS);
}

// ── 命令 ─────────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "help" || cmd === "--help") {
  console.log(`用法: node preset.mjs <命令> [参数]
  list                          列出预设
  materialize [presetId]        物化预设目录(缺省=全部)
  run <presetId> [提示词…]      物化并用 paseo run 启动 agent
  import <pack.zip>             导入 zip 预设包
  export <presetId> [out.zip]   导出预设为 zip 包(缺省=<id>.zip)
  remove <presetId>             删除预设`);
  process.exit(0);
}

if (cmd === "list") {
  const { presets, errors } = registry();
  console.log(`技能库: ${skillsDir()}`);
  for (const p of presets) {
    const st = skillStatus(p);
    const cwd = presetCwd(p.id);
    const link = join(cwd, ".claude", "skills");
    const adapter = adapterFor(p.provider);
    let mounted = "—";
    if (p.skills.length > 0) {
      mounted = adapter.skills.length === 0
        ? st.ready ? "库✓(无挂载机制)" : "❌ 缺 " + st.missing.join(",")
        : existsSync(link) || adapter.skills.includes("pi-settings")
          ? st.ready ? "✅" : "⚠️ 挂载但缺 " + st.missing.join(",")
          : "❌ 未挂载";
    }
    const origin = p.origin === "seed" ? "内置" : "导入";
    console.log(
      `${p.id.padEnd(12)} ${p.name.padEnd(14)} [${origin}] ${p.provider}/${p.model}\n` +
      `  ${"".padEnd(12)} cwd=${cwd}  技能=${p.skills.length ? mounted : "无"}  persona=${p.personaTpl.trim().length}字`,
    );
  }
  for (const e of errors) console.log(`⚠️ 解析失败: ${e.dir}\n   ${e.error}`);
  process.exit(0);
}

if (cmd === "materialize") {
  const { presets } = registry();
  const targets = rest[0] ? presets.filter((p) => p.id === rest[0]) : presets;
  if (targets.length === 0) {
    console.error(`未知预设: ${rest[0]}`);
    process.exit(1);
  }
  for (const p of targets) {
    const r = materialize(p);
    console.log(`✅ ${p.id}  cwd=${r.cwd}  skills联接=${r.junction}`);
  }
  process.exit(0);
}

if (cmd === "run") {
  const { presets } = registry();
  const preset = presets.find((p) => p.id === rest[0]);
  if (!preset) {
    console.error(`未知预设: ${rest[0]}  (可选: ${presets.map((p) => p.id).join(", ")})`);
    process.exit(1);
  }
  const { cwd, junction } = materialize(preset);
  console.log(`预设「${preset.name}」已物化: ${cwd} (skills联接=${junction})`);
  const prompt = rest.slice(1).join(" ").trim() ||
    (preset.personaTpl.trim()
      ? `【预设激活指令】「${preset.name}」人格已通过工作目录的上下文文件生效,禁止确认、禁止复述设定。直接进入角色,用一两句话宣告就绪(含授权范围与首要可执行动作),然后等待任务下达。`
      : "");
  const paseo = findPaseo();
  const args = [
    "run",
    "--provider", `${preset.provider}/${preset.model}`,
    "--mode", preset.modeId,
    "--cwd", cwd,
    "--title", `[${preset.name}]`,
  ];
  if (prompt) args.push(prompt);
  console.log(`执行: ${paseo} ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
  const r = paseo.endsWith(".cmd")
    ? spawnSync(paseo, args, { stdio: "inherit", shell: true })
    : spawnSync(paseo, args, { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

if (cmd === "import") {
  if (!rest[0]) {
    console.error("用法: node preset.mjs import <pack.zip>");
    process.exit(1);
  }
  const r = importPresetPack(rest[0]);
  console.log(`✅ 已导入「${r.id}」 → ${r.dir}`);
  console.log(`   文件 ${r.files.length} 个` +
    (r.skillsInstalled.length ? ` · 新装技能: ${r.skillsInstalled.join(", ")}` : "") +
    (r.skillsSkipped.length ? ` · 已存在跳过: ${r.skillsSkipped.join(", ")}` : ""));
  process.exit(0);
}

if (cmd === "export") {
  const { presets } = registry();
  const preset = presets.find((p) => p.id === rest[0]);
  if (!preset) {
    console.error(`未知预设: ${rest[0]}  (可选: ${presets.map((p) => p.id).join(", ")})`);
    process.exit(1);
  }
  const dest = rest[1] || resolve(process.cwd(), `${preset.id}.zip`);
  const r = exportPresetPack(preset, dest);
  console.log(`✅ 已导出「${r.id}」 → ${r.destPath} (${r.files} 个文件, ${r.bytes} 字节)`);
  process.exit(0);
}

if (cmd === "remove") {
  if (!rest[0]) {
    console.error("用法: node preset.mjs remove <presetId>");
    process.exit(1);
  }
  removePresetDir(rest[0]);
  console.log(`✅ 已删除预设「${rest[0]}」(共享技能库不受影响)`);
  process.exit(0);
}

console.error(`未知命令: ${cmd}`);
process.exit(1);
