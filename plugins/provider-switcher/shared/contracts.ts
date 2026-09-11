import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// ── Shared shapes (mirrors cc-switch src/types.ts) ─────────────────────────────

export const providerCategorySchema = z.enum([
  "official",
  "cn_official",
  "cloud_provider",
  "aggregator",
  "third_party",
  "custom",
]);
export type ProviderCategory = z.infer<typeof providerCategorySchema>;

export const usageScriptSchema = z.object({
  enabled: z.boolean().default(false),
  language: z.literal("javascript").default("javascript"),
  code: z.string().default(""),
  timeout: z.number().default(10),
  autoQueryInterval: z.number().default(5),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  accessToken: z.string().optional(),
  userId: z.string().optional(),
  templateType: z.string().optional(),
});
export type UsageScript = z.infer<typeof usageScriptSchema>;

export const providerMetaSchema = z.object({
  custom_endpoints: z.record(z.string(), z.object({
    url: z.string(),
    addedAt: z.number(),
    lastUsed: z.number().optional(),
  })).optional(),
  usage_script: usageScriptSchema.optional(),
  endpointAutoSelect: z.boolean().optional(),
  isPartner: z.boolean().optional(),
  apiKeyField: z.enum(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]).optional(),
  apiFormat: z.enum(["anthropic", "openai_chat", "openai_responses", "gemini_native"]).optional(),
  isFullUrl: z.boolean().optional(),
  liveConfigManaged: z.boolean().optional(),
}).partial();
export type ProviderMeta = z.infer<typeof providerMetaSchema>;

export const providerSchema = z.object({
  id: z.string(),
  name: z.string(),
  settingsConfig: z.record(z.string(), z.unknown()),
  websiteUrl: z.string().optional(),
  category: providerCategorySchema.optional(),
  createdAt: z.number().optional(),
  sortIndex: z.number().optional(),
  notes: z.string().optional(),
  isPartner: z.boolean().optional(),
  meta: providerMetaSchema.optional(),
  icon: z.string().optional(),
  iconColor: z.string().optional(),
});
export type Provider = z.infer<typeof providerSchema>;

// App identifiers we manage (cc-switch has 8+; we start with these 3)
export const appIdSchema = z.enum(["claude", "pi", "paseo"]);
export type AppId = z.infer<typeof appIdSchema>;

// App config for a single app: its provider list + which is "current"
export const appConfigSchema = z.object({
  providers: z.record(z.string(), providerSchema),
  current: z.string(),
});
export type AppConfig = z.infer<typeof appConfigSchema>;

// Live config snapshot — what's actually on disk right now
export const liveSnapshotSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  hash: z.string().optional(), // SHA256 of file contents
  parsed: z.record(z.string(), z.unknown()).optional(),
});
export type LiveSnapshot = z.infer<typeof liveSnapshotSchema>;

// Provider with live-state annotations for the UI
export const providerWithStatusSchema = providerSchema.extend({
  isCurrent: z.boolean(),
  inConfig: z.boolean().optional(),   // Pi: is it written into models.json?
  isDefault: z.boolean().optional(),  // Pi: does live defaults.provider point at it?
  apiUrl: z.string().optional(),      // resolved display URL
  usage: z.object({
    used: z.string().optional(),
    remaining: z.string().optional(),
    unit: z.string().optional(),
    fetchedAt: z.number().optional(),
    error: z.string().optional(),
  }).optional(),
});
export type ProviderWithStatus = z.infer<typeof providerWithStatusSchema>;

// Model fetched from a provider's /v1/models endpoint
export const fetchedModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
});
export type FetchedModel = z.infer<typeof fetchedModelSchema>;

// Speed-test result for one endpoint
export const endpointTestResultSchema = z.object({
  url: z.string(),
  latency: z.number().nullable(),
  status: z.number().optional(),
  error: z.string().nullable().optional(),
});
export type EndpointTestResult = z.infer<typeof endpointTestResultSchema>;

