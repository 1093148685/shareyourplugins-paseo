import type { PluginContext } from "@getpaseo/plugin";
import {
  listServers, getMetrics, getCredentials,
  addServer, editServer, removeServer, testServer, testNewConnection,
  getSelfStats,
} from "./contracts";
import { MonitorSurface } from "./main.client";

// Dynamic import keeps Node-only code (ssh2, fs, crypto) out of the client bundle.
async function be() { return import("./monitor-backend"); }

export default function contribute(plugin: PluginContext) {

  // Returns only metadata + last-known status — always fast, no SSH.
  plugin.handle(listServers, async () => {
    const b = await be();
    return { servers: b.listSummaries() };
  });

  // Fetches/returns metrics; respects cache (stale > 20s triggers re-fetch).
  plugin.handle(getMetrics, async ({ ids, forceRefresh }) => {
    const b = await be();
    const metrics = await b.fetchMetrics(ids, forceRefresh ?? false);
    return { metrics };
  });

  // Decrypts credentials on-demand (only when user opens the detail modal).
  plugin.handle(getCredentials, async ({ id }) => {
    const b = await be();
    return b.getServerCredentials(id);
  });

  plugin.handle(addServer, async (input) => {
    const b = await be();
    return { server: b.addServer(input) };
  });

  plugin.handle(editServer, async ({ id, ...patch }) => {
    const b = await be();
    return { server: b.editServer(id, patch) };
  });

  plugin.handle(removeServer, async ({ id }) => {
    const b = await be();
    b.removeServer(id);
    return { ok: true };
  });

  plugin.handle(testServer, async ({ id }) => {
    const b = await be();
    return b.testConnection(id);
  });

  plugin.handle(testNewConnection, async (params) => {
    const b = await be();
    return b.testNewConnectionRaw(params);
  });

  // Self-monitoring: this plugin's own CPU/memory/SSH-call footprint
  plugin.handle(getSelfStats, async () => {
    const b = await be();
    return b.getSelfStats();
  });

  plugin.addSurface("main", MonitorSurface);
  plugin.addSidebarItem({
    id: "server-monitor",
    title: "服务器监控",
    icon: "Monitor",
    surface: "main",
  });

  return () => {};
}
