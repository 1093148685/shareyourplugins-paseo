/**
 * index.client.tsx — Plugin client entry for preset-switcher.
 *
 * Registers the main surface + sidebar item; the surface component itself
 * lives in client/Surface.tsx.
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MainSurface } from "./client/Surface";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", MainSurface);
  client.addSidebarItem({
    id: "preset-switcher",
    title: "预设切换",
    icon: "Layers",
    surface: "main",
  });
  return () => {};
}
