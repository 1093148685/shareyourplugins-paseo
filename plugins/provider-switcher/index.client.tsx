/**
 * index.client.tsx — Plugin client entry for provider-switcher.
 *
 * Registers the main surface + sidebar item; the surface component itself
 * lives in client/Surface.tsx and is the react-native port of the previous
 * web-DOM main.client.tsx.
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ProviderSwitcherSurface } from "./client/Surface";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", ProviderSwitcherSurface);
  client.addSidebarItem({
    id: "provider-switcher",
    title: "提供商切换",
    icon: "Zap",
    surface: "main",
  });
  return () => {};
}
