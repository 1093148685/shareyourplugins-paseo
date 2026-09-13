// Shared preset registry: path resolution, provider adapters, manifest schema,
// dynamic scan of presets/ dirs. Imported by BOTH the daemon entry and the
// client bundle (via index.ts) — every fs touch lives inside functions that
// only the daemon calls; module evaluation stays side-effect free.
//
// Portability: set PRESET_SWITCHER_HOME (and optionally PRESET_SWITCHER_SKILLS)
// on a fresh machine. Without env vars we keep the legacy workspace if it
// exists, else fall back to ~/.paseo/preset-switcher.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { z } from "zod";

/** Original hardcoded workspace — kept so existing installs keep working. */
const LEGACY_HOME = "D:/document-address/paseo/workplace";

function readEnv(name: string): string | undefined {
  try {
    if (typeof process === "undefined" || !process.env) return undefined;
    const v = process.env[name];
    return v && v.trim() ? v.trim().replace(/\\/g, "/") : undefined;
  } catch {
    return undefined;
  }
}

function homeDir(): string {
  return readEnv("USERPROFILE") ?? readEnv("HOME") ?? ".";
}

function safeExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/** Root holding presets/ and the skills library. Override: PRESET_SWITCHER_HOME. */
export function presetHome(): string {
  const env = readEnv("PRESET_SWITCHER_HOME");
  if (env) return env;
  if (safeExists(LEGACY_HOME + "/presets")) return LEGACY_HOME;
  return homeDir() + "/.paseo/preset-switcher";
}

/** Shared skills library dir. Override: PRESET_SWITCHER_SKILLS. */
export function skillsDir(): string {
  const env = readEnv("PRESET_SWITCHER_SKILLS");
  if (env) return env;
  const home = presetHome();
  const legacy = home + "/.dsh-skills";
  if (safeExists(legacy)) return legacy;
  return home + "/skills";
}

export function presetsDir(): string {
  return presetHome() + "/presets";
}

export function presetCwd(id: string): string {
  return presetsDir() + "/" + id;
}

// ── Provider adapters ─────────────────────────────────────────────────────────
// The daemon maps systemPrompt to each provider's native field, so persona
// injection is uniform. What differs per CLI is (a) which context file it
// reads from cwd, (b) how project-level skills are declared.

export interface ProviderAdapter {
  /** Context files the provider reads natively from cwd. */
  contextFiles: string[];
  /** How project skills are mounted for this provider. */
  skills: Array<"junction" | "pi-settings">;
}

export const PROVIDER_ADAPTERS: Record<string, ProviderAdapter> = {
  claude: { contextFiles: ["CLAUDE.md"], skills: ["junction"] },
  pi: { contextFiles: ["AGENTS.md"], skills: ["pi-settings"] },
  codex: { contextFiles: ["AGENTS.md"], skills: [] },
  opencode: { contextFiles: ["AGENTS.md"], skills: [] },
};

/** Unknown provider → write everything (max compatibility). */
export function adapterFor(provider: string): ProviderAdapter {
  return (
    PROVIDER_ADAPTERS[provider] ?? {
      contextFiles: ["CLAUDE.md", "AGENTS.md"],
      skills: ["junction", "pi-settings"],
    }
  );
}

// ── Manifest (preset.json) ────────────────────────────────────────────────────

export const manifestSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "id must be kebab-case (a-z0-9-)"),
  name: z.string().min(1),
  description: z.string().default(""),
  provider: z.string().default("claude"),
  model: z.string().min(1),
  modeId: z.string().default("bypassPermissions"),
  skills: z.array(z.string()).default([]),
});
export type PresetManifest = z.infer<typeof manifestSchema>;

export interface Preset extends PresetManifest {
  origin: "seed" | "imported";
  /** PERSONA.md content, with {{model}}/{{cwd}} unresolved. "" = plain agent. */
  personaTpl: string;
  /** EXTRA.md content — appended after persona in every generated context file. */
  extra: string;
  /** EXTRA.agents.md content — appended only in generated AGENTS.md. */
  agentsExtra: string;
  dir: string;
}

