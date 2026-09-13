// BACKEND-ONLY: preset pack import / export / remove / seed.
// A preset pack is a zip with this layout:
//
//   preset.json       required manifest (see manifestSchema)
//   PERSONA.md        optional persona template ({{model}}/{{cwd}} resolved live)
//   EXTRA.md          optional extra context, appended after the persona
//   EXTRA.agents.md   optional extra appended only in generated AGENTS.md
//   CLAUDE.md         alias for EXTRA.md (convenience for hand-made packs)
//   AGENTS.md         alias for EXTRA.agents.md
//   skills/<id>/**    optional embedded skills, copied into the shared library
//
// The pack may be wrapped in a single top-level directory (the common case
// when zipping a folder) — the wrapper is stripped on import.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  manifestSchema,
  presetCwd,
  presetsDir,
  skillsDir,
  type Preset,
  type PresetManifest,
} from "./presets-data.ts";
import { SEED_PRESETS, type SeedPreset } from "./seed-data.ts";
import { buildZip, extractZip } from "./zip.ts";

const MAX_ZIP_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

export interface ImportResult {
  id: string;
  dir: string;
  files: string[];
  skillsInstalled: string[];
  skillsSkipped: string[];
}

export interface ExportResult {
  id: string;
  destPath: string;
  bytes: number;
  files: number;
}

/** Reject absolute paths, drive letters and `..` traversal. */
function safeEntryName(name: string): boolean {
  if (!name || name.startsWith("/") || name.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(name)) return false;
  return !name.split(/[\\/]/).some((seg) => seg === "..");
}

/** If every entry sits under one top-level dir, strip that wrapper. */
function stripCommonPrefix(files: Map<string, Buffer>): Map<string, Buffer> {
  const names = [...files.keys()];
  if (names.length === 0) return files;
  const first = names[0];
  const slash = first.indexOf("/");
  if (slash === -1) return files;
  const prefix = first.slice(0, slash + 1);
  if (!names.every((n) => n.startsWith(prefix))) return files;
  const out = new Map<string, Buffer>();
  for (const [n, b] of files) out.set(n.slice(prefix.length), b);
  return out;
}

function writeFileSafe(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

/** Copy embedded skills/<id>/** into the shared skills library (skip existing). */
function installEmbeddedSkills(
  files: Map<string, Buffer>,
): { installed: string[]; skipped: string[] } {
  const installed: string[] = [];
  const skipped: string[] = [];
  const bySkill = new Map<string, Array<[string, Buffer]>>();
  for (const [name, data] of files) {
    const m = /^skills\/([^/]+)\/(.+)$/.exec(name);
    if (!m) continue;
    const list = bySkill.get(m[1]) ?? [];
    list.push([m[2], data]);
    bySkill.set(m[1], list);
  }
  for (const [skill, entries] of bySkill) {
    const target = join(skillsDir(), skill);
    if (existsSync(target)) {
      skipped.push(skill);
      continue;
    }
    for (const [rel, data] of entries) writeFileSafe(join(target, rel), data);
    installed.push(skill);
  }
  return { installed, skipped };
}

export function importPresetPack(zipPath: string): ImportResult {
  const buf = readFileSync(zipPath);
  if (buf.length > MAX_ZIP_BYTES) {
    throw new Error(`pack too large: ${buf.length} bytes (max ${MAX_ZIP_BYTES})`);
  }
  const raw = stripCommonPrefix(extractZip(buf));

  for (const [name, data] of raw) {
    if (!safeEntryName(name)) throw new Error(`unsafe entry name in pack: "${name}"`);
    if (data.length > MAX_ENTRY_BYTES) {
      throw new Error(`entry "${name}" too large (max ${MAX_ENTRY_BYTES} bytes)`);
    }
  }

  const manifestBuf = raw.get("preset.json");
  if (!manifestBuf) throw new Error("pack is missing preset.json at its root");
  const manifest = manifestSchema.parse(JSON.parse(manifestBuf.toString("utf8")));

  const dir = presetCwd(manifest.id);
  if (existsSync(join(dir, "preset.json"))) {
    throw new Error(`preset "${manifest.id}" already exists — remove it first`);
  }

  // Map convenience aliases to the canonical source filenames.
  if (!raw.has("EXTRA.md") && raw.has("CLAUDE.md")) {
    raw.set("EXTRA.md", raw.get("CLAUDE.md")!);
    raw.delete("CLAUDE.md");
  }
  if (!raw.has("EXTRA.agents.md") && raw.has("AGENTS.md")) {
    raw.set("EXTRA.agents.md", raw.get("AGENTS.md")!);
    raw.delete("AGENTS.md");
  }

  const written: string[] = [];
  for (const [name, data] of raw) {
    writeFileSafe(join(dir, name), data);
    written.push(name);
  }

  const { installed, skipped } = installEmbeddedSkills(raw);
  return { id: manifest.id, dir, files: written, skillsInstalled: installed, skillsSkipped: skipped };
}

function walkFiles(root: string, rel = ""): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const abs = join(root, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(abs, r));
    else out.push([r, abs]);
  }
  return out;
}

