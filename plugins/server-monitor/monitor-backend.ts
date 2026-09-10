// Node-only backend — loaded via dynamic import() from index.ts handlers only.
// Zero npm dependencies: uses system OpenSSH (built-in on Win10+/macOS/Linux)
// and Node.js built-ins only.

import path from "node:path";
import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Metrics, ServerSummary } from "./contracts";

// ── Paths ──────────────────────────────────────────────────────────────────────

// Data lives under ~/.paseo/plugin-data/server-monitor — avoids relying on
// import.meta.url, which Paseo's bundler may leave undefined in CJS output.
const DATA_DIR = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? ".",
  ".paseo", "plugin-data", "server-monitor"
);
const CFG_FILE = path.join(DATA_DIR, "servers.json");
const KEY_FILE = path.join(DATA_DIR, ".enc-key");

// ── Types ──────────────────────────────────────────────────────────────────────

interface StoredServer {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  authMethod: "password" | "key";
  encPassword?: string;   // AES-256-GCM encrypted — never plaintext
  sshKeyPath?: string;
  region: string;
  spec: string;
  cores: number;
  cost: string;
  tags: string[];
  note: string;
}

// ── Encryption (AES-256-GCM) ───────────────────────────────────────────────────

function fileExists(p: string): boolean {
  try { fs.accessSync(p, fs.constants.F_OK); return true; } catch { return false; }
}

function masterKey(): Buffer {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fileExists(KEY_FILE)) {
    const k = randomBytes(32);
    fs.writeFileSync(KEY_FILE, k.toString("hex"), { mode: 0o600 });
    return k;
  }
  return Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "hex");
}

export function encryptSecret(plain: string): string {
  const iv  = randomBytes(12);
  const c   = createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("hex"), c.getAuthTag().toString("hex"), enc.toString("hex")].join(":");
}

export function decryptSecret(encoded: string): string {
  const [ivH, tagH, dataH] = encoded.split(":");
  const d = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivH, "hex"));
  d.setAuthTag(Buffer.from(tagH, "hex"));
  return Buffer.concat([d.update(Buffer.from(dataH, "hex")), d.final()]).toString("utf8");
}

// ── Config I/O ─────────────────────────────────────────────────────────────────

function loadAll(): StoredServer[] {
  if (!fileExists(CFG_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); }
  catch { return []; }
}

function saveAll(list: StoredServer[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(list, null, 2), "utf8");
}

// ── Metrics cache (in-memory only, never persisted) ────────────────────────────

const metricsCache = new Map<string, Metrics>();
// Previous network byte counters for per-interval rate calculation
const prevNetMap   = new Map<string, { rx: number; tx: number; ts: number }>();

// ── Self-monitoring: the plugin's own resource footprint ───────────────────────
// Lets the user verify whether THIS plugin is the cause of any Paseo lag.

const selfMon = {
  startedAt: Date.now(),
  sshCalls: 0,      // total child processes spawned (ssh/plink)
  sshErrors: 0,
  sshActive: 0,
  sshTotalMs: 0,
  sshLastMs: 0,
  prevCpu: process.cpuUsage(),
  prevCpuTs: Date.now(),
};

// execFile wrapper that accounts every SSH child process spawn + wall time.
// Note: child-process CPU is NOT included in process.cpuUsage() — only the
// Node daemon's own CPU. SSH children are short-lived (~50-200ms CPU each).
function execTimed(
  bin: string, args: string[], timeout: number,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
): void {
  const t0 = Date.now();
  selfMon.sshCalls++;
  selfMon.sshActive++;
  execFile(bin, args, { timeout }, (err, stdout, stderr) => {
    selfMon.sshActive--;
    const ms = Date.now() - t0;
    selfMon.sshTotalMs += ms;
    selfMon.sshLastMs = ms;
    if (err) selfMon.sshErrors++;
    cb(err, stdout ?? "", stderr ?? "");
  });
}

