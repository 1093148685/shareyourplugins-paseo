/**
 * index.server.ts — Plugin server entry for server-monitor.
 *
 * Registers the RPC handlers that bridge the client UI to the Node-only
 * monitor backend (ssh2, fs, crypto). UI registration lives in
 * index.client.tsx — Paseo >= 0.8 splits the two entry points.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import {
  listServers, getMetrics, getCredentials,
  addServer, editServer, removeServer, testServer, testNewConnection,
  getSelfStats,
} from "./shared/contracts";

// Dynamic import keeps Node-only code (ssh2, fs, crypto) out of the client bundle.
async function be() { return import("./server/monitor-backend"); }

export default function contribute(server: PluginServerContext) {

  // Returns only metadata + last-known status — always fast, no SSH.
  server.handle(listServers, async () => {
    const b = await be();
    return { servers: b.listSummaries() };
  });

  // Fetches/returns metrics; respects cache (stale > 20s triggers re-fetch).
  server.handle(getMetrics, async ({ ids, forceRefresh }) => {
    const b = await be();
    const metrics = await b.fetchMetrics(ids, forceRefresh ?? false);
    return { metrics };
  });

  // Decrypts credentials on-demand (only when user opens the detail modal).
  server.handle(getCredentials, async ({ id }) => {
    const b = await be();
    return b.getServerCredentials(id);
  });

  server.handle(addServer, async (input) => {
    const b = await be();
    return { server: b.addServer(input) };
  });

  server.handle(editServer, async ({ id, ...patch }) => {
    const b = await be();
    return { server: b.editServer(id, patch) };
  });

  server.handle(removeServer, async ({ id }) => {
    const b = await be();
    b.removeServer(id);
    return { ok: true };
  });

  server.handle(testServer, async ({ id }) => {
    const b = await be();
    return b.testConnection(id);
  });

  server.handle(testNewConnection, async (params) => {
    const b = await be();
    return b.testNewConnectionRaw(params);
  });

  // Self-monitoring: this plugin's own CPU/memory/SSH-call footprint
  server.handle(getSelfStats, async () => {
    const b = await be();
    return b.getSelfStats();
  });

  return () => {};
}
