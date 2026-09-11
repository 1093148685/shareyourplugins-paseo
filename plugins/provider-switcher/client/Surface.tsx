/**
 * Surface.tsx — React Native UI for the provider-switcher plugin (Paseo 0.8).
 *
 * Faithfully ports cc-switch's ProviderList + AddProviderDialog UX:
 * - Card list with icon | body | actions rows (responsive: row in wide, column in compact)
 * - Current provider: accent border + "使用中" disabled button
 * - Pi additive mode: "启用"/"移除" buttons
 * - Add panel: Modal with preset grid + form fields
 * - Manual sort mode: ▲▼ buttons per card (react-native has no HTML5 drag)
 * - Speed test: per-card latency results
 * - Import current config
 *
 * Uses Paseo 0.8 SDK react-native UI kit (Modal, ScrollView, TextInput, Icon) and
 * the surface render host's theme/layout via PluginSurfaceProps.
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  View, Text, Pressable, ScrollView, TextInput,
  Modal as RNModal, ActivityIndicator, Animated, Platform,
} from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import {
  listProviders, addProvider, editProvider, removeProvider,
  switchProvider, importCurrent, fetchModels, testEndpoints,
  reorderProviders, piEnable, piDisable, piSetDefault,
} from "../shared/contracts";
import type { AppId, ProviderWithStatus, FetchedModel, EndpointTestResult } from "../shared/contracts";
import { claudePresets, piPresets, paseoPresets, sortPresets } from "../shared/presets-data";

// ── Color palette (theme-aware: surface0/1/2, foreground, accent, etc.) ──────────

interface Palette {
  bg: string; surface0: string; surface1: string; surface2: string;
  border: string; text: string; muted: string;
  accent: string; accentText: string;
  success: string; successText: string;
  warning: string; warningText: string;
  danger: string; dangerText: string;
  backdrop: string;
}

function makePalette(theme: any, isDark: boolean): Palette {
  const c = theme?.colors ?? {};
  return {
    bg: c.surface0 ?? (isDark ? "#1f2023" : "#f9fafb"),
    surface0: c.surface0 ?? (isDark ? "#26272b" : "#fff"),
    surface1: c.surface1 ?? (isDark ? "#2e2f33" : "#f3f4f6"),
    surface2: c.surface2 ?? (isDark ? "#3a3b40" : "#e5e7eb"),
    border: c.border ?? (isDark ? "#33353b" : "#e5e7eb"),
    text: c.foreground ?? (isDark ? "#e5e7eb" : "#111"),
    muted: c.foregroundMuted ?? (isDark ? "#9ca3af" : "#6b7280"),
    accent: c.accent ?? "#3b82f6",
    accentText: c.accentForeground ?? "#fff",
    success: c.statusSuccess ?? "#10b981",
    successText: "#fff",
    warning: c.statusWarning ?? "#f59e0b",
    warningText: "#fff",
    danger: c.statusDanger ?? "#ef4444",
    dangerText: "#fff",
    backdrop: "rgba(0,0,0,0.5)",
  };
}

// ── Spinner ────────────────────────────────────────────────────────────────────

function Spinner({ size = 14, color }: { size?: number; color?: string }) {
  return <ActivityIndicator size={size as any} color={color ?? "#3b82f6"} />;
}

// ── Tag / chip ─────────────────────────────────────────────────────────────────

function Tag({ label, bg, color }: { label: string; bg: string; color: string }) {
  return (
    <View style={{ borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, backgroundColor: bg, alignSelf: "flex-start" }}>
      <Text style={{ fontSize: 10, fontWeight: "600", color }}>{label}</Text>
    </View>
  );
}

const CATEGORY_TAGS: Record<string, { label: string; bg: string; color: string }> = {
  official:       { label: "官方",     bg: "#fee2e2", color: "#991b1b" },
  cn_official:    { label: "国产官方", bg: "#e0f2fe", color: "#0369a1" },
  cloud_provider: { label: "云服务",   bg: "#f0fdf4", color: "#15803d" },
  aggregator:     { label: "聚合",     bg: "#fdf4ff", color: "#7e22ce" },
  third_party:    { label: "第三方",   bg: "#fff7ed", color: "#c2410c" },
};

function CategoryTag({ category }: { category?: string }) {
  if (!category || category === "custom") return null;
  const t = CATEGORY_TAGS[category];
  if (!t) return null;
  return <Tag label={t.label} bg={t.bg} color={t.color} />;
}

function ProviderIconLetter({ name, size = 22 }: { name: string; size?: number }) {
  const letter = name.charAt(0).toUpperCase();
  const hue = name.split("").reduce((h, c) => h + c.charCodeAt(0), 0) % 360;
  return (
    <View style={{
      width: size, height: size, borderRadius: 6,
      backgroundColor: `hsl(${hue},60%,55%)`,
      alignItems: "center", justifyContent: "center",
    }}>
      <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>{letter}</Text>
    </View>
  );
}

// ── Provider Card ──────────────────────────────────────────────────────────────

interface CardProps {
  provider: ProviderWithStatus;
  appId: AppId;
  p: Palette;
  compact: boolean;
  sorting: boolean;
  isDragOver: boolean;
  onSwitch: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onPiEnable: () => void;
  onPiDisable: () => void;
  onPiSetDefault: () => void;
  onTest: () => void;
  onFetchModels: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  fetchingModels: boolean;
  fetchedModels: FetchedModel[] | null;
  testResults: EndpointTestResult[] | null;
  testingEndpoints: boolean;
}

function ProviderCard(p: CardProps) {
  const { provider, appId, p: c, compact, sorting, isDragOver, fetchingModels, fetchedModels, testResults, testingEndpoints } = p;
  const isPi = appId === "pi";
  const isCurrent = provider.isCurrent;
  const inConfig = provider.inConfig ?? false;
  const isDefault = provider.isDefault ?? false;
  const [hovered, setHovered] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const animScale = useRef(new Animated.Value(1)).current;
  const animHover = useRef(new Animated.Value(0)).current; // 0 = idle, 1 = hovered
  // hover (mouse-over) drives color/elevation; press (mouse-down) only drives scale
  const onHoverIn = () => {
    setHovered(true);
    Animated.timing(animHover, { toValue: 1, duration: 150, useNativeDriver: false }).start();
  };
  const onHoverOut = () => {
    setHovered(false);
    Animated.timing(animHover, { toValue: 0, duration: 180, useNativeDriver: false }).start();
  };
  const onPressIn = () => {
    Animated.timing(animScale, { toValue: 0.99, duration: 120, useNativeDriver: true }).start();
  };
  const onPressOut = () => {
    Animated.timing(animScale, { toValue: 1, duration: 120, useNativeDriver: true }).start();
  };

  // Interpolate background and border for hover state
  const baseBg = isCurrent ? c.surface1 : c.surface0;
  const hoverBg = isCurrent ? c.surface2 : c.surface1;
  const cardBg = animHover.interpolate({ inputRange: [0, 1], outputRange: [baseBg, hoverBg] });
  const cardBorder = animHover.interpolate({ inputRange: [0, 1], outputRange: [c.border, c.muted] });
  const cardElevation = animHover.interpolate({ inputRange: [0, 1], outputRange: [0, 4] });

  // Main button (mirrors cc-switch ProviderActions)
  // Pi 累加语义三态：未启用→[启用]；已启用但非默认→[设为默认]；默认（Pi 实际在跑）→[使用中]。
  // Claude 切换语义：使用/使用中。
  const mainBtn = (() => {
    if (isPi) {
      if (!inConfig) {
        return { label: "启用", icon: "Plus" as const, bg: c.accent, color: c.accentText, onPress: p.onPiEnable, disabled: false };
      }
      if (!isDefault) {
        return { label: "设为默认", icon: "Play" as const, bg: c.accent, color: c.accentText, onPress: p.onPiSetDefault, disabled: false };
      }
      return { label: "使用中", icon: "Check" as const, bg: c.surface2, color: c.muted, onPress: () => {}, disabled: true };
    }
    if (isCurrent) return { label: "使用中", icon: "Check" as const, bg: c.surface2, color: c.muted, onPress: () => {}, disabled: true };
    return { label: "使用", icon: "Play" as const, bg: c.accent, color: c.accentText, onPress: p.onSwitch, disabled: false };
  })();

  // Drag-over / current state stays accent regardless of hover; non-current idles on border and animates to muted on hover.
  const accentColor = c.accent;
  const finalBorderColor = isDragOver || isCurrent ? accentColor : cardBorder;

  return (
    <Animated.View style={{
      marginTop: 12,
      borderRadius: 14,
      backgroundColor: cardBg,
      borderWidth: isCurrent || isDragOver ? 1.5 : 1,
      borderColor: finalBorderColor,
      position: "relative",
      transform: [{ scale: animScale }],
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: animHover.interpolate({ inputRange: [0, 1], outputRange: [0.04, 0.12] }),
      shadowRadius: cardElevation,
    }}>
      <Pressable
        onHoverIn={onHoverIn}
        onHoverOut={onHoverOut}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={{
          padding: 14,
          borderRadius: 14,
          flexDirection: compact ? "column" : "row",
          alignItems: compact ? "stretch" : "center",
          gap: 10,
        }}
      >
        {/* Icon */}
        <View style={{
          width: 36, height: 36, borderRadius: 10,
          backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border,
          alignItems: "center", justifyContent: "center",
        }}>
          <ProviderIconLetter name={provider.name} />
        </View>

        {/* Body */}
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <Text numberOfLines={1} style={{ fontSize: 14.5, fontWeight: "600", color: c.text, flexShrink: 1 }}>
              {provider.name}
            </Text>
            {isCurrent && !isPi && <Tag label="当前使用" bg="#d1fae5" color="#047857" />}
            {isPi && isDefault && <Tag label="使用中" bg="#d1fae5" color="#047857" />}
            {isPi && inConfig && !isDefault && <Tag label="已启用" bg={c.surface2} color={c.muted} />}
            <CategoryTag category={provider.category} />
          </View>
          <Text numberOfLines={1} style={{ fontSize: 12, color: provider.apiUrl && provider.apiUrl !== "未配置接口地址" ? c.accent : c.muted, marginTop: 4 }}>
            {provider.apiUrl ?? "未配置接口地址"}
          </Text>
          {fetchedModels && fetchedModels.length > 0 && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
              {fetchedModels.slice(0, 6).map((m) => (
                <View key={m.id} style={{ borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: c.surface1 }}>
                  <Text style={{ fontSize: 10, color: c.accent }}>{m.id}</Text>
                </View>
              ))}
              {fetchedModels.length > 6 && (
                <Text style={{ fontSize: 10, color: c.muted, alignSelf: "center" }}>+{fetchedModels.length - 6}</Text>
              )}
            </View>
          )}
          {testResults && testResults.length > 0 && (
            <View style={{ marginTop: 6 }}>
              {testResults.map((r) => {
                const latColor = r.latency === null ? c.danger
                  : r.latency < 300 ? c.success
                  : r.latency < 500 ? c.warning
                  : r.latency < 800 ? "#f97316" : c.danger;
                return (
                  <View key={r.url} style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 2 }}>
                    <Text numberOfLines={1} style={{ fontSize: 11, color: c.muted, maxWidth: 200 }}>{r.url}</Text>
                    <Text style={{ fontSize: 11, fontWeight: "600", color: latColor, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }}>
                      {r.latency === null ? "超时" : `${r.latency}ms`}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}
        </View>

        {/* Actions */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, opacity: hovered || sorting || confirmDelete ? 1 : 0.7 }}>
          {confirmDelete ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ fontSize: 12, fontWeight: "600", color: c.danger }}>确认删除?</Text>
              <Pressable
                onPress={p.onDelete}
                style={({ pressed }) => ({
                  borderRadius: 7, paddingHorizontal: 9, paddingVertical: 4,
                  backgroundColor: c.danger, opacity: pressed ? 0.8 : 1,
                })}
              >
                <Text style={{ color: "#fff", fontSize: 11.5, fontWeight: "600" }}>删除</Text>
              </Pressable>
              <Pressable
                onPress={() => setConfirmDelete(false)}
                style={({ pressed }) => ({
                  borderRadius: 7, paddingHorizontal: 9, paddingVertical: 4,
                  backgroundColor: pressed ? c.surface2 : c.surface1,
                  borderWidth: 1, borderColor: c.border,
                })}
              >
                <Text style={{ color: c.muted, fontSize: 11.5, fontWeight: "600" }}>取消</Text>
              </Pressable>
            </View>
          ) : sorting ? (
            <>
              <IconBtn onPress={p.onMoveUp ?? (() => {})} color={c.text} p={c}><Icon name="ChevronUp" size={16} color={c.text} /></IconBtn>
              <IconBtn onPress={p.onMoveDown ?? (() => {})} color={c.text} p={c}><Icon name="ChevronDown" size={16} color={c.text} /></IconBtn>
            </>
          ) : (
            <>
              <Pressable
                onPress={mainBtn.onPress}
                disabled={mainBtn.disabled}
                style={({ pressed }) => ({
                  borderRadius: 8, paddingHorizontal: 11, paddingVertical: 6,
                  backgroundColor: mainBtn.bg, opacity: pressed ? 0.8 : 1,
                  flexDirection: "row", alignItems: "center", gap: 4,
                })}
              >
                <Icon name={mainBtn.icon} size={12} color={mainBtn.color} />
                <Text style={{ color: mainBtn.color, fontSize: 12, fontWeight: "600" }}>{mainBtn.label}</Text>
              </Pressable>
              <IconBtn onPress={p.onEdit} color={c.muted} p={c}><Icon name="Pencil" size={14} color={c.muted} /></IconBtn>
              <IconBtn onPress={p.onTest} color={testingEndpoints ? c.accent : c.muted} p={c} disabled={testingEndpoints}>
                {testingEndpoints ? <Spinner size={12} color={c.accent} /> : <Icon name="Zap" size={14} color={c.muted} />}
              </IconBtn>
              <IconBtn onPress={p.onFetchModels} color={fetchingModels ? c.accent : c.muted} p={c} disabled={fetchingModels}>
                {fetchingModels ? <Spinner size={12} color={c.accent} /> : <Icon name="Download" size={14} color={c.muted} />}
              </IconBtn>
              {isPi && (
                <Pressable
                  onPress={inConfig ? p.onPiDisable : () => {}}
                  disabled={!inConfig}
                  style={({ pressed }) => ({
                    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
                    backgroundColor: pressed ? c.surface2 : "transparent",
                    borderWidth: 1, borderColor: c.border,
                    opacity: inConfig ? 1 : 0.4,
                  })}
                >
                  <Text style={{ fontSize: 12, fontWeight: "600", color: c.muted }}>移除</Text>
                </Pressable>
              )}
              <IconBtn onPress={isCurrent ? () => {} : () => setConfirmDelete(true)} color={isCurrent ? c.surface2 : c.danger} p={c} disabled={isCurrent}>
                <Icon name="Trash2" size={14} color={isCurrent ? c.surface2 : c.danger} />
              </IconBtn>
            </>
          )}
        </View>

      </Pressable>
    </Animated.View>
  );
}

