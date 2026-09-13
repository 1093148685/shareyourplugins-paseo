// Shared RPC contracts. Imported by BOTH the server entry (index.server.ts) and
// the client surface (client/Surface.tsx). Node-free: only zod + @getpaseo/plugin,
// both of which Paseo provides to client bundles.
// RPC names must match /^[a-z][a-z0-9._-]*$/ (lowercase only).

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const presetShape = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string(),
  modeId: z.string(),
  skills: z.array(z.string()),
  /** "seed" = ships with the plugin, "imported" = user-added pack. */
  origin: z.enum(["seed", "imported"]),
  personaChars: z.number(),
  hasProtocol: z.boolean(),
  cwd: z.string(),
  /** Per-preset skill readiness (each declared skill has SKILL.md). */
  skillsReady: z.boolean(),
  missingSkills: z.array(z.string()),
});

export const listPresets = defineRpc({
  name: "presets.list",
  input: z.object({}),
  output: z.object({
    presets: z.array(presetShape),
    skillsDir: z.string(),
    /** Dirs under presets/ whose preset.json failed to parse. */
    scanErrors: z.array(z.object({ dir: z.string(), error: z.string() })),
  }),
});

export const previewPreset = defineRpc({
  name: "presets.preview",
  input: z.object({ presetId: z.string() }),
  output: z.object({
    presetId: z.string(),
    cwd: z.string(),
    persona: z.string(),
    personaChars: z.number(),
    skills: z.array(z.string()),
    skillsMounted: z.boolean(),
  }),
});

export const repairPreset = defineRpc({
  name: "presets.repair",
  input: z.object({ presetId: z.string().optional() }),
  output: z.object({
    repaired: z.array(
      z.object({
        id: z.string(),
        cwd: z.string(),
        junction: z.string(),
        skillsMounted: z.boolean(),
        wrote: z.array(z.string()),
      }),
    ),
  }),
});

export const createAgentWithPreset = defineRpc({
  name: "presets.create-agent",
  input: z.object({
    presetId: z.string(),
    prompt: z.string().optional(),
    cwdOverride: z.string().optional(),
  }),
  output: z.object({
    agentId: z.string(),
    presetName: z.string(),
    cwd: z.string(),
    provider: z.string(),
    personaChars: z.number(),
    skillsMounted: z.boolean(),
  }),
});

export const importPreset = defineRpc({
  name: "presets.import",
  input: z.object({ zipPath: z.string() }),
  output: z.object({
    id: z.string(),
    dir: z.string(),
    files: z.array(z.string()),
    skillsInstalled: z.array(z.string()),
    skillsSkipped: z.array(z.string()),
  }),
});

export const exportPreset = defineRpc({
  name: "presets.export",
  input: z.object({
    presetId: z.string(),
    destPath: z.string(),
  }),
  output: z.object({
    id: z.string(),
    destPath: z.string(),
    bytes: z.number(),
    files: z.number(),
  }),
});

export const removePreset = defineRpc({
  name: "presets.remove",
  input: z.object({ presetId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});
