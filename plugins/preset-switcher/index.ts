import type { PluginContext } from "@getpaseo/plugin";
import {
  createAgentWithPreset,
  exportPreset,
  importPreset,
  listPresets,
  previewPreset,
  removePreset,
  repairPreset,
} from "./contracts";
import { MainSurface } from "./main.client";

// ── Entry: NO top-level Node usage ───────────────────────────────────────────
// This module is bundled for BOTH the daemon (backend) and the Paseo renderer
// (client), because addSurface() registers a client component from here. The
// renderer stubs Node builtins, so any top-level fs/path call would throw at
// bundle-eval time.
//
// Therefore: all filesystem / process work lives in ./preset-backend and is
// pulled in with a dynamic import() INSIDE the handlers, which only ever run
// on the daemon. The client bundle never evaluates Node code.

async function backend() {
  return import("./preset-backend");
}

async function pack() {
  return import("./preset-pack");
}

export default function contribute(plugin: PluginContext) {
  plugin.handle(listPresets, async () => {
    const be = await backend();
    const { presets, errors } = be.listAllPresets();
    const { skillStatus, renderPersona, skillsDir } = await import("./presets-data");
    return {
      presets: presets.map((p) => {
        const st = skillStatus(p);
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          provider: p.provider,
          model: p.model,
          modeId: p.modeId,
          skills: p.skills,
          origin: p.origin,
          personaChars: renderPersona(p, p.dir).length,
          hasProtocol: p.extra.length > 0,
          cwd: p.dir,
          skillsReady: st.ready,
          missingSkills: st.missing,
        };
      }),
      skillsDir: skillsDir(),
      scanErrors: errors,
    };
  });

  plugin.handle(previewPreset, async ({ presetId }) => {
    const be = await backend();
    const { renderPersona } = await import("./presets-data");
    const preset = be.findPreset(presetId);
    if (!preset) throw new Error(`Unknown preset: ${presetId}`);
    const dir = be.ensurePresetDir(preset);
    const persona = renderPersona(preset, dir.cwd);
    return {
      presetId,
      cwd: dir.cwd,
      persona,
      personaChars: persona.length,
      skills: preset.skills,
      skillsMounted: dir.skillsMounted,
    };
  });

  plugin.handle(repairPreset, async ({ presetId }) => {
    const be = await backend();
    const all = be.listAllPresets().presets;
    const targets = presetId ? all.filter((p) => p.id === presetId) : all;
    if (targets.length === 0) throw new Error(`Unknown preset: ${presetId}`);
    return {
      repaired: targets.map((p) => {
        const d = be.ensurePresetDir(p);
        return {
          id: p.id,
          cwd: d.cwd,
          junction: d.junction,
          skillsMounted: d.skillsMounted,
          wrote: d.wrote,
        };
      }),
    };
  });

  plugin.handle(importPreset, async ({ zipPath }) => {
    const pk = await pack();
    return pk.importPresetPack(zipPath);
  });

  plugin.handle(exportPreset, async ({ presetId, destPath }) => {
    const be = await backend();
    const pk = await pack();
    const preset = be.findPreset(presetId);
    if (!preset) throw new Error(`Unknown preset: ${presetId}`);
    return pk.exportPresetPack(preset, destPath);
  });

  plugin.handle(removePreset, async ({ presetId }) => {
    const pk = await pack();
    pk.removePresetDir(presetId);
    return { ok: true };
  });

  plugin.handle(createAgentWithPreset, async ({ presetId, prompt, cwdOverride }, { paseo }) => {
    const be = await backend();
    const { renderPersona } = await import("./presets-data");
    const preset = be.findPreset(presetId);
    if (!preset) throw new Error(`Unknown preset: ${presetId}`);

    // Materialise first: the preset only "takes" if its dir carries the skills
    // junction, the pi skills array and the persona context files.
    const dir = be.ensurePresetDir(preset);
    const cwd = cwdOverride?.trim() || dir.cwd;
    const persona = renderPersona(preset, cwd);

    // Boot prompt design: NEVER ask the agent to "confirm" the preset — that
    // invites a generic meta-reply in default-assistant voice. The persona is
    // already live via systemPrompt + context files, so the first message
    // orders in-character behaviour directly. Persona-less presets get no
    // boot prompt at all: the agent is created idle and just waits.
    const bootPrompt = persona
      ? `【预设激活指令 · 非用户闲聊】「${preset.name}」人格已通过 system prompt 与工作目录的上下文文件生效，` +
        (preset.skills.length > 0
          ? `技能 ${preset.skills.join(", ")} 已挂载。`
          : "") +
        `禁止确认、禁止复述设定、禁止自我介绍为通用助手。\n` +
        `直接进入角色：以该角色的口吻与立场，用一两句话宣告就绪（含授权范围与首要可执行动作），然后等待任务下达。`
      : undefined;

    const agent = await paseo.agents.create({
      config: {
        provider: `${preset.provider}/${preset.model}`,
        modeId: preset.modeId,
        // Claude: appended to the claude_code preset prompt. pi: appended in
        // before_agent_start. codex: developer_instructions. Either way the
        // persona rides along.
        ...(persona ? { systemPrompt: persona } : {}),
      },
      cwd,
      title: `[${preset.name}]`,
      prompt: prompt?.trim() || bootPrompt,
    });

    return {
      agentId: agent.id,
      presetName: preset.name,
      cwd,
      provider: `${preset.provider}/${preset.model}`,
      personaChars: persona.length,
      skillsMounted: dir.skillsMounted,
    };
  });

  plugin.addSurface("main", MainSurface);
  plugin.addSidebarItem({
    id: "preset-switcher",
    title: "预设切换",
    icon: "Layers",
    surface: "main",
  });

  return () => {};
}
