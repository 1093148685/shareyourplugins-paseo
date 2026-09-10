#!/usr/bin/env node
// server-monitor CLI — add/list/remove servers without opening the Paseo UI.
// Zero dependencies (Node 18+). Shares data + encryption with the plugin backend.
//
// Usage:
//   node manage.mjs list
//   node manage.mjs add --name SG-2C --host 1.2.3.4 [--port 22] [--user root] \
//        [--key ~/.ssh/id_rsa | --password PASS] [--region Singapore] [--spec "2核 3.6GB"] \
//        [--cores 2] [--cost "¥180/月"] [--tags "docker,live"] [--note "..."]
//   node manage.mjs import-key <keyFile> <host>   # copy key into keys/ dir
//   node manage.mjs remove --id srv-123 | --host 1.2.3.4
//   node manage.mjs path                           # print data dir

import path from "node:path";
import fs from "node:fs";
import { createCipheriv, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ".";
const DATA_DIR = path.join(HOME, ".paseo", "plugin-data", "server-monitor");
const KEYS_DIR = path.join(DATA_DIR, "keys");
const CFG_FILE = path.join(DATA_DIR, "servers.json");
const KEY_FILE = path.join(DATA_DIR, ".enc-key");

function masterKey() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "hex");
}

function encryptSecret(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("hex"), c.getAuthTag().toString("hex"), enc.toString("hex")].join(":");
}

function loadAll() {
  if (!fs.existsSync(CFG_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); } catch { return []; }
}

function saveAll(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(list, null, 2), "utf8");
}

function args() {
  const out = { _: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else out._.push(argv[i]);
  }
  return out;
}

const a = args();
const cmd = a._[0];

switch (cmd) {
  case "list": {
    const list = loadAll();
    if (!list.length) { console.log("(no servers)"); break; }
    for (const s of list) {
      console.log(`${s.id}  ${s.name}  ${s.sshUser}@${s.host}:${s.sshPort}  [${s.authMethod}]  ${s.region} ${s.spec}  tags=${s.tags.join(",")}`);
    }
    console.log(`\n${list.length} server(s) · ${CFG_FILE}`);
    break;
  }

  case "add": {
    if (!a.host) { console.error("ERROR: --host is required"); process.exit(1); }
    const list = loadAll();
    if (list.some((s) => s.host === a.host)) {
      console.error(`ERROR: host ${a.host} already exists — use remove first or edit in UI`);
      process.exit(1);
    }
    let keyPath = a.key;
    if (keyPath) keyPath = keyPath.replace(/^~/, HOME);
    const entry = {
      id: `srv-${Date.now()}`,
      name: a.name || a.host,
      host: a.host,
      sshPort: parseInt(a.port) || 22,
      sshUser: a.user || "root",
      authMethod: a.password ? "password" : "key",
      encPassword: a.password ? encryptSecret(a.password) : undefined,
      sshKeyPath: a.password ? undefined : (keyPath || path.join(HOME, ".ssh", "id_rsa")),
      region: a.region || "",
      spec: a.spec || "",
      cores: parseInt(a.cores) || 0,
      cost: a.cost || "",
      tags: a.tags ? String(a.tags).split(",").map((t) => t.trim()).filter(Boolean) : [],
      note: a.note || "",
    };
    list.push(entry);
    saveAll(list);
    console.log(`OK added ${entry.id}  ${entry.sshUser}@${entry.host}:${entry.sshPort}`);
    console.log("Reload plugin in Paseo (or it picks up on next list refresh).");
    break;
  }

  case "import-key": {
    const [src, host] = a._.slice(1);
    if (!src || !host) { console.error("Usage: import-key <keyFile> <host>"); process.exit(1); }
    fs.mkdirSync(KEYS_DIR, { recursive: true });
    const dest = path.join(KEYS_DIR, path.basename(src).includes(host) ? path.basename(src) : `${host}.ed25519`);
    fs.copyFileSync(src.replace(/^~/, HOME), dest);
    try { fs.chmodSync(dest, 0o600); } catch { /* windows */ }
    console.log(`OK key copied -> ${dest}`);
    console.log(`Now: node manage.mjs add --host ${host} --key "${dest}" ...`);
    break;
  }

  case "remove": {
    const list = loadAll();
    const before = list.length;
    const kept = list.filter((s) => s.id !== a.id && s.host !== a.host);
    saveAll(kept);
    console.log(`OK removed ${before - kept.length} server(s)`);
    break;
  }

  case "path":
    console.log(DATA_DIR);
    break;

  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 13).join("\n"));
}
