import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// ── Shared shapes ──────────────────────────────────────────────────────────────

export const serverSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  sshPort: z.number(),
  authMethod: z.enum(["password", "key"]),
  status: z.enum(["online", "offline", "unknown"]),
  region: z.string(),
  spec: z.string(),
  cores: z.number(),
  cost: z.string(),
  tags: z.array(z.string()),
  note: z.string(),
  lastFetchedAt: z.number().optional(),
  lastError: z.string().optional(),
});
export type ServerSummary = z.infer<typeof serverSummarySchema>;

export const metricsSchema = z.object({
  serverId: z.string(),
  fetchedAt: z.number(),
  // Added "unknown" — backend emits it before first successful fetch
  status: z.enum(["online", "offline", "error", "unknown"]),
  error: z.string().optional(),
  cpu: z.object({ usage: z.number(), cores: z.number(), model: z.string() }).optional(),
  memory: z.object({ total: z.number(), used: z.number(), free: z.number() }).optional(),
  disk: z.array(z.object({
    mount: z.string(), total: z.number(), used: z.number(), free: z.number(),
  })).optional(),
  network: z.object({
    rx:     z.number(),           // cumulative bytes (used for delta calc)
    tx:     z.number(),
    rxRate: z.number().optional(), // bytes/sec — absent on first fetch
    txRate: z.number().optional(),
    iface:  z.string(),
  }).optional(),
  uptime: z.number().optional(),
  load: z.tuple([z.number(), z.number(), z.number()]).optional(),
  os: z.object({ name: z.string(), hostname: z.string(), arch: z.string() }).optional(),
});
export type Metrics = z.infer<typeof metricsSchema>;

// ── RPCs ───────────────────────────────────────────────────────────────────────

export const listServers = defineRpc({
  name: "monitor.servers.list",
  input: z.object({}),
  output: z.object({ servers: z.array(serverSummarySchema) }),
});

export const getMetrics = defineRpc({
  name: "monitor.metrics.get",
  input: z.object({
    ids: z.array(z.string()).optional(),
    forceRefresh: z.boolean().optional(),
  }),
  output: z.object({ metrics: z.array(metricsSchema) }),
});

export const getCredentials = defineRpc({
  name: "monitor.servers.credentials",
  input: z.object({ id: z.string() }),
  output: z.object({
    user: z.string(),
    password: z.string().optional(),
    keyPath: z.string().optional(),
  }),
});

export const addServer = defineRpc({
  name: "monitor.servers.add",
  input: z.object({
    name: z.string(),
    host: z.string(),
    sshPort: z.number().default(22),
    sshUser: z.string().default("root"),
    authMethod: z.enum(["password", "key"]),
    sshPassword: z.string().optional(),
    sshKeyPath: z.string().optional(),
    region: z.string().default(""),
    spec: z.string().default(""),
    cores: z.number().default(0),
    cost: z.string().default(""),
    tags: z.array(z.string()).default([]),
    note: z.string().default(""),
  }),
  output: z.object({ server: serverSummarySchema }),
});

export const editServer = defineRpc({
  name: "monitor.servers.edit",
  input: z.object({
    id: z.string(),
    name: z.string().optional(),
    host: z.string().optional(),
    sshPort: z.number().optional(),
    sshUser: z.string().optional(),
    authMethod: z.enum(["password", "key"]).optional(),
    sshPassword: z.string().optional(),
    sshKeyPath: z.string().optional(),
    region: z.string().optional(),
    spec: z.string().optional(),
    cores: z.number().optional(),
    cost: z.string().optional(),
    tags: z.array(z.string()).optional(),
    note: z.string().optional(),
  }),
  output: z.object({ server: serverSummarySchema }),
});

export const removeServer = defineRpc({
  name: "monitor.servers.remove",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const testServer = defineRpc({
  name: "monitor.servers.test",
  input: z.object({ id: z.string() }),
  output: z.object({
    ok: z.boolean(),
    latencyMs: z.number(),
    error: z.string().optional(),
  }),
});

// Test a connection without creating a server record
export const testNewConnection = defineRpc({
  name: "monitor.connection.test",
  input: z.object({
    host: z.string(),
    sshPort: z.number().default(22),
    sshUser: z.string().default("root"),
    authMethod: z.enum(["password", "key"]),
    sshPassword: z.string().optional(),
    sshKeyPath: z.string().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    latencyMs: z.number(),
    error: z.string().optional(),
  }),
});

// Self-monitoring: this plugin's own resource footprint
export const getSelfStats = defineRpc({
  name: "monitor.self.stats",
  input: z.object({}),
  output: z.object({
    pid: z.number(),
    uptimeSec: z.number(),
    rssMB: z.number(),
    heapMB: z.number(),
    cpuPct: z.number(),        // % since last call
    cpuTotalSec: z.number(),   // cumulative CPU seconds
    sshCalls: z.number(),
    sshErrors: z.number(),
    sshActive: z.number(),
    sshAvgMs: z.number(),
    sshLastMs: z.number(),
    muxHits: z.number(),       // polls served via an existing mux/share channel
    skipped: z.number(),       // polls suppressed by offline backoff
    servers: z.number(),
    cacheEntries: z.number(),
  }),
});
export type SelfStats = z.infer<typeof getSelfStats.output>;