// ── System SSH helper ─────────────────────────────────────────────────────────
//
// Fix #1: ConnectTimeout=5 + execFile timeout cap = 5s connection + 12s total.
// Fix #3: No persistent connection state — system ssh manages OS-level TCP.
//         Each call reuses OS TCP connection caching naturally (ControlMaster).
//
// Requires: OpenSSH on PATH (built-in Win10 1809+, macOS, all Linux distros).
// Password auth: requires sshpass installed (optional; key auth recommended).

function resolveHome(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return p.replace(/^~/, home);
}

// Write a temporary password file for sshpass, return its path.
// We delete it immediately after use.
function writeTmpPass(password: string): string {
  const tmpFile = path.join(DATA_DIR, `.tmp-${randomBytes(6).toString("hex")}`);
  fs.writeFileSync(tmpFile, password, { mode: 0o600 });
  return tmpFile;
}

// ── Password-auth backends ─────────────────────────────────────────────────────
// Preference: bundled plink.exe (Windows) → plink on PATH → sshpass on PATH.

let _plinkPath: string | null | undefined;
function findPlink(): string | null {
  if (_plinkPath !== undefined) return _plinkPath;
  // 1) bundled next to the plugin source (dev / directory install)
  const candidates = [
    path.join(process.cwd(), "bin", "plink.exe"),
    path.join("D:\\document-address\\paseo\\workplace\\server-monitor", "bin", "plink.exe"),
  ];
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); _plinkPath = p; return p; } catch { /* next */ }
  }
  // 2) on PATH
  try { execFileSync("plink", ["--version"], { stdio: "pipe" }); _plinkPath = "plink"; return "plink"; } catch { /* next */ }
  _plinkPath = null;
  return null;
}

let _hasSshpass: boolean | undefined;
function hasSshpass(): boolean {
  if (_hasSshpass !== undefined) return _hasSshpass;
  try { execFileSync("sshpass", ["-V"], { stdio: "pipe" }); _hasSshpass = true; } catch { _hasSshpass = false; }
  return _hasSshpass;
}

// plink's -batch mode refuses to confirm new host keys, and on Windows the
// confirmation prompt reads from the console (not stdin), so `echo y |` hangs.
// Solution: TOFU via -hostkey. First attempt fails with the fingerprint in
// stderr; we parse it, pin it in hostkeys.json, and retry with -hostkey.
// Bonus: if the server's key ever changes, plink fails loudly = MITM detection.
const HOSTKEYS_FILE = path.join(DATA_DIR, "hostkeys.json");

function loadHostKeys(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(HOSTKEYS_FILE, "utf8")); }
  catch { return {}; }
}

function saveHostKey(host: string, port: number, fingerprint: string): void {
  const all = loadHostKeys();
  all[`${host}:${port}`] = fingerprint;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HOSTKEYS_FILE, JSON.stringify(all, null, 2), "utf8");
}

function getHostKey(host: string, port: number): string | undefined {
  return loadHostKeys()[`${host}:${port}`];
}

// Extract "SHA256:..." from plink's "host key is not cached" error output.
function parseFingerprint(stderr: string): string | null {
  const m = stderr.match(/ssh-\w+ \d+ (SHA256:[A-Za-z0-9+/=]+)/);
  return m ? m[1] : null;
}

