// Node-only backend — loaded via dynamic import() from index.server.ts handlers only.
// Zero npm dependencies: uses system OpenSSH (built-in on Win10+/macOS/Linux)
// and Node.js built-ins only.
//
// Resource-optimised (v0.4):
//   1. Config / master-key / host-key caches — no disk read on the hot path.
//   2. OpenSSH ControlMaster mux for key auth: one TCP+auth handshake, then
//      every metrics poll reuses the channel (~0.1-0.3s instead of 1-3s).
//   3. plink `-share` connection sharing for password auth (same idea).
//   4. Offline exponential backoff — dead servers stop burning spawn attempts.
//   5. Windows System32 OpenSSH preferred over Git's MSYS2 ssh (which mangles
//      quotes and spawns slower through the MSYS layer).

import path from "node:path";
import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Metrics, ServerSummary } from "../shared/contracts";

// ── Paths ──────────────────────────────────────────────────────────────────────

// Data lives under ~/.paseo/plugin-data/server-monitor — avoids relying on
// import.meta.url, which Paseo's bundler may leave undefined in CJS output.
const DATA_DIR = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? ".",
  ".paseo", "plugin-data", "server-monitor"
);
const CFG_FILE = path.join(DATA_DIR, "servers.json");
const KEY_FILE = path.join(DATA_DIR, ".enc-key");
const MUX_DIR  = path.join(DATA_DIR, "mux");

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

// ── Small cached-file helper ───────────────────────────────────────────────────
// Re-reads only when mtime changes; invalidates on delete. Kills the per-RPC
// readFileSync+JSON.parse churn that used to happen on every single call.

function fileExists(p: string): boolean {
  try { fs.accessSync(p, fs.constants.F_OK); return true; } catch { return false; }
}

const _cfgCache = { list: null as StoredServer[] | null, mtimeMs: -1 };

function loadAll(): StoredServer[] {
  try {
    const mtimeMs = fs.statSync(CFG_FILE).mtimeMs;
    if (_cfgCache.list && _cfgCache.mtimeMs === mtimeMs) return _cfgCache.list;
    const list = JSON.parse(fs.readFileSync(CFG_FILE, "utf8")) as StoredServer[];
    _cfgCache.list = list;
    _cfgCache.mtimeMs = mtimeMs;
    return list;
  } catch {
    _cfgCache.list = [];
    _cfgCache.mtimeMs = -1;
    return [];
  }
}

function saveAll(list: StoredServer[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(list, null, 2), "utf8");
  // Keep cache coherent with what we just wrote (mtime granularity is fine —
  // the next statSync will match because we wrote the file ourselves).
  try {
    _cfgCache.list = list;
    _cfgCache.mtimeMs = fs.statSync(CFG_FILE).mtimeMs;
  } catch { /* next read reparses */ }
}

// ── Encryption (AES-256-GCM) ───────────────────────────────────────────────────

let _masterKey: Buffer | null = null;
function masterKey(): Buffer {
  if (_masterKey) return _masterKey;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fileExists(KEY_FILE)) {
    const k = randomBytes(32);
    fs.writeFileSync(KEY_FILE, k.toString("hex"), { mode: 0o600 });
    _masterKey = k;
    return k;
  }
  _masterKey = Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "hex");
  return _masterKey;
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

// ── Metrics cache (in-memory only, never persisted) ────────────────────────────

const metricsCache = new Map<string, Metrics>();
// Previous network byte counters for per-interval rate calculation
const prevNetMap   = new Map<string, { rx: number; tx: number; ts: number }>();
// Offline backoff: consecutive failures → don't retry until `nextTryAt`.
// 1st fail: 60s, then 2m, 4m … capped at 10m. Reset on success / force-refresh.
const backoffMap   = new Map<string, { fails: number; nextTryAt: number }>();

// ── Self-monitoring: the plugin's own resource footprint ───────────────────────
// Lets the user verify whether THIS plugin is the cause of any Paseo lag.

const selfMon = {
  startedAt: Date.now(),
  sshCalls: 0,      // total child processes spawned (ssh/plink)
  sshErrors: 0,
  sshActive: 0,
  sshTotalMs: 0,
  sshLastMs: 0,
  muxHits: 0,       // polls served through an existing mux/share channel
  skipped: 0,       // polls suppressed by offline backoff
  prevCpu: process.cpuUsage(),
  prevCpuTs: Date.now(),
};

// execFile wrapper that accounts every SSH child process spawn + wall time.
// Note: child-process CPU is NOT included in process.cpuUsage() — only the
// Node daemon's own CPU. With mux sharing, most spawns are thin channel opens.
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

// ── SSH binary resolution ──────────────────────────────────────────────────────
// On Windows, prefer System32 OpenSSH over Git's MSYS2 ssh.exe: MSYS path
// translation mangles quoting and each spawn pays the MSYS layer startup cost.
// This also matches what 99% of users have on PATH in a real terminal.