// Pi model entry (for PiProviderForm)
export const piModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.string()).optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
  thinkingLevelMap: z.record(z.string(), z.string()).optional(),
});
export type PiModel = z.infer<typeof piModelSchema>;

// Pi provider settings (settingsConfig for app=pi)
export const piProviderConfigSchema = z.object({
  providerKey: z.string().optional(),
  apiFormat: z.string().optional(), // e.g. "openai-completions"
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  compat: z.record(z.string(), z.unknown()).optional(),
  models: z.array(piModelSchema).optional(),
}).partial();
export type PiProviderConfig = z.infer<typeof piProviderConfigSchema>;

// Claude provider settings (settingsConfig for app=claude)
export const claudeProviderConfigSchema = z.object({
  env: z.object({
    ANTHROPIC_BASE_URL: z.string().optional(),
    ANTHROPIC_AUTH_TOKEN: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_DEFAULT_OPUS_MODEL: z.string().optional(),
    ANTHROPIC_DEFAULT_SONNET_MODEL: z.string().optional(),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: z.string().optional(),
  }).partial().optional(),
}).partial();
export type ClaudeProviderConfig = z.infer<typeof claudeProviderConfigSchema>;

// ── RPCs ──────────────────────────────────────────────────────────────────────

export const listProviders = defineRpc({
  name: "providers.list",
  input: z.object({ appId: appIdSchema }),
  output: z.object({
    providers: z.array(providerWithStatusSchema),
    current: z.string(),
  }),
});

export const getLiveSnapshot = defineRpc({
  name: "providers.live.get",
  input: z.object({ appId: appIdSchema }),
  output: liveSnapshotSchema,
});

export const addProvider = defineRpc({
  name: "providers.add",
  input: z.object({
    appId: appIdSchema,
    provider: providerSchema.omit({ id: true, createdAt: true }),
  }),
  output: z.object({ provider: providerSchema }),
});

export const editProvider = defineRpc({
  name: "providers.edit",
  input: z.object({
    appId: appIdSchema,
    id: z.string(),
    patch: providerSchema.partial().omit({ id: true, createdAt: true }),
  }),
  output: z.object({ provider: providerSchema }),
});

export const removeProvider = defineRpc({
  name: "providers.remove",
  input: z.object({ appId: appIdSchema, id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const switchProvider = defineRpc({
  name: "providers.switch",
  input: z.object({ appId: appIdSchema, id: z.string() }),
  output: z.object({ ok: z.boolean(), warnings: z.array(z.string()).optional() }),
});

export const importCurrent = defineRpc({
  name: "providers.import-current",
  input: z.object({ appId: appIdSchema }),
  output: z.object({ provider: providerSchema }),
});

export const fetchModels = defineRpc({
  name: "providers.fetch-models",
  input: z.object({
    baseUrl: z.string(),
    apiKey: z.string().optional(),
  }),
  output: z.object({
    models: z.array(fetchedModelSchema),
    error: z.string().optional(),
  }),
});

export const testEndpoints = defineRpc({
  name: "providers.test-endpoints",
  input: z.object({
    urls: z.array(z.string()),
    timeoutSecs: z.number().default(8),
  }),
  output: z.object({ results: z.array(endpointTestResultSchema) }),
});

export const reorderProviders = defineRpc({
  name: "providers.reorder",
  input: z.object({
    appId: appIdSchema,
    orderedIds: z.array(z.string()),
  }),
  output: z.object({ ok: z.boolean() }),
});

// Pi additive-mode: write provider into models.json (enable) or remove it
export const piEnable = defineRpc({
  name: "providers.pi.enable",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const piDisable = defineRpc({
  name: "providers.pi.disable",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

// Pi additive-mode: point live defaults at this provider (what Pi actually runs)
export const piSetDefault = defineRpc({
  name: "providers.pi.set-default",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});