function sshExec(srv: StoredServer, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const CONNECT_TIMEOUT = 5;   // seconds — SSH ConnectTimeout option
    const EXEC_TIMEOUT    = 12_000; // ms — execFile hard timeout (Fix #1)

    // Base SSH flags shared by all auth methods
    const sshFlags = [
      "-o", `ConnectTimeout=${CONNECT_TIMEOUT}`,  // Fix #1: 5s limit
      "-o", "StrictHostKeyChecking=accept-new",    // auto-accept new host keys
      "-o", "BatchMode=no",
      "-o", "LogLevel=ERROR",
      "-p", String(srv.sshPort ?? 22),
    ];

    let bin = "ssh";
    let args: string[];

    if (srv.authMethod === "key" && srv.sshKeyPath) {
      // ── Key auth: pure OpenSSH, no extra tools needed
      args = [
        ...sshFlags,
        "-i", resolveHome(srv.sshKeyPath),
        "-o", "PasswordAuthentication=no",
        `${srv.sshUser}@${srv.host}`,
        cmd,
      ];
    } else if (srv.authMethod === "password" && srv.encPassword) {
      // ── Password auth: plink (bundled/PATH) preferred, sshpass fallback
      const password = decryptSecret(srv.encPassword);
      const plink = findPlink();
      if (plink) {
        // TOFU via -hostkey: pinned fingerprint or first-connect auto-pin
        runPlink(plink, srv, password, cmd, EXEC_TIMEOUT)
          .then(resolve, reject);
        return;
      } else if (hasSshpass()) {
        const tmpPass = writeTmpPass(password);
        bin  = "sshpass";
        args = [
          "-f", tmpPass,
          "ssh",
          ...sshFlags,
          "-o", "PasswordAuthentication=yes",
          `${srv.sshUser}@${srv.host}`,
          cmd,
        ];
        setTimeout(() => { try { fs.unlinkSync(tmpPass); } catch { /* ignore */ } }, 3_000);
      } else {
        reject(new Error("密码认证需要 plink 或 sshpass，均未找到。请改用私钥认证。"));
        return;
      }
    } else {
      reject(new Error(
        srv.authMethod === "key"
          ? `私钥认证但未配置私钥路径，请编辑服务器补全`
          : `密码认证但未保存密码，请编辑服务器补全`
      ));
      return;
    }

    execTimed(bin, args, EXEC_TIMEOUT, (err, stdout, stderr) => {
      if (err) {
        // execFile puts the timeout error in err.code === 'ETIMEDOUT'
        const msg = (err as any).killed
          ? `Timeout after ${EXEC_TIMEOUT / 1000}s`
          : stderr?.trim() || err.message;
        reject(new Error(msg));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// Run plink with -hostkey pinning. On first contact with an unknown host,
// plink fails with the fingerprint in stderr — we pin it and retry once.
function runPlink(
  plink: string, srv: StoredServer, password: string,
  cmd: string, execTimeout: number,
): Promise<string> {
  const port = srv.sshPort ?? 22;
  const tmpPass = writeTmpPass(password);
  const cleanup = () => setTimeout(() => { try { fs.unlinkSync(tmpPass); } catch { /* ignore */ } }, 3_000);

  const attempt = (hostkey: string | undefined): Promise<string> =>
    new Promise((resolve, reject) => {
      const args = [
        "-ssh", "-batch",
        "-P", String(port),
        "-pwfile", tmpPass,
        ...(hostkey ? ["-hostkey", hostkey] : []),
        `${srv.sshUser}@${srv.host}`,
        cmd,
      ];
      execTimed(plink, args, execTimeout, (err, stdout, stderr) => {
        if (err) {
          const se = stderr?.trim() ?? "";
          // Unknown host key → pin fingerprint and retry once
          if (!hostkey && se.includes("host key is not cached")) {
            const fp = parseFingerprint(se);
            if (fp) {
              saveHostKey(srv.host, port, fp);
              cleanup();
              attempt(fp).then(resolve, reject);
              return;
            }
          }
          const msg = (err as any).killed ? `Timeout after ${execTimeout / 1000}s` : se || err.message;
          reject(new Error(msg));
        } else {
          resolve(stdout.trim());
        }
      });
    });

  return attempt(getHostKey(srv.host, port)).finally(cleanup);
}

// ── Metrics collection script ─────────────────────────────────────────────────
// The Python source is base64-encoded and piped through `base64 -d | python3`.
// This avoids ALL shell-quoting problems: the old `python3 -c "...multi-line..."`
// approach broke on Windows because Git's MSYS2 ssh.exe mangles embedded quotes,
// and the remote then saw `python3 -c` with no argument.

const PY_SRC = [
  "import json,os,time,platform,multiprocessing",
  "try:",
  " s1=open('/proc/stat').readline().split();time.sleep(0.25)",
  " s2=open('/proc/stat').readline().split()",
  " v1=[int(x) for x in s1[1:]];v2=[int(x) for x in s2[1:]]",
  " cpu=round((1-(v2[3]-v1[3])/(sum(v2)-sum(v1)))*100,1)",
  "except:cpu=0.0",
  "try:",
  " m={l.split()[0].rstrip(':'):int(l.split()[1]) for l in open('/proc/meminfo')}",
  " mt=m['MemTotal']*1024",
  " mf=(m.get('MemFree',0)+m.get('Buffers',0)+m.get('Cached',0)+m.get('SReclaimable',0))*1024",
  "except:mt=mf=0",
  "try:",
  " import shutil;d=shutil.disk_usage('/')",
  " dks=[{'mount':'/','total':d.total,'used':d.used,'free':d.free}]",
  "except:dks=[]",
  "try:up=float(open('/proc/uptime').read().split()[0])",
  "except:up=0.0",
  "try:ld=[float(x) for x in open('/proc/loadavg').read().split()[:3]]",
  "except:ld=[0.0,0.0,0.0]",
  "nr=nt=0;ni='eth0'",
  "try:",
  " for l in open('/proc/net/dev'):",
  "  p=l.split()",
  "  if len(p)>9 and p[0].strip(':') not in('lo','Inter','face'):",
  "   if ni=='eth0':ni=p[0].strip(':')",
  "   nr+=int(p[1]);nt+=int(p[9])",
  "except:pass",
  "try:cm=next((l.split(':')[1].strip() for l in open('/proc/cpuinfo') if 'model name' in l),'')",
  "except:cm=''",
  "print(json.dumps({'cpu':{'usage':cpu,'cores':multiprocessing.cpu_count(),'model':cm},",
  "'memory':{'total':mt,'used':mt-mf,'free':mf},'disk':dks,",
  "'network':{'rx':nr,'tx':nt,'iface':ni},'uptime':up,'load':ld,",
  "'os':{'name':platform.system()+' '+platform.release(),'arch':platform.machine(),'hostname':platform.node()}}))",
].join("\n");

const METRICS_PY = `echo ${Buffer.from(PY_SRC, "utf8").toString("base64")} | base64 -d | python3`;

async function collectMetrics(srv: StoredServer): Promise<Metrics> {
  const now = Date.now();
  try {
    const raw  = await sshExec(srv, METRICS_PY);
    const data = JSON.parse(raw);

    // Compute network rates from previous sample
    let network = data.network as Metrics["network"];
    if (network) {
      const prev = prevNetMap.get(srv.id);
      if (prev) {
        const elapsed = (now - prev.ts) / 1000;
        if (elapsed > 0 && elapsed < 300) {
          network = {
            ...network,
            rxRate: Math.max(0, (network.rx - prev.rx) / elapsed),
            txRate: Math.max(0, (network.tx - prev.tx) / elapsed),
          };
        }
      }
      prevNetMap.set(srv.id, { rx: network.rx, tx: network.tx, ts: now });
    }

    const snap: Metrics = {
      serverId: srv.id, fetchedAt: now, status: "online",
      ...data,
      network,
    };
    metricsCache.set(srv.id, snap);
    return snap;
  } catch (err: unknown) {
    const snap: Metrics = {
      serverId: srv.id, fetchedAt: now, status: "offline",
      error: err instanceof Error ? err.message : String(err),
    };
    metricsCache.set(srv.id, snap);
    return snap;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function listSummaries(): ServerSummary[] {
  return loadAll().map((s) => {
    const c = metricsCache.get(s.id);
    return {
      id: s.id, name: s.name, host: s.host, sshPort: s.sshPort,
      authMethod: s.authMethod,
      status: (c?.status === "online" ? "online"
             : c?.status === "offline" ? "offline"
             : "unknown") as "online" | "offline" | "unknown",
      region: s.region, spec: s.spec, cores: s.cores,
      cost: s.cost, tags: s.tags, note: s.note,
      lastFetchedAt: c?.fetchedAt,
      lastError: c?.error,
    };
  });
}

// Fix #2 lives on the client (refetchIntervalInBackground: false).
// Backend returns cache or re-fetches if stale > 20s.
export async function fetchMetrics(ids?: string[], force = false): Promise<Metrics[]> {
  const all     = loadAll();
  const targets = ids?.length ? all.filter((s) => ids.includes(s.id)) : all;

  const needsFetch = (s: StoredServer) => {
    if (force) return true;
    const c = metricsCache.get(s.id);
    return !c || Date.now() - c.fetchedAt > 20_000;
  };

  const results = await Promise.allSettled(
    targets.map((s) => needsFetch(s) ? collectMetrics(s) : Promise.resolve(metricsCache.get(s.id)!))
  );
  return results
    .map((r) => r.status === "fulfilled" ? r.value : null)
    .filter((x): x is Metrics => x !== null);
}

export function getCachedMetrics(ids?: string[]): Metrics[] {
  const all     = loadAll();
  const targets = ids?.length ? ids : all.map((s) => s.id);
  return targets
    .map((id) => metricsCache.get(id))
    .filter((x): x is Metrics => x !== undefined);
}

export function getServerCredentials(id: string) {
  const srv = loadAll().find((s) => s.id === id);
  if (!srv) throw new Error(`Server not found: ${id}`);
  return {
    user:     srv.sshUser,
    password: srv.encPassword ? decryptSecret(srv.encPassword) : undefined,
    keyPath:  srv.sshKeyPath,
  };
}

export function addServer(input: {
  name: string; host: string; sshPort: number; sshUser: string;
  authMethod: "password" | "key"; sshPassword?: string; sshKeyPath?: string;
  region: string; spec: string; cores: number; cost: string;
  tags: string[]; note: string;
}): ServerSummary {
  const list = loadAll();
  const id   = `srv-${Date.now()}`;
  const entry: StoredServer = {
    id, name: input.name, host: input.host,
    sshPort: input.sshPort, sshUser: input.sshUser,
    authMethod: input.authMethod,
    encPassword: input.sshPassword ? encryptSecret(input.sshPassword) : undefined,
    sshKeyPath:  input.sshKeyPath,
    region: input.region, spec: input.spec, cores: input.cores,
    cost: input.cost, tags: input.tags, note: input.note,
  };
  list.push(entry);
  saveAll(list);
  return {
    id, name: entry.name, host: entry.host, sshPort: entry.sshPort,
    authMethod: entry.authMethod, status: "unknown",
    region: entry.region, spec: entry.spec, cores: entry.cores,
    cost: entry.cost, tags: entry.tags, note: entry.note,
  };
}

export function editServer(
  id: string,
  patch: Partial<{
    name: string; host: string; sshPort: number; sshUser: string;
    authMethod: "password" | "key"; sshPassword: string; sshKeyPath: string;
    region: string; spec: string; cores: number; cost: string;
    tags: string[]; note: string;
  }>
): ServerSummary {
  const list = loadAll();
  const idx  = list.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error(`Server not found: ${id}`);
  const s = list[idx]!;
  if (patch.name       !== undefined) s.name       = patch.name;
  if (patch.host       !== undefined) s.host       = patch.host;
  if (patch.sshPort    !== undefined) s.sshPort    = patch.sshPort;
  if (patch.sshUser    !== undefined) s.sshUser    = patch.sshUser;
  if (patch.authMethod !== undefined) s.authMethod = patch.authMethod;
  if (patch.sshPassword) s.encPassword = encryptSecret(patch.sshPassword);
  if (patch.sshKeyPath !== undefined) s.sshKeyPath = patch.sshKeyPath;
  if (patch.region     !== undefined) s.region     = patch.region;
  if (patch.spec       !== undefined) s.spec       = patch.spec;
  if (patch.cores      !== undefined) s.cores      = patch.cores;
  if (patch.cost       !== undefined) s.cost       = patch.cost;
  if (patch.tags       !== undefined) s.tags       = patch.tags;
  if (patch.note       !== undefined) s.note       = patch.note;
  saveAll(list);
  const c = metricsCache.get(id);
  return {
    id: s.id, name: s.name, host: s.host, sshPort: s.sshPort,
    authMethod: s.authMethod,
    status: (c?.status ?? "unknown") as "online" | "offline" | "unknown",
    region: s.region, spec: s.spec, cores: s.cores,
    cost: s.cost, tags: s.tags, note: s.note,
    lastFetchedAt: c?.fetchedAt, lastError: c?.error,
  };
}

export function removeServer(id: string): void {
  saveAll(loadAll().filter((s) => s.id !== id));
  metricsCache.delete(id);
}

export async function testConnection(id: string) {
  const srv = loadAll().find((s) => s.id === id);
  if (!srv) throw new Error(`Server not found: ${id}`);
  const t0 = Date.now();
  try {
    await sshExec(srv, "echo ok");
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err: unknown) {
    return {
      ok: false, latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Test a connection without saving a server record (used by AddServerModal).
export async function testNewConnectionRaw(params: {
  host: string; sshPort: number; sshUser: string;
  authMethod: "password" | "key";
  sshPassword?: string; sshKeyPath?: string;
}) {
  const fake: StoredServer = {
    id: "__probe__", name: "__probe__",
    host: params.host, sshPort: params.sshPort, sshUser: params.sshUser,
    authMethod: params.authMethod,
    encPassword: params.sshPassword ? encryptSecret(params.sshPassword) : undefined,
    sshKeyPath: params.sshKeyPath,
    region: "", spec: "", cores: 0, cost: "", tags: [], note: "",
  };
  const t0 = Date.now();
  try {
    await sshExec(fake, "echo ok");
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err: unknown) {
    return {
      ok: false, latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Self-monitoring API ────────────────────────────────────────────────────────
// Reports this plugin process's own footprint so the user can judge whether
// the plugin is the cause of any Paseo slowdown.

export function getSelfStats() {
  const now  = Date.now();
  const cpu  = process.cpuUsage();
  const mem  = process.memoryUsage();

  // CPU% since last call (delta of cumulative microseconds / wall time)
  const wallUs  = Math.max(1, (now - selfMon.prevCpuTs) * 1000);
  const deltaUs = (cpu.user - selfMon.prevCpu.user) + (cpu.system - selfMon.prevCpu.system);
  const cpuPct  = Math.min(100, (deltaUs / wallUs) * 100);
  selfMon.prevCpu   = cpu;
  selfMon.prevCpuTs = now;

  return {
    pid:          process.pid,
    uptimeSec:    Math.round((now - selfMon.startedAt) / 1000),
    rssMB:        Math.round(mem.rss / 1048576 * 10) / 10,
    heapMB:       Math.round(mem.heapUsed / 1048576 * 10) / 10,
    cpuPct:       Math.round(cpuPct * 100) / 100,
    cpuTotalSec:  Math.round((cpu.user + cpu.system) / 1e6 * 10) / 10,
    sshCalls:     selfMon.sshCalls,
    sshErrors:    selfMon.sshErrors,
    sshActive:    selfMon.sshActive,
    sshAvgMs:     selfMon.sshCalls ? Math.round(selfMon.sshTotalMs / selfMon.sshCalls) : 0,
    sshLastMs:    selfMon.sshLastMs,
    servers:      loadAll().length,
    cacheEntries: metricsCache.size,
  };
}