let _sshBin: string | undefined;
function sshBin(): string {
  if (_sshBin) return _sshBin;
  if (process.platform === "win32") {
    const winSsh = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
    if (fileExists(winSsh)) { _sshBin = winSsh; return winSsh; }
  }
  _sshBin = "ssh";
  return _sshBin;
}

function resolveHome(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return p.replace(/^~/, home);
}

// Write a temporary password file for sshpass/plink, return its path.
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

const _hkCache = { map: null as Record<string, string> | null, mtimeMs: -1 };

function loadHostKeys(): Record<string, string> {
  try {
    const mtimeMs = fs.statSync(HOSTKEYS_FILE).mtimeMs;
    if (_hkCache.map && _hkCache.mtimeMs === mtimeMs) return _hkCache.map;
    const map = JSON.parse(fs.readFileSync(HOSTKEYS_FILE, "utf8")) as Record<string, string>;
    _hkCache.map = map;
    _hkCache.mtimeMs = mtimeMs;
    return map;
  } catch {
    _hkCache.map = {};
    _hkCache.mtimeMs = -1;
    return {};
  }
}

function saveHostKey(host: string, port: number, fingerprint: string): void {
  const all = { ...loadHostKeys(), [`${host}:${port}`]: fingerprint };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HOSTKEYS_FILE, JSON.stringify(all, null, 2), "utf8");
  try {
    _hkCache.map = all;
    _hkCache.mtimeMs = fs.statSync(HOSTKEYS_FILE).mtimeMs;
  } catch { /* next read reparses */ }
}

function getHostKey(host: string, port: number): string | undefined {
  return loadHostKeys()[`${host}:${port}`];
}

// Extract "SHA256:..." from plink's "host key is not cached" error output.
function parseFingerprint(stderr: string): string | null {
  const m = stderr.match(/ssh-\w+ \d+ (SHA256:[A-Za-z0-9+/=]+)/);
  return m ? m[1] : null;
}

// ── Connection reuse (the big CPU saver) ───────────────────────────────────────
// Key auth  → OpenSSH ControlMaster: first call to a host pays the handshake;
//             later polls open a channel on the existing mux (~100-300ms).
// Password  → plink -share: first plink process stays as the share master;
//             later plink calls reuse it. Same win.
// ControlPersist=300 keeps the master alive 5 min past last use, so a 45s
// poll cadence never re-handshakes in steady state.

function muxSocketPath(srv: StoredServer): string {
  // Socket path must stay short on Windows (OpenSSH_for_Windows uses named
  // pipes derived from this path) — hash the identity instead of embedding it.
  const h = Buffer.from(`${srv.sshUser}@${srv.host}:${srv.sshPort}`).toString("base64url").slice(0, 24);
  return path.join(MUX_DIR, `m-${h}`);
}

function muxAlive(srv: StoredServer): boolean {
  const sock = muxSocketPath(srv);
  if (!fileExists(sock)) return false;
  try {
    execFileSync(sshBin(), ["-S", sock, "-O", "check", `${srv.sshUser}@${srv.host}`], {
      stdio: "pipe", timeout: 4_000,
    });
    return true;
  } catch { return false; }
}

function sshExec(srv: StoredServer, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const CONNECT_TIMEOUT = 5;      // seconds — SSH ConnectTimeout option
    const EXEC_TIMEOUT    = 12_000; // ms — execFile hard timeout

    const sshFlags = [
      "-o", `ConnectTimeout=${CONNECT_TIMEOUT}`,
      "-o", "StrictHostKeyChecking=accept-new",    // auto-accept new host keys
      "-o", "BatchMode=no",
      "-o", "LogLevel=ERROR",
      "-p", String(srv.sshPort ?? 22),
    ];

    if (srv.authMethod === "key" && srv.sshKeyPath) {
      // ── Key auth: OpenSSH + ControlMaster mux
      const keyPath = resolveHome(srv.sshKeyPath);
      if (muxAlive(srv)) selfMon.muxHits++;
      const args = [
        ...sshFlags,
        "-i", keyPath,
        "-o", "PasswordAuthentication=no",
        "-o", "ControlMaster=auto",
        "-o", "ControlPersist=300",
        "-o", `ControlPath=${muxSocketPath(srv)}`,
        `${srv.sshUser}@${srv.host}`,
        cmd,
      ];
      fs.mkdirSync(MUX_DIR, { recursive: true });
      execTimed(sshBin(), args, EXEC_TIMEOUT, (err, stdout, stderr) => {
        if (err) reject(new Error(sshErrMsg(err, stderr, EXEC_TIMEOUT)));
        else resolve(stdout.trim());
      });
      return;
    }

    if (srv.authMethod === "password" && srv.encPassword) {
      // ── Password auth: plink (-share connection sharing) or sshpass fallback
      const password = decryptSecret(srv.encPassword);
      const plink = findPlink();
      if (plink) {
        runPlink(plink, srv, password, cmd, EXEC_TIMEOUT).then(resolve, reject);
        return;
      }
      if (hasSshpass()) {
        const tmpPass = writeTmpPass(password);
        const args = [
          "-f", tmpPass,
          "ssh",
          ...sshFlags,
          "-o", "PasswordAuthentication=yes",
          `${srv.sshUser}@${srv.host}`,
          cmd,
        ];
        setTimeout(() => { try { fs.unlinkSync(tmpPass); } catch { /* ignore */ } }, 3_000);
        execTimed("sshpass", args, EXEC_TIMEOUT, (err, stdout, stderr) => {
          if (err) reject(new Error(sshErrMsg(err, stderr, EXEC_TIMEOUT)));
          else resolve(stdout.trim());
        });
        return;
      }
      reject(new Error("密码认证需要 plink 或 sshpass，均未找到。请改用私钥认证。"));
      return;
    }

    reject(new Error(
      srv.authMethod === "key"
        ? `私钥认证但未配置私钥路径，请编辑服务器补全`
        : `密码认证但未保存密码，请编辑服务器补全`
    ));
  });
}

