/**
 * index.client.tsx — Plugin client entry for server-monitor.
 *
 * Registers the main surface + sidebar item; the surface component itself
 * lives in client/Surface.tsx.
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MonitorSurface } from "./client/Surface";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", MonitorSurface);
  client.addSidebarItem({
    id: "server-monitor",
    title: "服务器监控",
    icon: "Monitor",
    surface: "main",
  });
  return () => {};
}
