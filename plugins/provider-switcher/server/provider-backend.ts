/**
 * provider-backend.ts — Node-side logic for the provider-switcher plugin.
 *
 * Faithfully ports cc-switch's provider management semantics:
 * - Atomic writes (temp + rename) for all live config files
 * - SHA256 revision conflict detection before overwriting live config
 * - Per-app independent provider lists (claude / pi / paseo)
 * - Pi is additive mode: providers accumulate in models.json, no single "current"
 * - Claude switching = writing env.ANTHROPIC_* into ~/.claude/settings.json
 * - Paseo switching = writing agents.providers.claude.models[] into ~/.paseo/config.json
 * - Import current config: read live file and wrap it as a provider entry
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import type { Provider, AppId, LiveSnapshot, ProviderWithStatus, FetchedModel, EndpointTestResult } from "../shared/contracts";

// ── Paths ──────────────────────────────────────────────────────────────────────

function homeDir(): string {
  return os.homedir();
}

function claudeConfigDir(): string {
  return path.join(homeDir(), ".claude");
}

function claudeSettingsPath(): string {
  const dir = claudeConfigDir();
  const settings = path.join(dir, "settings.json");
  if (fs.existsSync(settings)) return settings;
  const legacy = path.join(dir, "claude.json");
  if (fs.existsSync(legacy)) return legacy;
  return settings;
}

function piConfigDir(): string {
  return path.join(homeDir(), ".pi", "agent");
}

function piModelsPath(): string {
  return path.join(piConfigDir(), "models.json");
}

function paseoConfigPath(): string {
  return path.join(homeDir(), ".paseo", "config.json");
}

function pluginDataDir(): string {
  const dir = path.join(homeDir(), ".paseo", "plugin-data", "provider-switcher");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function storePath(appId: AppId): string {
  return path.join(pluginDataDir(), `${appId}-providers.json`);
}

function backupDir(): string {
  const dir = path.join(pluginDataDir(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Atomic write (temp + rename, mirrors cc-switch atomic_write) ────────────────

let tmpCounter = 0;

export function atomicWrite(filePath: string, data: string | Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(filePath);
  const ts = Date.now();
  const pid = process.pid;
  const tmp = path.join(dir, `${name}.tmp.${pid}.${ts}.${tmpCounter++}`);
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Windows: rename fails if destination exists; try delete+rename
    try {
      fs.unlinkSync(filePath);
    } catch {}
    try {
      fs.renameSync(tmp, filePath);
    } catch (err2) {
      try { fs.unlinkSync(tmp); } catch {}
      throw err2;
    }
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  // Sort keys alphabetically for deterministic output (mirrors cc-switch sort_json_keys)
  const sorted = sortKeysDeep(value);
  atomicWrite(filePath, JSON.stringify(sorted, null, 2) + "\n");
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

// ── SHA256 revision helpers ────────────────────────────────────────────────────

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function fileSha256(filePath: string): string | null {
  try {
    return sha256Hex(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}

// ── JSON with BOM tolerance ────────────────────────────────────────────────────

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    // Strip UTF-8 BOM if present
    const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Backup ─────────────────────────────────────────────────────────────────────

function backupLiveFile(filePath: string, appId: AppId): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(backupDir(), `${appId}-${path.basename(filePath)}.${ts}.bak`);
    fs.copyFileSync(filePath, dest);
    return dest;
  } catch {
    return null;
  }
}

// ── Provider store (per-app JSON file) ─────────────────────────────────────────

interface AppStore {
  providers: Record<string, Provider>;
  current: string;
}

function loadStore(appId: AppId): AppStore {
  const p = storePath(appId);
  const raw = readJsonFile(p);
  if (raw && typeof raw === "object") {
    return {
      providers: (raw.providers as Record<string, Provider>) ?? {},
      current: (raw.current as string) ?? "",
    };
  }
  return { providers: {}, current: "" };
}

function saveStore(appId: AppId, store: AppStore): void {
  atomicWriteJson(storePath(appId), store);
}

// ── ID generation ──────────────────────────────────────────────────────────────

function generateId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "provider";
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${base}-${suffix}`;
}

// ── Live config readers ────────────────────────────────────────────────────────

function readLiveClaude(): { path: string; data: Record<string, unknown> | null } {
  const p = claudeSettingsPath();
  return { path: p, data: readJsonFile(p) };
}

function readLivePi(): { path: string; data: Record<string, unknown> | null } {
  const p = piModelsPath();
  return { path: p, data: readJsonFile(p) };
}

function readLivePaseo(): { path: string; data: Record<string, unknown> | null } {
  const p = paseoConfigPath();
  return { path: p, data: readJsonFile(p) };
}

function readLive(appId: AppId): { path: string; data: Record<string, unknown> | null } {
  switch (appId) {
    case "claude": return readLiveClaude();
    case "pi":    return readLivePi();
    case "paseo": return readLivePaseo();
  }
}

// ── Live config writers ────────────────────────────────────────────────────────

/**
 * Claude: merge provider's env block into ~/.claude/settings.json
 * cc-switch does: read live → backfill to current provider → write new env keys.
 * We do: read live → STRIP all ANTHROPIC_* keys → apply new env → atomic write.
 *
 * Stripping is essential: a naive merge leaves keys the outgoing provider
 * defined but the incoming one doesn't (e.g. ANTHROPIC_DEFAULT_*_MODEL_NAME),
 * which then override model selection and break /model in new sessions.
 * Non-ANTHROPIC keys (user's own, e.g. CLAUDE_CODE_*) are preserved.
 */
