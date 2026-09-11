/**
 * index.server.ts — Plugin server entry for provider-switcher.
 *
 * Registers the 12 RPC handlers that bridge the client UI to the Node-only
 * provider backend (filesystem, atomic writes, HTTP for model fetch / speed test).
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import {
  listProviders, getLiveSnapshot,
  addProvider, editProvider, removeProvider,
  switchProvider, importCurrent,
  fetchModels, testEndpoints,
  reorderProviders, piEnable, piDisable, piSetDefault,
} from "./shared/contracts";

// Dynamic import keeps Node-only code (fs, crypto, os) out of the client bundle.
async function be() { return import("./server/provider-backend"); }

export default function contribute(server: PluginServerContext) {
  server.handle(listProviders, async (input: RpcInput<typeof listProviders>) => {
    const b = await be();
    return b.listProviders(input.appId);
  });

  server.handle(getLiveSnapshot, async (input: RpcInput<typeof getLiveSnapshot>) => {
    const b = await be();
    return b.getLiveSnapshot(input.appId);
  });

  server.handle(addProvider, async (input: RpcInput<typeof addProvider>) => {
    const b = await be();
    return { provider: b.addProvider(input.appId, input.provider) };
  });

  server.handle(editProvider, async (input: RpcInput<typeof editProvider>) => {
    const b = await be();
    return { provider: b.editProvider(input.appId, input.id, input.patch) };
  });

  server.handle(removeProvider, async (input: RpcInput<typeof removeProvider>) => {
    const b = await be();
    b.removeProvider(input.appId, input.id);
    return { ok: true };
  });

  server.handle(switchProvider, async (input: RpcInput<typeof switchProvider>) => {
    const b = await be();
    return b.switchProvider(input.appId, input.id);
  });

  server.handle(importCurrent, async (input: RpcInput<typeof importCurrent>) => {
    const b = await be();
    return { provider: b.importCurrent(input.appId) };
  });

  server.handle(fetchModels, async (input: RpcInput<typeof fetchModels>) => {
    const b = await be();
    return b.fetchModels(input.baseUrl, input.apiKey);
  });

  server.handle(testEndpoints, async (input: RpcInput<typeof testEndpoints>) => {
    const b = await be();
    return { results: await b.testEndpoints(input.urls, input.timeoutSecs) };
  });

  server.handle(reorderProviders, async (input: RpcInput<typeof reorderProviders>) => {
    const b = await be();
    b.reorderProviders(input.appId, input.orderedIds);
    return { ok: true };
  });

  server.handle(piEnable, async (input: RpcInput<typeof piEnable>) => {
    const b = await be();
    b.piEnable(input.id);
    return { ok: true };
  });

  server.handle(piDisable, async (input: RpcInput<typeof piDisable>) => {
    const b = await be();
    b.piDisable(input.id);
    return { ok: true };
  });

  server.handle(piSetDefault, async (input: RpcInput<typeof piSetDefault>) => {
    const b = await be();
    b.piSetDefault(input.id);
    return { ok: true };
  });

  return () => {};
}