/** Bundle a scanned preset back into a pack (manifest + sources + skills). */
export function exportPresetPack(preset: Preset, destPath: string): ExportResult {
  const files = new Map<string, Buffer>();
  const manifest: PresetManifest = {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    provider: preset.provider,
    model: preset.model,
    modeId: preset.modeId,
    skills: preset.skills,
  };
  files.set("preset.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
  if (preset.personaTpl.trim()) files.set("PERSONA.md", Buffer.from(preset.personaTpl, "utf8"));
  if (preset.extra.trim()) files.set("EXTRA.md", Buffer.from(preset.extra, "utf8"));
  if (preset.agentsExtra.trim()) files.set("EXTRA.agents.md", Buffer.from(preset.agentsExtra, "utf8"));

  // Bundle the referenced skills from the shared library so the pack is portable.
  for (const skill of preset.skills) {
    const src = join(skillsDir(), skill);
    if (!existsSync(src)) continue;
    for (const [rel, abs] of walkFiles(src)) {
      files.set(`skills/${skill}/${rel}`, readFileSync(abs));
    }
  }

  const zip = buildZip(files);
  writeFileSafe(destPath, zip);
  return { id: preset.id, destPath, bytes: zip.length, files: files.size };
}

export function removePresetDir(id: string): { shellLeft: boolean } {
  const dir = presetCwd(id);
  if (!existsSync(join(dir, "preset.json"))) {
    throw new Error(`unknown preset: ${id}`);
  }
  // Detach the skills junction first: a live junction can hold locks on the
  // target library and confuse rimraf's recursion on Windows.
  try {
    rmSync(join(dir, ".claude", "skills"), { force: true });
  } catch {
    // best-effort
  }
  // Windows 现实: 只要还有进程把该目录当 cwd(已归档 agent 的残留进程、
  // daemon 的 watcher),rmdir/rename 都会 EBUSY,但删内容不受阻。
  // 策略: 先清空内容(preset.json 一删,注册表立即除名),再尽力 rmdir;
  // rmdir 失败就留下空壳,等 daemon 重启后自然可删——不影响功能。
  let shellLeft = false;
  try {
    for (const entry of readdirSync(dir)) {
      rmSync(join(dir, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  } catch {
    shellLeft = true;
  }
  return { shellLeft };
}

// ── First-run seeding ─────────────────────────────────────────────────────────
// Marker file records which seed ids were already installed, so deleted seeds
// stay deleted and plugin upgrades only add NEW seeds.

const SEED_MARKER = ".seeded.json";

function readSeededMarker(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(presetsDir(), SEED_MARKER), "utf8"));
    return Array.isArray(parsed?.seeded) ? parsed.seeded : [];
  } catch {
    return [];
  }
}

function writeSeedSources(seed: SeedPreset): void {
  const dir = presetCwd(seed.manifest.id);
  writeFileSafe(join(dir, "preset.json"), JSON.stringify(seed.manifest, null, 2));
  if (seed.personaTpl) writeFileSafe(join(dir, "PERSONA.md"), seed.personaTpl);
  if (seed.extra) writeFileSafe(join(dir, "EXTRA.md"), seed.extra);
  if (seed.agentsExtra) writeFileSafe(join(dir, "EXTRA.agents.md"), seed.agentsExtra);
}

/** Install any not-yet-seeded presets. Idempotent; never overwrites personas. */
export function ensureSeedPresets(): string[] {
  mkdirSync(presetsDir(), { recursive: true });
  const done = readSeededMarker();
  const newly: string[] = [];
  for (const seed of SEED_PRESETS) {
    if (done.includes(seed.manifest.id)) continue;
    // Missing dir → full seed. Existing dir without preset.json (legacy
    // install) → backfill sources only; generated files get rewritten by the
    // next materialize anyway, and user-edited sources are never clobbered
    // because a legacy dir cannot contain them.
    writeSeedSources(seed);
    newly.push(seed.manifest.id);
  }
  if (newly.length > 0) {
    writeFileSafe(
      join(presetsDir(), SEED_MARKER),
      JSON.stringify({ seeded: [...done, ...newly] }, null, 2),
    );
  }
  return newly;
}