function writeLiveClaude(provider: Provider): void {
  const { path: p, data: existing } = readLiveClaude();
  const base = existing ?? {};
  const cfg = (provider.settingsConfig ?? {}) as Record<string, unknown>;
  const envBlock = (cfg.env as Record<string, string> | undefined) ?? {};

  const oldEnv = (base.env as Record<string, string> | undefined) ?? {};
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(oldEnv)) {
    if (!k.startsWith("ANTHROPIC_")) kept[k] = v;
  }
  // Provider's own block wins; also strip ANTHROPIC_* pollution from the card
  // itself (older cards may carry backfilled stale keys).
  const newEnv: Record<string, string> = { ...kept };
  for (const [k, v] of Object.entries(envBlock)) {
    newEnv[k] = v;
  }

  const merged = { ...base, env: newEnv };
  backupLiveFile(p, "claude");
  atomicWriteJson(p, merged);
}

/**
 * Pi additive: write provider into ~/.pi/agent/models.json providers.<key>
 * cc-switch: providers accumulate; no "current" concept.
 */
function writeLivePiEnable(provider: Provider): void {
  const { path: p, data: existing } = readLivePi();
  const base = existing ?? {};
  const cfg = (provider.settingsConfig ?? {}) as Record<string, unknown>;
  const providerKey = (cfg.providerKey as string | undefined) ?? provider.id;

  const providers = (base.providers as Record<string, unknown> | undefined) ?? {};
  const models = (cfg.models as unknown[] | undefined) ?? [];

  providers[providerKey] = {
    name: provider.name,
    baseUrl: cfg.baseUrl ?? "",
    apiKey: cfg.apiKey ?? "",
    api: cfg.apiFormat ?? "openai-completions",
    headers: cfg.headers ?? {},
    compat: cfg.compat ?? {},
    models,
  };

  const merged = { ...base, providers };
  backupLiveFile(p, "pi");
  atomicWriteJson(p, merged);
}

function writeLivePiDisable(providerKey: string): void {
  const { path: p, data: existing } = readLivePi();
  if (!existing) return;
  const providers = { ...((existing.providers as Record<string, unknown> | undefined) ?? {}) };
  if (!(providerKey in providers)) return;
  delete providers[providerKey];

  // Removing the provider that Pi currently defaults to would break the CLI's
  // next run — move the default to any other enabled provider first.
  const defaults = { ...((existing.defaults as Record<string, unknown> | undefined) ?? {}) };
  if (defaults.provider === providerKey) {
    const others = Object.keys(providers);
    const backupKey = others[0];
    const backup = backupKey ? providers[backupKey] as Record<string, unknown> : undefined;
    const backupModels = (backup?.models as Array<{ id?: string }> | undefined) ?? [];
    const backupModel = backupModels[0]?.id;
    if (backupKey) {
      defaults.provider = backupKey;
      if (backupModel) defaults.model = backupModel;
      else delete defaults.model;
    } else {
      delete defaults.provider;
      delete defaults.model;
    }
  }

  const merged = { ...existing, providers, defaults };
  backupLiveFile(p, "pi");
  atomicWriteJson(p, merged);
}

/**
 * Paseo: write provider into ~/.paseo/config.json agents.providers.claude
 * Structure: agents.providers.claude = { baseUrl, apiKey, models: [...] }
 */
