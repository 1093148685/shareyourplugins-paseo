// BACKEND-ONLY module. Uses Node APIs (fs / path).
// Loaded via dynamic import() from inside RPC handlers, so it never enters the
// client bundle's top-level evaluation. No top-level Node calls (only imports
// and function declarations) to stay init-safe.

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  adapterFor,
  presetCwd,
  renderContextFiles,
  renderPersona,
  scanPresets,
  skillStatus,
  skillsDir,
  type Preset,
} from "./presets-data.ts";
import { SEED_IDS } from "./seed-data.ts";
import { ensureSeedPresets } from "./preset-pack.ts";

// Cross-platform directory link: Node's symlinkSync with type "junction" works
// on Windows WITHOUT admin rights (unlike cmd mklink /D) and degrades to a
// plain symlink on Linux/macOS. No cmd.exe dependency → server-safe.
function ensureJunction(link: string, target: string): string {
  if (existsSync(link)) return "exists";
  mkdirSync(dirname(link), { recursive: true });
  try {
    symlinkSync(target, link, "junction");
    return "created";
  } catch (err) {
    return `failed: ${String(err).slice(0, 160)}`;
  }
}

/** Scan the registry, seeding built-ins on first run. */
export function listAllPresets() {
  ensureSeedPresets();
  return scanPresets(SEED_IDS);
}

export function findPreset(id: string): Preset | undefined {
  return listAllPresets().presets.find((p) => p.id === id);
}

/** Idempotently materialise a preset's working directory (adapter-driven). */
export function ensurePresetDir(preset: Preset): {
  cwd: string;
  skillsMounted: boolean;
  junction: string;
  wrote: string[];
} {
  const cwd = preset.dir || presetCwd(preset.id);
  mkdirSync(cwd, { recursive: true });
  const wrote: string[] = [];
  const adapter = adapterFor(preset.provider);
  const SKILLS = skillsDir();

  // 1. Skills mount, per adapter.
  let junction = "n/a";
  const link = join(cwd, ".claude", "skills");
  if (adapter.skills.includes("junction") && preset.skills.length > 0) {
    junction = ensureJunction(link, SKILLS);
  } else if (existsSync(link)) {
    try {
      rmSync(link, { recursive: false, force: true });
      junction = "removed";
    } catch {
      junction = "remove-failed";
    }
  }

  if (adapter.skills.includes("pi-settings")) {
    const piSkills = preset.skills.map((s) => join(SKILLS, s));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ skills: piSkills }, null, 2),
      "utf8",
    );
    wrote.push(".pi/settings.json");
  }

  // 2. Context files the provider reads natively (CLAUDE.md / AGENTS.md / …).
  //    The persona also rides the daemon's systemPrompt channel; these files
  //    are the fallback that works from any CLI (`paseo run --cwd …`).
  const files = renderContextFiles(preset, cwd);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(cwd, name), body, "utf8");
    wrote.push(name);
  }

  const skillsMounted =
    preset.skills.length === 0 ||
    (adapter.skills.length === 0
      ? skillStatus(preset).ready // provider has no mount mechanism; library presence is all we can check
      : junction === "exists" || junction === "created" || existsSync(link));

  return { cwd, skillsMounted, junction, wrote };
}

export { renderPersona, skillsDir };