// ── Dynamic registry: scan presets/ for dirs carrying preset.json ────────────

export interface ScanResult {
  presets: Preset[];
  /** Dirs that had a preset.json we could not parse. Surfaced in the UI. */
  errors: Array<{ dir: string; error: string }>;
}

function readTextIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function scanPresets(seedIds: string[]): ScanResult {
  const root = presetsDir();
  const errors: ScanResult["errors"] = [];
  const presets: Preset[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { presets, errors };
  }
  for (const name of names) {
    const dir = root + "/" + name;
    const manifestPath = dir + "/preset.json";
    if (!safeExists(manifestPath)) continue;
    try {
      const manifest = manifestSchema.parse(JSON.parse(readTextIfExists(manifestPath)));
      presets.push({
        ...manifest,
        origin: seedIds.includes(manifest.id) ? "seed" : "imported",
        personaTpl: readTextIfExists(dir + "/PERSONA.md"),
        extra: readTextIfExists(dir + "/EXTRA.md"),
        agentsExtra: readTextIfExists(dir + "/EXTRA.agents.md"),
        dir,
      });
    } catch (err) {
      errors.push({ dir, error: String(err).slice(0, 300) });
    }
  }
  // Seeds first (stable order given by seedIds), then imported by id.
  presets.sort((a, b) => {
    const ai = seedIds.indexOf(a.id);
    const bi = seedIds.indexOf(b.id);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return a.id.localeCompare(b.id);
  });
  return { presets, errors };
}

// ── Per-preset skill readiness (replaces the old hardcoded SKILL_IDS check) ──

export function skillStatus(preset: Preset): { ready: boolean; missing: string[] } {
  const missing = preset.skills.filter(
    (s) => !safeExists(skillsDir() + "/" + s + "/SKILL.md"),
  );
  return { ready: missing.length === 0, missing };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

export const MD_HEADER =
  "<!-- 由 Paseo preset-switcher 生成（本文件为自动生成，请勿手改——\n" +
  "     改 PERSONA.md / EXTRA.md 后重新物化）。 -->\n";

/** Resolve {{model}}/{{cwd}} templates in the persona. */
export function renderPersona(preset: Preset, cwd: string): string {
  if (!preset.personaTpl.trim()) return "";
  return preset.personaTpl
    .replaceAll("{{model}}", preset.model)
    .replaceAll("{{cwd}}", cwd);
}

function buildBody(preset: Preset, persona: string, extra: string): string {
  if (!persona) {
    return `# ${preset.name}\n\n${preset.description || "标准编码助手。"}\n`;
  }
  let body = `${MD_HEADER}\n# ${preset.name}\n\n${persona}\n`;
  if (extra.trim()) body += `\n---\n\n${extra}\n`;
  body +=
    `\n---\n\n## 技能挂载\n\n` +
    (preset.skills.length > 0
      ? "本预设声明以下技能（挂载方式由 provider adapter 决定）：\n\n" +
        preset.skills.map((s) => `- ${s}\n`).join("") +
        "\n任务命中时先读对应 SKILL.md，再按其流程逐步执行。\n"
      : "无。\n");
  return body;
}

/** Generate the context files this preset's provider reads (per adapter). */
export function renderContextFiles(preset: Preset, cwd: string): Record<string, string> {
  const persona = renderPersona(preset, cwd);
  const adapter = adapterFor(preset.provider);
  const out: Record<string, string> = {};
  for (const file of adapter.contextFiles) {
    const extra =
      file === "AGENTS.md" && preset.agentsExtra.trim()
        ? `${preset.extra}\n\n${preset.agentsExtra}`
        : preset.extra;
    out[file] = buildBody(preset, persona, extra);
  }
  return out;
}