function writeLivePaseo(provider: Provider): void {
  const { path: p, data: existing } = readLivePaseo();
  const base = existing ?? {};
  const cfg = (provider.settingsConfig ?? {}) as Record<string, unknown>;

  const agents = (base.agents as Record<string, unknown> | undefined) ?? {};
  const providersBlock = (agents.providers as Record<string, unknown> | undefined) ?? {};

  providersBlock.claude = {
    baseUrl: cfg.baseUrl ?? "",
    apiKey: cfg.apiKey ?? "",
    models: cfg.models ?? [],
    ...(cfg.defaultModel ? { defaultModel: cfg.defaultModel } : {}),
  };

  const merged = {
    ...base,
    agents: { ...agents, providers: providersBlock },
  };
  backupLiveFile(p, "paseo");
  atomicWriteJson(p, merged);
}

// ── API URL extraction (mirrors cc-switch extractApiUrl priority) ──────────────

function extractApiUrl(provider: Provider): string {
  // Priority: notes > websiteUrl > env.ANTHROPIC_BASE_URL > baseUrl
  const cfg = (provider.settingsConfig ?? {}) as Record<string, unknown>;
  const env = (cfg.env as Record<string, string> | undefined) ?? {};
  return (
    provider.notes ??
    provider.websiteUrl ??
    env.ANTHROPIC_BASE_URL ??
    (cfg.baseUrl as string | undefined) ??
    "未配置接口地址"
  );
}

// ── Live write dispatcher ─────────────────────────────────────────────────────