// Trim noisy SSH stderr to a compact one-liner (remote MOTD banners and
// full command echoes used to balloon error strings into the KB range).
function sshErrMsg(err: Error, stderr: string | undefined, timeoutMs: number): string {
  if ((err as any).killed) return `Timeout after ${timeoutMs / 1000}s`;
  const lines = (stderr ?? "").trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? err.message;
  return last.length > 200 ? `${last.slice(0, 200)}…` : last;
}

// Run plink with -hostkey pinning + -share connection reuse. On first contact
// with an unknown host, plink fails with the fingerprint in stderr — we pin it
// and retry once.
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
        "-share",                       // reuse an existing plink share session when up
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
          reject(new Error(sshErrMsg(err, stderr, execTimeout)));
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
    backoffMap.delete(srv.id);   // success → clear backoff
    return snap;
  } catch (err: unknown) {
    const snap: Metrics = {
      serverId: srv.id, fetchedAt: now, status: "offline",
      error: err instanceof Error ? err.message : String(err),
    };
    metricsCache.set(srv.id, snap);
    // Exponential backoff: 1min → 2 → 4 → … capped at 10min
    const b = backoffMap.get(srv.id) ?? { fails: 0, nextTryAt: 0 };
    const fails = b.fails + 1;
    const waitMs = Math.min(600_000, 60_000 * 2 ** (fails - 1));
    backoffMap.set(srv.id, { fails, nextTryAt: now + waitMs });
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

// Client polls on a 45s cadence; cache is considered fresh for 40s so the
// steady state is exactly one muxed SSH call per server per client interval.
export async function fetchMetrics(ids?: string[], force = false): Promise<Metrics[]> {
  const all     = loadAll();
  const targets = ids?.length ? all.filter((s) => ids.includes(s.id)) : all;
  const now     = Date.now();

  const needsFetch = (s: StoredServer) => {
    if (force) { backoffMap.delete(s.id); return true; }
    const c = metricsCache.get(s.id);
    if (c && now - c.fetchedAt <= 40_000) return false;
    // Offline backoff: don't hammer dead servers
    const b = backoffMap.get(s.id);
    if (b && now < b.nextTryAt) {
      selfMon.skipped++;
      return false;
    }
    return true;
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
  const identityChanged =
    (patch.host !== undefined && patch.host !== s.host) ||
    (patch.sshPort !== undefined && patch.sshPort !== s.sshPort) ||
    (patch.sshUser !== undefined && patch.sshUser !== s.sshUser) ||
    (patch.authMethod !== undefined && patch.authMethod !== s.authMethod) ||
    !!patch.sshPassword ||
    (patch.sshKeyPath !== undefined && patch.sshKeyPath !== s.sshKeyPath);
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
  if (identityChanged) {
    // Kill stale mux + backoff so the next poll dials the new identity fresh
    killMux(s);
    backoffMap.delete(id);
    metricsCache.delete(id);
  }
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

// Tell the mux master to exit and drop the socket file. Best-effort.
function killMux(srv: StoredServer): void {
  const sock = muxSocketPath(srv);
  if (!fileExists(sock)) return;
  try {
    execFileSync(sshBin(), ["-S", sock, "-O", "exit", `${srv.sshUser}@${srv.host}`], {
      stdio: "pipe", timeout: 4_000,
    });
  } catch { /* already dead */ }
  try { fs.unlinkSync(sock); } catch { /* ignore */ }
}

export function removeServer(id: string): void {
  const srv = loadAll().find((s) => s.id === id);
  saveAll(loadAll().filter((s) => s.id !== id));
  metricsCache.delete(id);
  backoffMap.delete(id);
  prevNetMap.delete(id);
  if (srv) killMux(srv);
}

export async function testConnection(id: string) {
  const srv = loadAll().find((s) => s.id === id);
  if (!srv) throw new Error(`Server not found: ${id}`);
  backoffMap.delete(id);   // explicit user action → retry immediately
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
  } finally {
    // Probe used a one-shot mux socket — don't leave it behind
    killMux(fake);
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
    muxHits:      selfMon.muxHits,
    skipped:      selfMon.skipped,
    servers:      loadAll().length,
    cacheEntries: metricsCache.size,
  };
}