function IconBtn({ onPress, color, disabled, children, p }: { onPress: () => void; color: string; disabled?: boolean; children: React.ReactNode; p: Palette }) {
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={{
        width: 29, height: 29, borderRadius: 7, alignItems: "center", justifyContent: "center",
        backgroundColor: pressed ? p.surface2 : hovered ? p.surface1 : "transparent",
        opacity: disabled ? 0.4 : 1,
        transform: pressed ? [{ scale: 0.9 }] : [{ scale: 1 }],
      }}
    >
      {children}
    </Pressable>
  );
}

// ── TextInput with focus highlight (mirrors web :focus state) ───────────────────

function FocusInput({
  c, value, onChangeText, placeholder, secureTextEntry, autoCapitalize,
  style, onSubmitEditing,
}: {
  c: Palette;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  style?: any;
  onSubmitEditing?: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  // react-native-web forwards onMouseEnter/onMouseLeave to the underlying <input>;
  // not in RN types, so spread via cast. No-ops on native platforms.
  const hoverHandlers = {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  } as any;
  return (
    <TextInput
      {...hoverHandlers}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={c.muted}
      secureTextEntry={secureTextEntry}
      autoCapitalize={autoCapitalize}
      autoCorrect={false}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onSubmitEditing={onSubmitEditing}
      style={[{
        paddingHorizontal: 10, paddingVertical: 7, fontSize: 13,
        borderWidth: 1,
        borderRadius: 8,
        borderColor: focused ? c.accent : hovered ? c.muted : c.border,
        backgroundColor: c.surface0, color: c.text,
      }, style]}
    />
  );
}

// ── Model field with dropdown ──────────────────────────────────────────────────

function ModelField({ value, onChange, placeholder, models, c }: { value: string; onChange: (v: string) => void; placeholder?: string; models: FetchedModel[]; c: Palette }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => models.filter((m) => !query || m.id.toLowerCase().includes(query.toLowerCase())), [models, query]);
  return (
    <View style={{ flexDirection: "row", gap: 6 }}>
      <FocusInput
        c={c}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        autoCapitalize="none"
        style={{ flex: 1 }}
      />
      {models.length > 0 && (
        <>
          <Pressable
            onPress={() => setOpen(true)}
            style={({ pressed }) => ({
              paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8,
              borderWidth: 1, borderColor: c.border,
              backgroundColor: pressed ? c.surface2 : c.surface1, alignItems: "center", justifyContent: "center",
            })}
          >
            <Icon name="ChevronDown" size={14} color={c.muted} />
          </Pressable>
          <RNModal visible={open} transparent animationType="fade" onRequestClose={() => {}}>{/* ESC 置空：避免输入法取消拼写误关 */}
            <Pressable onPress={() => setOpen(false)} style={{ flex: 1, backgroundColor: c.backdrop, alignItems: "center", justifyContent: "center", padding: 20 }}>
              <Pressable onPress={() => {}} style={{ width: 280, maxHeight: 360, borderRadius: 10, backgroundColor: c.surface0, borderWidth: 1, borderColor: c.border, overflow: "hidden" }}>
                <View style={{ padding: 8, borderBottomWidth: 1, borderColor: c.border }}>
                  <FocusInput
                    c={c}
                    value={query}
                    onChangeText={setQuery}
                    placeholder="搜索模型…"
                    autoCapitalize="none"
                    style={{ paddingVertical: 5, fontSize: 12 }}
                  />
                </View>
                <ScrollView style={{ maxHeight: 220 }}>
                  {filtered.length === 0 && (
                    <Text style={{ padding: 12, fontSize: 12, color: c.muted }}>无匹配模型</Text>
                  )}
                  {filtered.map((m) => (
                    <Pressable
                      key={m.id}
                      onPress={() => { onChange(m.id); setOpen(false); setQuery(""); }}
                      style={({ pressed }) => ({ paddingHorizontal: 10, paddingVertical: 7, backgroundColor: pressed ? c.surface2 : "transparent" })}
                    >
                      <Text numberOfLines={1} style={{ fontSize: 12, color: c.text }}>{m.id}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </Pressable>
            </Pressable>
          </RNModal>
        </>
      )}
    </View>
  );
}

// ── Add / Edit provider modal ──────────────────────────────────────────────────

interface AddPanelProps {
  appId: AppId;
  c: Palette;
  editing?: ProviderWithStatus | null;
  onClose: () => void;
  onSaved: () => void;
}

function AddProviderPanel({ appId, c, editing, onClose, onSaved }: AddPanelProps) {
  const addRpc = useRpc(addProvider);
  const editRpc = useRpc(editProvider);
  const fetchModelsRpc = useRpc(fetchModels);
  const toast = useToast();
  const isPi = appId === "pi";
  const isEdit = !!editing;
  const presets = isPi ? piPresets : (appId === "paseo" ? paseoPresets : claudePresets);
  const sorted = useMemo(() => sortPresets(presets), [presets]);

  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sortAZ, setSortAZ] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const initCfg = (editing?.settingsConfig ?? {}) as Record<string, unknown>;
  const initEnv = (initCfg.env as Record<string, string> | undefined) ?? {};
  const initPi = initCfg as { providerKey?: string; apiFormat?: string; baseUrl?: string; apiKey?: string; models?: Array<{ id: string; name?: string }> };

  const [name, setName] = useState(editing?.name ?? "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [websiteUrl, setWebsiteUrl] = useState(editing?.websiteUrl ?? "");
  const [apiKey, setApiKey] = useState(isPi ? (initPi.apiKey ?? "") : (initEnv.ANTHROPIC_AUTH_TOKEN ?? initEnv.ANTHROPIC_API_KEY ?? ""));
  const [baseUrl, setBaseUrl] = useState(isPi ? (initPi.baseUrl ?? "") : (initEnv.ANTHROPIC_BASE_URL ?? ""));
  const [defaultModel, setDefaultModel] = useState(initEnv.ANTHROPIC_MODEL ?? "");
  const [haikuModel, setHaikuModel] = useState(initEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? "");
  const [sonnetModel, setSonnetModel] = useState(initEnv.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "");
  const [opusModel, setOpusModel] = useState(initEnv.ANTHROPIC_DEFAULT_OPUS_MODEL ?? "");
  const [providerKey, setProviderKey] = useState(initPi.providerKey ?? "");
  const [apiFormat, setApiFormat] = useState(initPi.apiFormat ?? "openai-completions");
  const [piModels, setPiModels] = useState<Array<{ id: string; name: string }>>(
    (initPi.models ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }))
  );
  const [newModelId, setNewModelId] = useState("");
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [modalFetchedModels, setModalFetchedModels] = useState<FetchedModel[]>([]);

  const selectedPresetData = sorted.find((pp) => pp.id === selectedPreset);

  // Apply preset on selection
  useEffect(() => {
    if (!selectedPresetData) return;
    setName(selectedPresetData.name);
    setWebsiteUrl(selectedPresetData.websiteUrl ?? "");
    if (isPi) {
      const pp: any = selectedPresetData;
      setProviderKey(pp.providerKey ?? "");
      const cfg = pp.settingsConfig;
      setBaseUrl(cfg.baseUrl ?? "");
      setApiFormat(cfg.api ?? "openai-completions");
      setPiModels((cfg.models ?? []).map((m: any) => ({ id: m.id, name: m.name ?? m.id })));
    } else {
      const pp: any = selectedPresetData;
      const env = ((pp.settingsConfig as Record<string, unknown>).env ?? {}) as Record<string, string>;
      setBaseUrl(env.ANTHROPIC_BASE_URL ?? "");
      setDefaultModel(env.ANTHROPIC_MODEL ?? "");
      setHaikuModel(env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? "");
      setSonnetModel(env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "");
      setOpusModel(env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? "");
    }
  }, [selectedPreset]);

  const visiblePresets = useMemo(() => {
    const filtered = sorted.filter((pp) => !searchQuery || pp.name.toLowerCase().includes(searchQuery.toLowerCase()));
    if (sortAZ) return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    return filtered;
  }, [sorted, searchQuery, sortAZ]);

  const categoryHint = (() => {
    if (!selectedPresetData) return null;
    const cat = selectedPresetData.category;
    if (cat === "cn_official") return "💡 国产官方供应商只需填写 API Key，请求地址已预设";
    if (cat === "aggregator") return "💡 聚合服务供应商只需填写 API Key 即可使用";
    if (cat === "third_party") return "💡 第三方供应商需要填写 API Key 和请求地址";
    if (cat === "official") return "💡 官方供应商使用浏览器登录，无需配置 API Key";
    return "💡 选择预设后，请在下方填写 API Key 等字段";
  })();

  const handleFetchModels = async () => {
    if (!apiKey.trim()) { setFetchError("请先填写 API Key，再获取模型列表"); return; }
    if (!baseUrl) return;
    setFetchingModels(true);
    setFetchError("");
    try {
      const result = await fetchModelsRpc({ baseUrl, apiKey });
      if (result.error) {
        setFetchError(result.error);
      } else {
        setModalFetchedModels(result.models);
        if (isPi) {
          setPiModels(result.models.map((m) => ({ id: m.id, name: m.name ?? m.id })));
        }
        if (result.models.length === 0) setFetchError("接口返回的模型列表为空");
      }
    } finally {
      setFetchingModels(false);
    }
  };

  const handleSubmit = async () => {
    if (!name.trim()) { setError("请填写供应商名称"); return; }
    if (!isPi && !baseUrl.trim()) { setError("请填写请求地址"); return; }
    if (isPi && !providerKey.trim()) { setError("请填写 Provider Key"); return; }
    setError("");
    setSubmitting(true);
    try {
      let settingsConfig: Record<string, unknown>;
      if (isPi) {
        settingsConfig = { providerKey, apiFormat, baseUrl, apiKey, models: piModels.map((m) => ({ id: m.id, name: m.name })) };
      } else {
        const env: Record<string, string> = { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey };
        if (defaultModel) env.ANTHROPIC_MODEL = defaultModel;
        if (haikuModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel;
        if (sonnetModel) env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel;
        if (opusModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel;
        settingsConfig = { env };
      }
      if (isEdit && editing) {
        await editRpc({ appId, id: editing.id, patch: { name: name.trim(), notes: notes.trim() || undefined, websiteUrl: websiteUrl.trim() || undefined, settingsConfig } });
      } else {
        await addRpc({
          appId,
          provider: {
            name: name.trim(), notes: notes.trim() || undefined, websiteUrl: websiteUrl.trim() || undefined,
            category: selectedPresetData?.category ?? "custom",
            isPartner: selectedPresetData?.isPartner,
            icon: selectedPresetData?.icon,
            iconColor: selectedPresetData?.iconColor,
            settingsConfig,
          },
        });
      }
      toast.show(isEdit ? "已保存" : "已添加", { variant: "success" });
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // 只允许通过显式关闭按钮（← / ✕ / 取消 / 保存成功后）关闭：
    // 1. 背景层是 View 而非 Pressable —— 鼠标移出/点击背景不再关闭弹窗
    // 2. onRequestClose 置空 —— 中文输入法里 ESC 取消拼写会触发它，导致编辑中弹窗消失
    <RNModal visible transparent animationType="fade" onRequestClose={() => {}}>
      <View style={{ flex: 1, backgroundColor: c.backdrop, alignItems: "center", justifyContent: "center", padding: 16 }}>
        <View
          style={{ width: "100%", maxWidth: 720, maxHeight: "90%", borderRadius: 14, backgroundColor: c.surface0, borderWidth: 1, borderColor: c.border, overflow: "hidden" }}
        >
          {/* Header */}
          <View style={{ flexDirection: "row", alignItems: "center", padding: 14, borderBottomWidth: 1, borderColor: c.border, gap: 14 }}>
            <Pressable onPress={onClose} style={({ pressed }) => ({ width: 34, height: 34, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surface2 : c.surface0, alignItems: "center", justifyContent: "center" })}>
              <Icon name="ArrowLeft" size={16} color={c.text} />
            </Pressable>
            <Text style={{ fontSize: 17, fontWeight: "700", color: c.text }}>
              {isEdit ? "编辑供应商" : "添加供应商"} — {appId === "claude" ? "Claude Code" : appId === "pi" ? "Pi" : "Paseo"}
            </Text>
            <Pressable onPress={onClose} style={({ pressed }) => ({ marginLeft: "auto", width: 30, height: 30, borderRadius: 7, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? c.surface2 : "transparent" })}>
              <Icon name="X" size={16} color={c.muted} />
            </Pressable>
          </View>

          {/* Body */}
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 18 }} keyboardShouldPersistTaps="handled">
            {/* Preset grid (hidden in edit mode) */}
            {!isEdit && (
              <View style={{ marginBottom: 20 }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <Text style={{ fontSize: 13, fontWeight: "600", color: c.muted }}>选择预设</Text>
                  <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
                    {searchOpen && (
                      <FocusInput
                        c={c}
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        placeholder="搜索预设…"
                        autoCapitalize="none"
                        style={{ width: 180, paddingHorizontal: 8, paddingVertical: 4, fontSize: 12 }}
                      />
                    )}
                    <Pressable onPress={() => { setSearchOpen(!searchOpen); setSearchQuery(""); }} style={({ pressed }) => ({ width: 29, height: 29, borderRadius: 7, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surface2 : "transparent" })}>
                      <Icon name="Search" size={14} color={searchOpen ? c.accent : c.muted} />
                    </Pressable>
                    <Pressable onPress={() => setSortAZ(!sortAZ)} style={({ pressed }) => ({ width: 29, height: 29, borderRadius: 7, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surface2 : "transparent" })}>
                      <Icon name="ArrowDownUp" size={14} color={sortAZ ? c.accent : c.muted} />
                    </Pressable>
                  </View>
                </View>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <PresetBtn label="自定义配置" selected={selectedPreset === null} onPress={() => setSelectedPreset(null)} c={c} />
                  {visiblePresets.map((preset) => {
                    const isSelected = selectedPreset === preset.id;
                    const selBg = (preset as any).theme?.backgroundColor ?? c.accent;
                    return (
                      <PresetBtn
                        key={preset.id}
                        label={preset.name}
                        icon={<ProviderIconLetter name={preset.name} size={18} />}
                        selected={isSelected}
                        selectedBg={selBg}
                        onPress={() => setSelectedPreset(isSelected ? null : preset.id)}
                        c={c}
                      />
                    );
                  })}
                </View>
                {categoryHint && <Text style={{ fontSize: 11.5, color: c.muted, marginTop: 8 }}>{categoryHint}</Text>}
              </View>
            )}

            {/* Form fields */}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
              <Field label="名称 *" fullWidth>
                <FocusInput c={c} value={name} onChangeText={setName} placeholder="供应商名称" />
              </Field>

              {isPi && (
                <Field label="Provider Key *（小写字母/数字/连字符）" fullWidth>
                  <FocusInput
                    c={c}
                    value={providerKey}
                    onChangeText={(v) => setProviderKey(v.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                    placeholder="my-provider"
                    autoCapitalize="none"
                  />
                </Field>
              )}

              {isPi && (
                <Field label="接口格式" fullWidth>
                  <FocusInput c={c} value={apiFormat} onChangeText={setApiFormat} placeholder="openai-completions" />
                </Field>
              )}

              <Field label="API Key *" fullWidth>
                <View style={{ position: "relative" }}>
                  <FocusInput
                    c={c}
                    value={apiKey}
                    onChangeText={(v) => { setApiKey(v); if (fetchError) setFetchError(""); }}
                    placeholder="sk-..."
                    secureTextEntry={!showApiKey}
                    autoCapitalize="none"
                    style={{ paddingRight: 36 }}
                  />
                  <Pressable
                    onPress={() => setShowApiKey(!showApiKey)}
                    style={({ pressed }) => ({ position: "absolute", right: 5, top: "50%", marginTop: -13, width: 26, height: 26, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? c.surface2 : "transparent" })}
                  >
                    <Icon name={showApiKey ? "EyeOff" : "Eye"} size={14} color={c.muted} />
                  </Pressable>
                </View>
              </Field>

              <Field label="请求地址" fullWidth>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <FocusInput
                    c={c}
                    value={baseUrl}
                    onChangeText={setBaseUrl}
                    placeholder="https://api.example.com"
                    autoCapitalize="none"
                    style={{ flex: 1 }}
                  />
                  <Pressable
                    onPress={handleFetchModels}
                    disabled={fetchingModels || !baseUrl}
                    style={({ pressed }) => ({
                      paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8,
                      borderWidth: 1, borderColor: c.border,
                      backgroundColor: pressed ? c.surface2 : c.surface1,
                      flexDirection: "row", alignItems: "center", gap: 4,
                      opacity: fetchingModels ? 0.7 : 1,
                    })}
                  >
                    {fetchingModels ? <Spinner size={12} /> : <Icon name="Download" size={12} color={c.text} />}
                    <Text style={{ color: c.text, fontSize: 12, fontWeight: "600" }}>{fetchingModels ? "获取中…" : "获取模型列表"}</Text>
                  </Pressable>
                </View>
                {fetchError && <Text style={{ fontSize: 11, color: c.danger, marginTop: 6 }}>{fetchError}</Text>}
                {!isPi && modalFetchedModels.length > 0 && !fetchError && (
                  <Text style={{ fontSize: 11, color: c.success, marginTop: 6 }}>✓ 已获取 {modalFetchedModels.length} 个模型，模型映射输入框右侧 ▼ 可选择</Text>
                )}
              </Field>

              <Field label="官网地址" half>
                <FocusInput c={c} value={websiteUrl} onChangeText={setWebsiteUrl} placeholder="https://" />
              </Field>
              <Field label="备注" half>
                <FocusInput c={c} value={notes} onChangeText={setNotes} placeholder="可选备注" />
              </Field>

              {!isPi && (
                <>
                  <View style={{ width: "100%", flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 }}>
                    <Text style={{ fontSize: 13, fontWeight: "600", color: c.muted }}>模型映射</Text>
                    {modalFetchedModels.length > 0 && (
                      <Text style={{ fontSize: 11, color: c.accent }}>已获取 {modalFetchedModels.length} 个模型，点输入框右侧 ▼ 选择</Text>
                    )}
                  </View>
                  {[
                    { label: "默认模型 (ANTHROPIC_MODEL)", value: defaultModel, setter: setDefaultModel },
                    { label: "Haiku 模型", value: haikuModel, setter: setHaikuModel },
                    { label: "Sonnet 模型", value: sonnetModel, setter: setSonnetModel },
                    { label: "Opus 模型", value: opusModel, setter: setOpusModel },
                  ].map(({ label, value, setter }) => (
                    <Field key={label} label={label} half>
                      <ModelField value={value} onChange={setter} placeholder="模型 ID" models={modalFetchedModels} c={c} />
                    </Field>
                  ))}
                </>
              )}

              {isPi && (
                <Field label="模型配置" fullWidth>
                  <View style={{ borderLeftWidth: 2, borderColor: c.border, paddingLeft: 12 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <Text style={{ fontSize: 13, fontWeight: "600", color: c.muted }}>模型配置</Text>
                      <Pressable
                        onPress={handleFetchModels}
                        disabled={fetchingModels || !baseUrl}
                        style={({ pressed }) => ({ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surface2 : c.surface1, flexDirection: "row", alignItems: "center", gap: 4, opacity: fetchingModels ? 0.7 : 1 })}
                      >
                        {fetchingModels ? <Spinner size={11} /> : <Icon name="Download" size={11} color={c.text} />}
                        <Text style={{ color: c.text, fontSize: 11, fontWeight: "600" }}>获取模型列表</Text>
                      </Pressable>
                    </View>
                    {piModels.length === 0 && <Text style={{ fontSize: 12, color: c.muted }}>暂无模型</Text>}
                    {piModels.map((m, idx) => (
                      <View key={idx} style={{ flexDirection: "row", gap: 8, marginBottom: 6, alignItems: "center" }}>
                        <FocusInput c={c} value={m.id} onChangeText={(v) => setPiModels(piModels.map((x, i) => i === idx ? { ...x, id: v } : x))} placeholder="模型 ID *" autoCapitalize="none" style={{ flex: 1, fontSize: 12 }} />
                        <FocusInput c={c} value={m.name} onChangeText={(v) => setPiModels(piModels.map((x, i) => i === idx ? { ...x, name: v } : x))} placeholder="显示名称" style={{ flex: 1, fontSize: 12 }} />
                        <Pressable onPress={() => setPiModels(piModels.filter((_, i) => i !== idx))} style={({ pressed }) => ({ width: 29, height: 29, borderRadius: 7, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? c.surface2 : "transparent" })}>
                          <Icon name="Trash2" size={14} color={c.danger} />
                        </Pressable>
                      </View>
                    ))}
                    <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
                      <FocusInput
                        c={c}
                        value={newModelId}
                        onChangeText={setNewModelId}
                        placeholder="输入模型 ID 后按回车添加"
                        autoCapitalize="none"
                        onSubmitEditing={() => { if (newModelId.trim()) { setPiModels([...piModels, { id: newModelId.trim(), name: newModelId.trim() }]); setNewModelId(""); } }}
                        style={{ flex: 1, fontSize: 12 }}
                      />
                      <Pressable
                        onPress={() => { if (newModelId.trim()) { setPiModels([...piModels, { id: newModelId.trim(), name: newModelId.trim() }]); setNewModelId(""); } }}
                        style={({ pressed }) => ({ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: pressed ? c.accent : c.accent, flexDirection: "row", alignItems: "center", gap: 4 })}
                      >
                        <Icon name="Plus" size={11} color={c.accentText} />
                        <Text style={{ color: c.accentText, fontSize: 11, fontWeight: "600" }}>添加</Text>
                      </Pressable>
                    </View>
                  </View>
                </Field>
              )}
            </View>

            {error && <Text style={{ fontSize: 12, color: c.danger, marginTop: 12 }}>{error}</Text>}
          </ScrollView>

          {/* Footer */}
          <View style={{ flexDirection: "row", alignItems: "center", padding: 13, borderTopWidth: 1, borderColor: c.border, gap: 10 }}>
            <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Icon name="Lightbulb" size={12} color={c.muted} />
              <Text style={{ fontSize: 11.5, color: c.muted }}>选择预设后，请在下方填写 API Key 等字段</Text>
            </View>
            <Pressable onPress={onClose} style={({ pressed }) => ({ paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surface2 : c.surface1 })}>
              <Text style={{ color: c.text, fontSize: 12, fontWeight: "600" }}>取消</Text>
            </Pressable>
            <Pressable
              onPress={handleSubmit}
              disabled={submitting}
              style={({ pressed }) => ({ paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8, backgroundColor: pressed ? c.accent : c.accent, opacity: submitting ? 0.7 : 1, flexDirection: "row", alignItems: "center", gap: 4 })}
            >
              {submitting ? <Spinner size={12} color={c.accentText} /> : <Icon name={isEdit ? "Save" : "Plus"} size={12} color={c.accentText} />}
              <Text style={{ color: c.accentText, fontSize: 12, fontWeight: "600" }}>
                {submitting ? (isEdit ? "保存中…" : "添加中…") : (isEdit ? "保存修改" : "添加")}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </RNModal>
  );
}

function PresetBtn({ label, icon, selected, selectedBg, onPress, c }: { label: string; icon?: React.ReactNode; selected: boolean; selectedBg?: string; onPress: () => void; c: Palette }) {
  const bg = selected ? (selectedBg ?? c.accent) : c.surface1;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
        borderWidth: 1, borderColor: selected ? (selectedBg ?? c.accent) : c.border,
        backgroundColor: pressed && !selected ? c.surface2 : bg,
        flexDirection: "row", alignItems: "center", gap: 6, maxWidth: 200,
      })}
    >
      {icon}
      <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "500", color: selected ? c.accentText : c.text }}>{label}</Text>
    </Pressable>
  );
}

function Field({ label, fullWidth, half, children }: { label: string; fullWidth?: boolean; half?: boolean; children: React.ReactNode }) {
  return (
    <View style={{ width: fullWidth ? "100%" : (half ? "48%" : "auto"), flexGrow: half ? 0 : 1 }}>
      <Text style={{ fontSize: 12, fontWeight: "600", color: "#6b7280", marginBottom: 4 }}>{label}</Text>
      {children}
    </View>
  );
}

// ── Placeholder tabs ───────────────────────────────────────────────────────────

function PlaceholderTab({ label, c }: { label: string; c: Palette }) {
  return (
    <View style={{ alignItems: "center", justifyContent: "center", height: 300, gap: 12 }}>
      <Icon name="Package" size={32} color={c.muted} />
      <Text style={{ fontSize: 14, color: c.muted }}>{label} 功能即将推出</Text>
      <Text style={{ fontSize: 12, color: c.muted }}>此功能为占位，后续版本开放</Text>
    </View>
  );
}

// ── Main Surface ───────────────────────────────────────────────────────────────

export function ProviderSwitcherSurface({ theme, layout }: PluginSurfaceProps) {
  const isDark = useMemo(() => {
    const c = theme?.colors?.surface0 ?? "#ffffff";
    const hex = c.replace("#", "");
    if (hex.length < 6) return false;
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b < 0.5;
  }, [theme]);

  const c = useMemo(() => makePalette(theme, isDark), [theme, isDark]);
  const compact = layout?.compact ?? false;

  const listRpc   = useRpc(listProviders);
  const switchRpc = useRpc(switchProvider);
  const removeRpc = useRpc(removeProvider);
  const importRpc = useRpc(importCurrent);
  const reorderRpc = useRpc(reorderProviders);
  const piEnableRpc  = useRpc(piEnable);
  const piDisableRpc = useRpc(piDisable);
  const piSetDefaultRpc = useRpc(piSetDefault);
  const fetchModelsRpc = useRpc(fetchModels);
  const testEndpointsRpc = useRpc(testEndpoints);

  const [activeApp, setActiveApp] = useState<AppId>("claude");
  const [activeTab, setActiveTab] = useState<"providers" | "mcp" | "prompts">("providers");
  const [providers, setProviders] = useState<ProviderWithStatus[]>([]);
  const [current, setCurrent] = useState("");
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderWithStatus | null>(null);
  const [sorting, setSorting] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const [sortOrder, setSortOrder] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [fetchingModels, setFetchingModels] = useState<Record<string, boolean>>({});
  const [fetchedModels, setFetchedModels] = useState<Record<string, FetchedModel[]>>({});
  const [testingEndpoints, setTestingEndpoints] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, EndpointTestResult[]>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await listRpc({ appId: activeApp });
      setProviders(result.providers);
      setCurrent(result.current);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [activeApp]);

  useEffect(() => { load(); }, [load]);

  const handleSwitch = async (id: string) => {
    try { await switchRpc({ appId: activeApp, id }); await load(); }
    catch (e) { setError(String(e)); }
  };

  // Confirmation happens inline on the card (Alert.alert is a no-op on react-native-web).
  const handleDelete = async (id: string) => {
    try { await removeRpc({ appId: activeApp, id }); await load(); }
    catch (e) { setError(String(e)); }
  };

  const handlePiEnable = async (id: string) => {
    try { await piEnableRpc({ id }); await load(); }
    catch (e) { setError(String(e)); }
  };

  const handlePiDisable = async (id: string) => {
    try { await piDisableRpc({ id }); await load(); }
    catch (e) { setError(String(e)); }
  };

  const handlePiSetDefault = async (id: string) => {
    try { await piSetDefaultRpc({ id }); await load(); }
    catch (e) { setError(String(e)); }
  };

  const handleImport = async () => {
    setImporting(true);
    try { await importRpc({ appId: activeApp }); await load(); }
    catch (e) { setError(String(e)); }
    finally { setImporting(false); }
  };

  const handleFetchModels = async (prov: ProviderWithStatus) => {
    const cfg = (prov.settingsConfig ?? {}) as Record<string, unknown>;
    const env = (cfg.env as Record<string, string> | undefined) ?? {};
    const baseUrl = env.ANTHROPIC_BASE_URL ?? (cfg.baseUrl as string | undefined) ?? "";
    const apiKey = env.ANTHROPIC_AUTH_TOKEN ?? (cfg.apiKey as string | undefined);
    if (!baseUrl) return;
    if (!apiKey) { setError(`「${prov.name}」没有填写 API Key，无法获取模型列表`); return; }
    setFetchingModels((s) => ({ ...s, [prov.id]: true }));
    try {
      const result = await fetchModelsRpc({ baseUrl, apiKey });
      if (!result.error) setFetchedModels((s) => ({ ...s, [prov.id]: result.models }));
    } finally {
      setFetchingModels((s) => ({ ...s, [prov.id]: false }));
    }
  };

  const handleTest = async (prov: ProviderWithStatus) => {
    const cfg = (prov.settingsConfig ?? {}) as Record<string, unknown>;
    const env = (cfg.env as Record<string, string> | undefined) ?? {};
    const baseUrl = env.ANTHROPIC_BASE_URL ?? (cfg.baseUrl as string | undefined) ?? "";
    const urls = baseUrl ? [baseUrl] : [];
    if (!urls.length) return;
    setTestingEndpoints((s) => ({ ...s, [prov.id]: true }));
    try {
      const result = await testEndpointsRpc({ urls, timeoutSecs: 8 });
      setTestResults((s) => ({ ...s, [prov.id]: result.results }));
    } finally {
      setTestingEndpoints((s) => ({ ...s, [prov.id]: false }));
    }
  };

  // Manual sort (▲▼ buttons per card)
  const displayProviders = sorting
    ? sortOrder.map((id) => providers.find((x) => x.id === id)).filter(Boolean) as ProviderWithStatus[]
    : providers;

  const enterSort = () => { setSortOrder(providers.map((p) => p.id)); setSorting(true); };
  const exitSort = (save: boolean) => {
    if (save) {
      setSavingOrder(true);
      reorderRpc({ appId: activeApp, orderedIds: sortOrder })
        .then(() => load())
        .catch((e) => setError(String(e)))
        .finally(() => setSavingOrder(false));
    }
    setSorting(false);
  };
  const moveItem = (idx: number, dir: -1 | 1) => {
    setSortOrder((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  const apps: Array<{ id: AppId; label: string; icon: any }> = [
    { id: "claude", label: "Claude Code", icon: "Moon" },
    { id: "pi", label: "Pi", icon: "Sigma" },
    { id: "paseo", label: "Paseo", icon: "Package" },
  ];

  const tabs: Array<{ id: "providers" | "mcp" | "prompts"; label: string }> = [
    { id: "providers", label: "提供商" },
    { id: "mcp", label: "MCP" },
    { id: "prompts", label: "提示词" },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {/* Top bar */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderColor: c.border, backgroundColor: c.surface0, gap: 10 }}>
        <View style={{ flexDirection: "row", backgroundColor: c.surface1, borderRadius: 12, padding: 4, gap: 2, marginHorizontal: "auto" }}>
          {apps.map((app) => {
            const active = activeApp === app.id;
            return (
              <Pressable
                key={app.id}
                onPress={() => { setActiveApp(app.id); setSorting(false); }}
                style={({ pressed }) => ({
                  paddingHorizontal: 14, paddingVertical: 6, borderRadius: 9,
                  flexDirection: "row", alignItems: "center", gap: 6,
                  backgroundColor: active ? c.surface0 : (pressed ? c.surface2 : "transparent"),
                })}
              >
                <Icon name={app.icon} size={13} color={active ? c.text : c.muted} />
                <Text style={{ color: active ? c.text : c.muted, fontSize: 13, fontWeight: "500" }}>{app.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={{ flexDirection: "row", gap: 8, marginLeft: "auto", alignItems: "center" }}>
          {sorting ? (
            <>
              <Pressable onPress={() => exitSort(true)} disabled={savingOrder} style={({ pressed }) => ({ paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8, backgroundColor: c.accent, opacity: savingOrder ? 0.7 : 1, flexDirection: "row", alignItems: "center", gap: 4 })}>
                {savingOrder ? <Spinner size={12} color={c.accentText} /> : <Icon name="Check" size={12} color={c.accentText} />}
                <Text style={{ color: c.accentText, fontSize: 12, fontWeight: "600" }}>{savingOrder ? "保存中…" : "完成排序"}</Text>
              </Pressable>
              <Pressable onPress={() => exitSort(false)} style={({ pressed }) => ({ paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surface2 : c.surface1 })}>
                <Text style={{ color: c.text, fontSize: 12, fontWeight: "600" }}>取消</Text>
              </Pressable>
            </>
          ) : (
            <>
              {providers.length > 1 && (
                <Pressable onPress={enterSort} style={({ pressed }) => ({ paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surface2 : c.surface1, flexDirection: "row", alignItems: "center", gap: 4 })}>
                  <Icon name="GripVertical" size={12} color={c.text} />
                  <Text style={{ color: c.text, fontSize: 12, fontWeight: "600" }}>排序</Text>
                </Pressable>
              )}
              <Pressable onPress={handleImport} disabled={importing} style={({ pressed }) => ({ paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surface2 : c.surface1, flexDirection: "row", alignItems: "center", gap: 4, opacity: importing ? 0.7 : 1 })}>
                {importing ? <Spinner size={12} /> : <Icon name="FileDown" size={12} color={c.text} />}
                <Text style={{ color: c.text, fontSize: 12, fontWeight: "600" }}>{importing ? "导入中…" : "导入当前配置"}</Text>
              </Pressable>
              <Pressable onPress={() => setShowAdd(true)} style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 18, backgroundColor: "#f97316", alignItems: "center", justifyContent: "center", opacity: pressed ? 0.85 : 1 })}>
                <Icon name="Plus" size={18} color="#fff" />
              </Pressable>
            </>
          )}
        </View>
      </View>

      {/* Sub tabs */}
      <View style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: c.border, paddingLeft: 16, backgroundColor: c.surface0 }}>
        {tabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <Pressable key={tab.id} onPress={() => setActiveTab(tab.id)} style={({ pressed }) => ({ paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 2, borderColor: active ? c.accent : "transparent", opacity: pressed ? 0.7 : 1 })}>
              <Text style={{ color: active ? c.accent : c.muted, fontSize: 13, fontWeight: active ? "600" : "400" }}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* Content */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 4 }}>
        {activeTab === "mcp" && <PlaceholderTab label="MCP" c={c} />}
        {activeTab === "prompts" && <PlaceholderTab label="提示词" c={c} />}

        {activeTab === "providers" && (
          <View>
            {error && (
              <View style={{ marginVertical: 12, padding: 10, borderRadius: 8, backgroundColor: "#fef2f2", borderWidth: 1, borderColor: "#fecaca" }}>
                <Text style={{ color: "#dc2626", fontSize: 13 }}>{error}</Text>
              </View>
            )}

            {loading && (
              <View style={{ alignItems: "center", padding: 40 }}>
                <ActivityIndicator color={c.muted} />
                <Text style={{ color: c.muted, fontSize: 13, marginTop: 8 }}>加载中…</Text>
              </View>
            )}

            {!loading && providers.length === 0 && (
              <View style={{ alignItems: "center", justifyContent: "center", padding: 60, gap: 12 }}>
                <Icon name="Package" size={32} color={c.muted} />
                <Text style={{ fontSize: 14, color: c.muted }}>暂无供应商</Text>
                <Text style={{ fontSize: 12, color: c.muted, textAlign: "center" }}>如果你已有配置，请点击"导入当前配置"，所有数据将安全保存在 default 供应商中</Text>
                <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
                  <Pressable onPress={handleImport} disabled={importing} style={({ pressed }) => ({ paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surface2 : c.surface1, flexDirection: "row", alignItems: "center", gap: 4 })}>
                    <Icon name="FileDown" size={12} color={c.text} />
                    <Text style={{ color: c.text, fontSize: 12, fontWeight: "600" }}>导入当前配置</Text>
                  </Pressable>
                  <Pressable onPress={() => setShowAdd(true)} style={({ pressed }) => ({ paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8, backgroundColor: c.accent, opacity: pressed ? 0.8 : 1, flexDirection: "row", alignItems: "center", gap: 4 })}>
                    <Icon name="Plus" size={12} color={c.accentText} />
                    <Text style={{ color: c.accentText, fontSize: 12, fontWeight: "600" }}>新建供应商</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {!loading && displayProviders.map((prov, idx) => (
              <ProviderCard
                key={prov.id}
                provider={prov}
                appId={activeApp}
                p={c}
                compact={compact}
                sorting={sorting}
                isDragOver={false}
                onSwitch={() => handleSwitch(prov.id)}
                onEdit={() => setEditingProvider(prov)}
                onDelete={() => handleDelete(prov.id)}
                onPiEnable={() => handlePiEnable(prov.id)}
                onPiDisable={() => handlePiDisable(prov.id)}
                onPiSetDefault={() => handlePiSetDefault(prov.id)}
                onTest={() => handleTest(prov)}
                onFetchModels={() => handleFetchModels(prov)}
                onMoveUp={() => moveItem(idx, -1)}
                onMoveDown={() => moveItem(idx, 1)}
                fetchingModels={fetchingModels[prov.id] ?? false}
                fetchedModels={fetchedModels[prov.id] ?? null}
                testResults={testResults[prov.id] ?? null}
                testingEndpoints={testingEndpoints[prov.id] ?? false}
              />
            ))}
          </View>
        )}
      </ScrollView>

      {/* Add / Edit provider modal */}
      {(showAdd || editingProvider) && (
        <AddProviderPanel
          appId={activeApp}
          c={c}
          editing={editingProvider}
          onClose={() => { setShowAdd(false); setEditingProvider(null); }}
          onSaved={load}
        />
      )}
    </View>
  );
}