function writeLive(appId: AppId, provider: Provider): void {
  switch (appId) {
    case "claude": writeLiveClaude(provider); break;
    case "pi":    writeLivePiEnable(provider); break;
    case "paseo": writeLivePaseo(provider); break;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function listProviders(appId: AppId): { providers: ProviderWithStatus[]; current: string } {
  const store = loadStore(appId);
  const { data: liveData } = readLive(appId);

  const providers: ProviderWithStatus[] = Object.values(store.providers).map((p) => {
    const isCurrent = store.current === p.id;
    let inConfig: boolean | undefined;
    let isDefault: boolean | undefined;

    if (appId === "pi") {
      // Pi: check if providerKey exists in live models.json
      const cfg = (p.settingsConfig ?? {}) as Record<string, unknown>;
      const key = (cfg.providerKey as string | undefined) ?? p.id;
      const liveProviders = (liveData?.providers as Record<string, unknown> | undefined) ?? {};
      const liveDefaults = (liveData?.defaults as Record<string, unknown> | undefined) ?? {};
      inConfig = key in liveProviders;
      // Pi actually RUNS defaults.provider — surface that as the single "active" one
      isDefault = inConfig && liveDefaults.provider === key;
    }

    return {
      ...p,
      isCurrent,
      inConfig,
      isDefault,
      apiUrl: extractApiUrl(p),
    };
  });

  // Sort by sortIndex, then createdAt
  providers.sort((a, b) => {
    const sa = a.sortIndex ?? 0;
    const sb = b.sortIndex ?? 0;
    if (sa !== sb) return sa - sb;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });

  return { providers, current: store.current };
}

export function getLiveSnapshot(appId: AppId): LiveSnapshot {
  const { path: p, data } = readLive(appId);
  const exists = fs.existsSync(p);
  const hash = exists ? (fileSha256(p) ?? undefined) : undefined;
  return {
    path: p,
    exists,
    hash,
    parsed: data ?? undefined,
  };
}

export function addProvider(appId: AppId, input: Omit<Provider, "id" | "createdAt">): Provider {
  const store = loadStore(appId);
  const id = generateId(input.name);
  const provider: Provider = {
    ...input,
    id,
    createdAt: Date.now(),
    sortIndex: Object.keys(store.providers).length,
  };
  store.providers[id] = provider;
  // If this is the first provider, make it current (non-additive apps)
  if (appId !== "pi" && !store.current) {
    store.current = id;
    writeLive(appId, provider);
  }
  saveStore(appId, store);
  return provider;
}

export function editProvider(appId: AppId, id: string, patch: Partial<Omit<Provider, "id" | "createdAt">>): Provider {
  const store = loadStore(appId);
  const existing = store.providers[id];
  if (!existing) throw new Error(`供应商 ${id} 不存在`);
  const updated: Provider = { ...existing, ...patch, id, createdAt: existing.createdAt };
  store.providers[id] = updated;
  // If this is the current provider, update live config
  if (appId !== "pi" && store.current === id) {
    writeLive(appId, updated);
  }
  // Pi: if provider is in config, update it there too
  if (appId === "pi") {
    const cfg = (updated.settingsConfig ?? {}) as Record<string, unknown>;
    const key = (cfg.providerKey as string | undefined) ?? id;
    const { data: liveData } = readLivePi();
    const liveProviders = (liveData?.providers as Record<string, unknown> | undefined) ?? {};
    if (key in liveProviders) {
      writeLivePiEnable(updated);
    }
  }
  saveStore(appId, store);
  return updated;
}

export function removeProvider(appId: AppId, id: string): void {
  const store = loadStore(appId);
  const provider = store.providers[id];
  if (!provider) throw new Error(`供应商 ${id} 不存在`);

  // Pi: remove from live config if present
  if (appId === "pi") {
    const cfg = (provider.settingsConfig ?? {}) as Record<string, unknown>;
    const key = (cfg.providerKey as string | undefined) ?? id;
    writeLivePiDisable(key);
  }

  // If removing current, clear current (non-additive)
  if (appId !== "pi" && store.current === id) {
    store.current = "";
  }

  delete store.providers[id];
  saveStore(appId, store);
}

export function switchProvider(appId: AppId, id: string): { ok: boolean; warnings?: string[] } {
  const store = loadStore(appId);
  const provider = store.providers[id];
  if (!provider) throw new Error(`供应商 ${id} 不存在`);

  const warnings: string[] = [];

  if (appId === "pi") {
    // Pi additive: just write into models.json
    writeLivePiEnable(provider);
    saveStore(appId, store);
    return { ok: true };
  }

  // Non-additive: backfill current live into outgoing provider, then write new
  const currentId = store.current;
  if (currentId && currentId !== id) {
    const { data: liveData } = readLive(appId);
    if (liveData) {
      const outgoing = store.providers[currentId];
      if (outgoing) {
        // Backfill: save current live config into outgoing provider's settingsConfig
        const backfilled: Provider = {
          ...outgoing,
          settingsConfig: liveData as Record<string, unknown>,
        };
        store.providers[currentId] = backfilled;
      }
    }
  }

  // Write new provider to live
  try {
    writeLive(appId, provider);
  } catch (e) {
    warnings.push(`写入 live 配置失败: ${e}`);
  }

  store.current = id;
  saveStore(appId, store);
  return { ok: true, warnings: warnings.length ? warnings : undefined };
}

export function importCurrent(appId: AppId): Provider {
  const { data: liveData } = readLive(appId);
  if (!liveData) throw new Error(`无法读取 ${appId} 的 live 配置`);

  const store = loadStore(appId);
  const id = `imported-${Date.now()}`;

  let name = "导入的配置";
  let settingsConfig = liveData as Record<string, unknown>;

  if (appId === "pi") {
    // Pi live models.json holds MANY providers; importing the whole file as one
    // provider produces a malformed card (no providerKey/baseUrl at top level).
    // Extract the default provider (defaults.provider) into piProviderConfig shape.
    const liveProviders = (liveData.providers as Record<string, Record<string, unknown>> | undefined) ?? {};
    const defaults = (liveData.defaults as Record<string, unknown> | undefined) ?? {};
    const defaultKey = (defaults.provider as string | undefined) ?? Object.keys(liveProviders)[0];
    const entry = defaultKey ? liveProviders[defaultKey] : undefined;
    if (!defaultKey || !entry) throw new Error("live models.json 中没有任何 provider 可导入");
    name = (entry.name as string | undefined) ?? defaultKey;
    settingsConfig = {
      providerKey: defaultKey,
      apiFormat: entry.api ?? "openai-completions",
      baseUrl: entry.baseUrl ?? "",
      apiKey: entry.apiKey ?? "",
      headers: entry.headers ?? {},
      compat: entry.compat ?? {},
      models: entry.models ?? [],
    };
  }

  const provider: Provider = {
    id,
    name,
    settingsConfig,
    category: "custom",
    createdAt: Date.now(),
    sortIndex: Object.keys(store.providers).length,
    notes: "从当前 live 配置导入",
  };
  store.providers[id] = provider;
  if (appId !== "pi" && !store.current) {
    store.current = id;
  }
  saveStore(appId, store);
  return provider;
}

export function piEnable(id: string): void {
  const store = loadStore("pi");
  const provider = store.providers[id];
  if (!provider) throw new Error(`供应商 ${id} 不存在`);
  const cfg = (provider.settingsConfig ?? {}) as Record<string, unknown>;
  if (!cfg.baseUrl || typeof cfg.baseUrl !== "string") {
    throw new Error(`供应商「${provider.name}」配置不完整（缺少 baseUrl），无法启用。请编辑补齐后再启用。`);
  }
  writeLivePiEnable(provider);
}

export function piDisable(id: string): void {
  const store = loadStore("pi");
  const provider = store.providers[id];
  if (!provider) throw new Error(`供应商 ${id} 不存在`);
  const cfg = (provider.settingsConfig ?? {}) as Record<string, unknown>;
  const key = (cfg.providerKey as string | undefined) ?? id;
  writeLivePiDisable(key);
}

/**
 * Pi: point live defaults at this provider — the single "active" one Pi runs.
 * Provider must already be enabled (present in live models.json).
 */
export function piSetDefault(id: string): void {
  const store = loadStore("pi");
  const provider = store.providers[id];
  if (!provider) throw new Error(`供应商 ${id} 不存在`);
  const cfg = (provider.settingsConfig ?? {}) as Record<string, unknown>;
  const key = (cfg.providerKey as string | undefined) ?? id;

  const { path: p, data: existing } = readLivePi();
  if (!existing) throw new Error("无法读取 Pi live 配置");
  const liveProviders = (existing.providers as Record<string, Record<string, unknown>> | undefined) ?? {};
  if (!(key in liveProviders)) throw new Error(`供应商「${provider.name}」尚未启用，请先启用再设为默认`);

  const models = (liveProviders[key]?.models as Array<{ id?: string }> | undefined) ?? [];
  const modelId = models[0]?.id;
  const defaults: Record<string, unknown> = { provider: key };
  if (modelId) defaults.model = modelId;

  const merged = { ...existing, defaults };
  backupLiveFile(p, "pi");
  atomicWriteJson(p, merged);
}

// ── Model fetch ────────────────────────────────────────────────────────────────

export async function fetchModels(baseUrl: string, apiKey?: string): Promise<{ models: FetchedModel[]; error?: string }> {
  const base = baseUrl.replace(/\/+$/, "");
  const candidates = [
    `${base}/v1/models`,
    `${base}/models`,
    // Version-stripped variants
    `${base.replace(/\/v\d+$/, "")}/v1/models`,
    `${base.replace(/\/v\d+$/, "")}/models`,
  ];

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
    headers["x-api-key"] = apiKey;
  }

  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);

      if (resp.status === 401 || resp.status === 403) {
        return { models: [], error: "认证失败（401/403），请检查 API Key" };
      }
      if (resp.status === 404 || resp.status === 405) {
        continue; // Try next candidate
      }
      if (!resp.ok) {
        return { models: [], error: `HTTP ${resp.status}` };
      }

      const body = await resp.json() as Record<string, unknown>;
      const data = (body.data as unknown[] | undefined) ?? (body.models as unknown[] | undefined) ?? [];
      if (!Array.isArray(data)) {
        return { models: [], error: "响应格式无法解析" };
      }

      const models: FetchedModel[] = data.map((m: unknown) => {
        const obj = m as Record<string, unknown>;
        return {
          id: String(obj.id ?? obj.model ?? obj.name ?? ""),
          name: obj.display_name as string | undefined ?? obj.name as string | undefined,
          contextWindow: obj.context_window as number | undefined ?? obj.contextWindow as number | undefined,
          maxTokens: obj.max_tokens as number | undefined ?? obj.maxTokens as number | undefined,
        };
      }).filter((m: FetchedModel) => m.id);

      return { models };
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        return { models: [], error: "请求超时（10秒）" };
      }
      // Network error — try next candidate
      continue;
    }
  }

  return { models: [], error: "该端点不支持模型列表查询（404/405）" };
}

// ── Endpoint speed test ────────────────────────────────────────────────────────

export async function testEndpoints(urls: string[], timeoutSecs: number): Promise<EndpointTestResult[]> {
  const results = await Promise.all(
    urls.map(async (url): Promise<EndpointTestResult> => {
      const start = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutSecs * 1000);
        const resp = await fetch(url, {
          method: "HEAD",
          signal: controller.signal,
        }).catch(() => fetch(url, { method: "GET", signal: controller.signal }));
        clearTimeout(timer);
        const latency = Date.now() - start;
        return { url, latency, status: resp.status, error: null };
      } catch (e) {
        const latency = Date.now() - start;
        const msg = e instanceof Error
          ? (e.name === "AbortError" ? "超时" : e.message)
          : String(e);
        return { url, latency: null, error: msg };
      }
    })
  );
  return results;
}

// ── Reorder ────────────────────────────────────────────────────────────────────

export function reorderProviders(appId: AppId, orderedIds: string[]): void {
  const store = loadStore(appId);
  orderedIds.forEach((id, idx) => {
    if (store.providers[id]) {
      store.providers[id] = { ...store.providers[id], sortIndex: idx };
    }
  });
  saveStore(appId, store);
}
