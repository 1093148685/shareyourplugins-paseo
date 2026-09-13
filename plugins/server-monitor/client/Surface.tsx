/**
 * Surface.tsx — server-monitor main surface (Paseo 0.8, react-native-web).
 *
 * Design language matches provider-switcher: theme palette with light/dark
 * fallbacks, SDK Icon + toast, 12-15px typography scale, RNModal dialogs.
 *
 * Polling cadence (pairs with the backend's 40s cache + offline backoff):
 *   servers 30s · metrics 45s · self-stats 45s — all paused in background.
 */
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import React, { useMemo, useState, useEffect } from "react";
import {
  ActivityIndicator,
  Modal as RNModal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listServers, getMetrics, getCredentials,
  addServer, editServer, removeServer, testServer, testNewConnection,
  getSelfStats,
} from "../shared/contracts";
import type { ServerSummary, Metrics, SelfStats } from "../shared/contracts";

// ── Color palette (theme-aware, with light/dark fallbacks) ────────────────────

interface Palette {
  bg: string; surface0: string; surface1: string; surface2: string;
  border: string; text: string; muted: string;
  accent: string; accentText: string;
  success: string; warning: string; danger: string;
  backdrop: string;
}

function makePalette(theme: any, isDark: boolean): Palette {
  const c = theme?.colors ?? {};
  return {
    bg:       c.surface0        ?? (isDark ? "#1f2023" : "#f9fafb"),
    surface0: c.surface0        ?? (isDark ? "#26272b" : "#fff"),
    surface1: c.surface1        ?? (isDark ? "#2e2f33" : "#f3f4f6"),
    surface2: c.surface2        ?? (isDark ? "#3a3b40" : "#e5e7eb"),
    border:   c.border          ?? (isDark ? "#33353b" : "#e5e7eb"),
    text:     c.foreground      ?? (isDark ? "#e5e7eb" : "#111"),
    muted:    c.foregroundMuted ?? (isDark ? "#9ca3af" : "#6b7280"),
    accent:   c.accent          ?? "#3b82f6",
    accentText: c.accentForeground ?? "#fff",
    success:  c.statusSuccess   ?? "#10b981",
    warning:  c.statusWarning   ?? "#f59e0b",
    danger:   c.statusDanger    ?? "#ef4444",
    backdrop: "rgba(0,0,0,0.5)",
  };
}

function detectDark(theme: any): boolean {
  const hex = String(theme?.colors?.surface0 ?? "#ffffff").replace("#", "");
  if (hex.length < 6) return false;
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 0.5;
}

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

// ── Formatters ─────────────────────────────────────────────────────────────────

function fmt(bytes: number, unit: "B" | "KB" | "MB" | "GB" = "GB", dp = 1): string {
  const d = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 }[unit];
  return (bytes / d).toFixed(dp);
}

function fmtRate(bps: number): string {
  if (bps >= 1048576) return `${(bps / 1048576).toFixed(1)} MB/s`;
  if (bps >= 1024)    return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}天 ${h}小时`;
  if (h > 0) return `${h}小时 ${m}分`;
  return `${m}分`;
}

function barSeverity(pct: number): "normal" | "warn" | "danger" {
  return pct >= 85 ? "danger" : pct >= 70 ? "warn" : "normal";
}

function timeAgo(ts?: number): string {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s 前`;
  if (s < 3600) return `${Math.floor(s / 60)}m 前`;
  return `${Math.floor(s / 3600)}h 前`;
}

type Styles = ReturnType<typeof makeStyles>;

// ── Small shared components (top-level — stable identity across re-renders) ───

function Spinner({ size = 14, color }: { size?: number; color?: string }) {
  return <ActivityIndicator size={size as any} color={color ?? "#3b82f6"} />;
}

function Bar({ pct, s, c }: { pct: number; s: Styles; c: Palette }) {
  const sev = barSeverity(pct);
  const fill = sev === "danger" ? c.danger : sev === "warn" ? c.warning : c.accent;
  return (
    <View style={s.track}>
      <View style={[s.fill, { width: `${Math.min(pct, 100)}%` as any, backgroundColor: fill }]} />
    </View>
  );
}

function Chip({ label, active, onPress, s }: {
  label: string; active: boolean; onPress: () => void; s: Styles;
}) {
  return (
    <Pressable onPress={onPress}
      style={({ pressed }) => [s.chip, active && s.chipOn, pressed && !active && { backgroundColor: s.chipPressed.backgroundColor }]}>
      <Text style={[s.chipText, active && s.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

function Tag({ label, variant = "default", s, c }: {
  label: string;
  variant?: "default" | "region" | "spec" | "prod" | "dev";
  s: Styles; c: Palette;
}) {
  const col: Record<string, string> = {
    default: c.muted,
    region:  c.accent,
    spec:    c.muted,
    prod:    c.warning,
    dev:     c.success,
  };
  return (
    <View style={s.tag}>
      <Text style={[s.tagText, { color: col[variant] ?? c.muted }]}>{label}</Text>
    </View>
  );
}

function MetricRow({ icon, label, pct, valueStr, s, c }: {
  icon: string; label: string; pct: number; valueStr: string; s: Styles; c: Palette;
}) {
  const sev = barSeverity(pct);
  const valColor = sev === "danger" ? c.danger : sev === "warn" ? c.warning : c.muted;
  return (
    <View style={s.metricRow}>
      <View style={s.metricHdr}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Icon name={icon} size={11} color={c.muted} />
          <Text style={s.metricLabel}>{label}</Text>
        </View>
        <Text style={[s.metricVal, { color: valColor }]}>{valueStr}</Text>
      </View>
      <Bar pct={pct} s={s} c={c} />
    </View>
  );
}

function CredRow({ label, value, copyKey, copied, onCopy, masked, onToggleMask, s, c }: {
  label: string; value: string; copyKey: string;
  copied: string | null; onCopy: (v: string, k: string) => void;
  masked?: boolean; onToggleMask?: () => void; s: Styles; c: Palette;
}) {
  const display = masked ? "•".repeat(Math.min(value.length, 16)) : value;
  return (
    <View style={s.credRow}>
      <Text style={s.credLabel}>{label}</Text>
      <Text style={[s.credVal, masked && s.credMasked]} numberOfLines={1}>{display}</Text>
      <View style={s.credActions}>
        {onToggleMask && (
          <Pressable style={({ pressed }) => [s.icoBtn, pressed && { opacity: 0.7 }]} onPress={onToggleMask}>
            <Icon name={masked ? "Eye" : "EyeOff"} size={12} color={c.muted} />
          </Pressable>
        )}
        <Pressable
          style={({ pressed }) => [s.icoBtn, copied === copyKey && s.icoBtnCopied, pressed && { opacity: 0.7 }]}
          onPress={() => onCopy(value, copyKey)}
        >
          <Icon name={copied === copyKey ? "Check" : "Copy"} size={12}
            color={copied === copyKey ? c.success : c.muted} />
        </Pressable>
      </View>
    </View>
  );
}

function InfoCell({ label, value, danger, warn, s, c }: {
  label: string; value: string; danger?: boolean; warn?: boolean; s: Styles; c: Palette;
}) {
  const valColor = danger ? c.danger : warn ? c.warning : c.text;
  return (
    <View style={s.infoCell}>
      <Text style={s.infoCellLabel}>{label}</Text>
      <Text style={[s.infoCellVal, { color: valColor }]}>{value}</Text>
    </View>
  );
}

// ── Server card ────────────────────────────────────────────────────────────────

function ServerCard({ srv, m, s, c, onOpen }: {
  srv: ServerSummary; m: Metrics | undefined;
  s: Styles; c: Palette; onOpen: (id: string) => void;
}) {
  const offline = srv.status === "offline";
  const unknown = srv.status === "unknown";
  const statusColor = offline ? c.danger : unknown ? c.muted : c.success;

  return (
    <Pressable
      style={({ pressed }) => [s.card, pressed && s.cardPressed]}
      onPress={() => onOpen(srv.id)}
    >
      <View style={s.cardHdr}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
          <View style={[s.cardAvatar, { backgroundColor: `${statusColor}1a` }]}>
            <Icon name="Server" size={15} color={statusColor} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={s.sname}>{srv.name}</Text>
            <Text numberOfLines={1} style={s.shost}>{srv.host}:{srv.sshPort}</Text>
          </View>
        </View>
        <View style={[s.badge, { backgroundColor: `${statusColor}1a` }]}>
          <View style={[s.dot, { backgroundColor: statusColor }]} />
          <Text style={[s.badgeText, { color: statusColor }]}>
            {offline ? "离线" : unknown ? "未知" : "在线"}
          </Text>
        </View>
      </View>

      {(srv.region || srv.spec || srv.tags.length > 0) && (
        <View style={s.tagRow}>
          {srv.region ? <Tag label={srv.region} variant="region" s={s} c={c} /> : null}
          {srv.spec ? <Tag label={srv.spec} variant="spec" s={s} c={c} /> : null}
          {srv.tags.map((t) => (
            <Tag key={t} label={t} s={s} c={c}
              variant={t === "production" ? "prod" : t === "development" ? "dev" : "default"} />
          ))}
        </View>
      )}

      {m && m.status === "online" && m.cpu && m.memory && m.disk ? (
        <>
          <View style={s.metaRow}>
            {m.os && <Text style={s.metaText} numberOfLines={1}>{m.os.name}</Text>}
            {m.uptime != null && <Text style={s.metaText}>▲ {fmtUptime(m.uptime)}</Text>}
            {m.load && <Text style={s.metaText}>负载 {m.load[0].toFixed(2)}</Text>}
          </View>

          <MetricRow icon="Cpu" label="CPU" pct={m.cpu.usage} valueStr={`${m.cpu.usage}%`} s={s} c={c} />
          <MetricRow
            icon="MemoryStick"
            label="内存"
            pct={Math.round((m.memory.used / m.memory.total) * 100)}
            valueStr={`${Math.round((m.memory.used / m.memory.total) * 100)}% · ${fmt(m.memory.used)}/${fmt(m.memory.total)}G`}
            s={s} c={c}
          />
          {m.disk[0] && (
            <MetricRow
              icon="HardDrive"
              label={`磁盘 ${m.disk[0].mount}`}
              pct={Math.round((m.disk[0].used / m.disk[0].total) * 100)}
              valueStr={`${Math.round((m.disk[0].used / m.disk[0].total) * 100)}% · ${fmt(m.disk[0].used)}/${fmt(m.disk[0].total)}G`}
              s={s} c={c}
            />
          )}

          {m.network && (
            <View style={s.netRow}>
              {m.network.rxRate == null ? (
                <Text style={s.netText}>网络采样中…</Text>
              ) : (
                <>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                    <Icon name="ArrowDown" size={11} color={c.success} />
                    <Text style={s.netText}>{fmtRate(m.network.rxRate)}</Text>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                    <Icon name="ArrowUp" size={11} color={c.accent} />
                    <Text style={s.netText}>{fmtRate(m.network.txRate ?? 0)}</Text>
                  </View>
                </>
              )}
              <Text style={[s.netText, { marginLeft: "auto" as any, opacity: 0.6 }]}>
                {m.network.iface}
              </Text>
            </View>
          )}
        </>
      ) : offline ? (
        <View style={s.offlineBox}>
          <Text style={s.offlineText}>
            {srv.lastFetchedAt ? `上次尝试 ${timeAgo(srv.lastFetchedAt)}` : "从未连接"}
          </Text>
          {srv.lastError && (
            <Text style={s.errText} numberOfLines={2}>{srv.lastError}</Text>
          )}
        </View>
      ) : (
        <View style={s.offlineBox}>
          <Text style={s.mutedText}>加载指标中…</Text>
        </View>
      )}

      <View style={s.cardFooter}>
        <Text style={s.footerTime}>{timeAgo(srv.lastFetchedAt)}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Icon name="KeyRound" size={11} color={c.accent} />
          <Text style={s.connBtnText}>连接信息</Text>
        </View>
      </View>
    </Pressable>
  );
}

// ── Detail Modal ───────────────────────────────────────────────────────────────

function DetailModal({ srv, m, c, s, onClose, onEdit }: {
  srv: ServerSummary; m: Metrics | undefined;
  c: Palette; s: Styles;
  onClose: () => void; onEdit: (id: string) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();

  const credsRpc  = useRpc(getCredentials);
  const testRpc   = useRpc(testServer);
  const removeRpc = useRpc(removeServer);

  const [pwVisible, setPwVisible]     = useState(false);
  const [copied, setCopied]           = useState<string | null>(null);
  const [testing, setTesting]         = useState(false);
  const [testResult, setTestResult]   = useState<{ ok: boolean; latencyMs: number; error?: string } | null>(null);
  const [confirmDel, setConfirmDel]   = useState(false);

  // Delete confirmation auto-resets after 3s
  useEffect(() => {
    if (!confirmDel) return;
    const t = setTimeout(() => setConfirmDel(false), 3000);
    return () => clearTimeout(t);
  }, [confirmDel]);

  const credsQuery = useQuery({
    queryKey: ["monitor", "creds", srv.id],
    queryFn: () => credsRpc({ id: srv.id }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const creds = credsQuery.data;

  const removeMutation = useMutation({
    mutationFn: (id: string) => removeRpc({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["monitor", "servers"] });
      qc.invalidateQueries({ queryKey: ["monitor", "metrics"] });
      toast.show(`已删除 ${srv.name}`, { variant: "success" });
      onClose();
    },
    onError: (e) => toast.error(`删除失败: ${e instanceof Error ? e.message : String(e)}`),
  });

  const portPart = srv.sshPort !== 22 ? ` -p ${srv.sshPort}` : "";
  const sshCmd = creds?.keyPath
    ? `ssh -i ${creds.keyPath} ${creds.user}@${srv.host}${portPart}`
    : `ssh ${creds?.user ?? "root"}@${srv.host}${portPart}`;

  function copy(text: string, key: string) {
    try { (navigator as any).clipboard?.writeText(text); } catch { /* ignore */ }
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testRpc({ id: srv.id });
      setTestResult(r);
      if (r.ok) toast.show(`连接正常 · ${r.latencyMs}ms`, { variant: "success" });
      else toast.error(r.error ?? "连接失败");
    } finally { setTesting(false); }
  }

  return (
    <RNModal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.overlay}>
        <View style={s.modal}>
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={s.modalHdr}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.modalTitle}>{srv.name}</Text>
                <Text style={s.modalSub}>{m?.os?.name ?? srv.host} · {srv.region || "未分组"} · {srv.spec || "—"}</Text>
              </View>
              <Pressable onPress={onClose}
                style={({ pressed }) => [s.closeBtn, pressed && { backgroundColor: c.surface2 }]}>
                <Icon name="X" size={14} color={c.muted} />
              </Pressable>
            </View>

            <Text style={s.sectionTitle}>SSH 快速连接</Text>
            <View style={s.sshBlock}>
              <Text style={s.sshCmd} numberOfLines={1}>{sshCmd}</Text>
              <Pressable style={({ pressed }) => [s.copyBtn, pressed && { opacity: 0.7 }]}
                onPress={() => copy(sshCmd, "cmd")}>
                <Icon name={copied === "cmd" ? "Check" : "Copy"} size={12}
                  color={copied === "cmd" ? c.success : c.muted} />
              </Pressable>
            </View>

            <Text style={s.sectionTitle}>认证信息</Text>
            {credsQuery.isLoading ? (
              <Text style={s.mutedText}>解密中…</Text>
            ) : creds ? (
              <View style={s.credRows}>
                <CredRow label="用户名" value={creds.user} copyKey="user" copied={copied} onCopy={copy} s={s} c={c} />
                {creds.password != null && (
                  <CredRow
                    label="密码" value={creds.password} copyKey="pw"
                    copied={copied} onCopy={copy} s={s} c={c}
                    masked={!pwVisible} onToggleMask={() => setPwVisible((v) => !v)}
                  />
                )}
                {creds.keyPath && (
                  <CredRow label="私钥路径" value={creds.keyPath} copyKey="key" copied={copied} onCopy={copy} s={s} c={c} />
                )}
              </View>
            ) : null}

            <View style={s.divider} />

            <Text style={s.sectionTitle}>服务器信息</Text>
            <View style={s.infoGrid}>
              <InfoCell label="地区" value={srv.region || "—"} s={s} c={c} />
              <InfoCell label="规格" value={srv.spec   || "—"} s={s} c={c} />
              <InfoCell label="月费" value={srv.cost   || "—"} s={s} c={c} />
              <InfoCell label="认证" value={srv.authMethod === "key" ? "SSH 私钥" : "密码"} s={s} c={c} />
            </View>
            {srv.tags.length > 0 && (
              <View style={[s.tagRow, { marginTop: 10, marginBottom: 0 }]}>
                {srv.tags.map((t) => (
                  <Tag key={t} label={t} s={s} c={c}
                    variant={t === "production" ? "prod" : t === "development" ? "dev" : "default"} />
                ))}
              </View>
            )}
            {srv.note ? <Text style={s.noteText}>{srv.note}</Text> : null}

            {m?.status === "online" && m.cpu && m.memory && (
              <>
                <View style={s.divider} />
                <Text style={s.sectionTitle}>实时指标</Text>
                <View style={s.infoGrid}>
                  <InfoCell label="CPU" value={`${m.cpu.usage}%`}
                    danger={m.cpu.usage >= 85} warn={m.cpu.usage >= 70} s={s} c={c} />
                  <InfoCell label="内存"
                    value={`${Math.round((m.memory.used / m.memory.total) * 100)}%`}
                    danger={m.memory.used / m.memory.total >= 0.85}
                    warn={m.memory.used / m.memory.total >= 0.70} s={s} c={c} />
                  {m.uptime != null && <InfoCell label="运行时长" value={fmtUptime(m.uptime)} s={s} c={c} />}
                  {m.load && <InfoCell label="系统负载" value={m.load[0].toFixed(2)} s={s} c={c} />}
                  {m.os   && <InfoCell label="主机名" value={m.os.hostname} s={s} c={c} />}
                  {m.network && m.network.rxRate != null && (
                    <InfoCell label="网络"
                      value={`↓${fmtRate(m.network.rxRate)} ↑${fmtRate(m.network.txRate ?? 0)}`}
                      s={s} c={c} />
                  )}
                </View>
              </>
            )}

            <View style={s.divider} />

            <Pressable
              style={({ pressed }) => [s.secondaryBtn, testing && s.btnDisabled, pressed && { opacity: 0.8 }]}
              onPress={runTest}
              disabled={testing}
            >
              {testing
                ? <Spinner size={12} color={c.muted} />
                : <Icon name="Zap" size={12} color={c.text} />}
              <Text style={s.secondaryBtnText}>{testing ? "测试中…" : "测试连接"}</Text>
            </Pressable>
            {testResult && (
              <Text style={testResult.ok ? s.okText : s.errText}>
                {testResult.ok
                  ? `✓ 连接正常 · ${testResult.latencyMs}ms`
                  : `✕ ${testResult.error}`}
              </Text>
            )}

            <View style={s.divider} />

            <View style={s.actionRow}>
              <Pressable style={({ pressed }) => [s.secondaryBtn, { flex: 1, marginBottom: 0 }, pressed && { opacity: 0.8 }]}
                onPress={() => onEdit(srv.id)}>
                <Icon name="Pencil" size={12} color={c.text} />
                <Text style={s.secondaryBtnText}>编辑配置</Text>
              </Pressable>
              {/* Two-step delete confirmation */}
              <Pressable
                style={({ pressed }) => [s.dangerBtn, { flex: 1 },
                  removeMutation.isPending && s.btnDisabled,
                  confirmDel && { backgroundColor: `${c.danger}1a`, borderColor: c.danger },
                  pressed && { opacity: 0.8 }]}
                onPress={() => {
                  if (!confirmDel) { setConfirmDel(true); return; }
                  removeMutation.mutate(srv.id);
                }}
                disabled={removeMutation.isPending}
              >
                <Icon name="Trash2" size={12} color={c.danger} />
                <Text style={s.dangerBtnText}>
                  {removeMutation.isPending ? "删除中…"
                    : confirmDel ? "再次点击确认删除"
                    : "删除服务器"}
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </RNModal>
  );
}

// ── Shared form bits for Add/Edit modals ───────────────────────────────────────

interface FormState {
  name: string; host: string; sshPort: string; sshUser: string;
  authMethod: "key" | "password";
  sshKeyPath: string; sshPassword: string;
  region: string; spec: string; cores: string; cost: string; tags: string; note: string;
}

function FRow({ label, children, s }: { label: string; children: React.ReactNode; s: Styles }) {
  return (
    <View style={s.fRow}>
      <Text style={s.fLabel}>{label}</Text>
      <View style={s.fField}>{children}</View>
    </View>
  );
}

function FInp({ fkey, form, setForm, placeholder, secure, flex, style, s, c }: {
  fkey: keyof FormState;
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  placeholder?: string; secure?: boolean; flex?: number;
  style?: any; s: Styles; c: Palette;
}) {
  return (
    <TextInput
      style={[s.fInput, flex != null && { flex }, style]}
      value={form[fkey]}
      onChangeText={(v) => setForm((f) => ({ ...f, [fkey]: v }))}
      placeholder={placeholder ?? ""}
      placeholderTextColor={c.muted}
      secureTextEntry={secure}
      autoCapitalize="none"
      autoCorrect={false}
    />
  );
}

function ClassificationFields({ form, setForm, s, c }: {
  form: FormState; setForm: React.Dispatch<React.SetStateAction<FormState>>;
  s: Styles; c: Palette;
}) {
  return (
    <View style={s.moreBody}>
      <View style={s.fRow}>
        <Text style={s.fLabel}>地区</Text>
        <View style={s.fField}>
          <FInp fkey="region" form={form} setForm={setForm} placeholder="华东-上海" flex={1} s={s} c={c} />
        </View>
        <Text style={s.fSep} />
        <View style={{ width: 100 }}>
          <FInp fkey="spec" form={form} setForm={setForm} placeholder="4核 8GB" s={s} c={c} />
        </View>
      </View>
      <View style={s.fRow}>
        <Text style={s.fLabel}>核数</Text>
        <View style={s.fField}>
          <FInp fkey="cores" form={form} setForm={setForm} placeholder="4"
            style={{ width: 56, textAlign: "center", flex: 0 }} s={s} c={c} />
        </View>
        <Text style={s.fSep} />
        <View style={{ width: 100 }}>
          <FInp fkey="cost" form={form} setForm={setForm} placeholder="¥180/月" s={s} c={c} />
        </View>
      </View>
      <FRow label="标签" s={s}>
        <FInp fkey="tags" form={form} setForm={setForm} placeholder="production, nginx（逗号分隔）" s={s} c={c} />
      </FRow>
      <FRow label="备注" s={s}>
        <FInp fkey="note" form={form} setForm={setForm} placeholder="备注信息" s={s} c={c} />
      </FRow>
    </View>
  );
}

function AuthSection({ form, setForm, isEdit, s, c }: {
  form: FormState; setForm: React.Dispatch<React.SetStateAction<FormState>>;
  isEdit: boolean; s: Styles; c: Palette;
}) {
  return (
    <>
      <FRow label="认证" s={s}>
        <View style={s.authToggle}>
          {(["key", "password"] as const).map((m) => (
            <Pressable key={m}
              style={[s.authOption, form.authMethod === m && s.authOptionOn]}
              onPress={() => setForm((f) => ({ ...f, authMethod: m }))}>
              <Icon name={m === "key" ? "KeyRound" : "Lock"} size={12}
                color={form.authMethod === m ? c.accent : c.muted} />
              <Text style={[s.authOptionText, form.authMethod === m && s.authOptionTextOn]}>
                {m === "key" ? "私钥" : "密码"}
              </Text>
            </Pressable>
          ))}
        </View>
      </FRow>
      {form.authMethod === "key" ? (
        <FRow label="私钥路径" s={s}>
          <FInp fkey="sshKeyPath" form={form} setForm={setForm} placeholder="~/.ssh/id_rsa" s={s} c={c} />
        </FRow>
      ) : (
        <>
          <FRow label={isEdit ? "新密码" : "密码"} s={s}>
            <FInp fkey="sshPassword" form={form} setForm={setForm}
              placeholder={isEdit ? "留空则不修改" : "SSH 密码"} secure s={s} c={c} />
          </FRow>
          <Text style={[s.formHint, { marginTop: -2, marginBottom: 10 }]}>
            密码经 AES-256-GCM 加密存储；本机已内置 plink 支持密码认证
          </Text>
        </>
      )}
    </>
  );
}

// ── Add Server Modal ───────────────────────────────────────────────────────────

function AddServerModal({ c, s, onClose }: {
  c: Palette; s: Styles; onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();

  const addRpc     = useRpc(addServer);
  const testNewRpc = useRpc(testNewConnection);

  const [form, setForm] = useState<FormState>({
    name: "", host: "", sshPort: "22", sshUser: "root",
    authMethod: "key",
    sshKeyPath: "~/.ssh/id_rsa", sshPassword: "",
    region: "", spec: "", cores: "0", cost: "", tags: "", note: "",
  });
  const [showMore, setShowMore]     = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting]       = useState(false);

  const addMutation = useMutation({
    mutationFn: (input: Parameters<typeof addRpc>[0]) => addRpc(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["monitor", "servers"] });
      toast.show("服务器已添加", { variant: "success" });
      onClose();
    },
    onError: (e) => toast.error(`保存失败: ${e instanceof Error ? e.message : String(e)}`),
  });

  async function handleTest() {
    if (!form.host.trim()) return;
    setTesting(true); setTestResult(null);
    try {
      const r = await testNewRpc({
        host: form.host.trim(),
        sshPort: parseInt(form.sshPort) || 22,
        sshUser: form.sshUser.trim() || "root",
        authMethod: form.authMethod,
        sshPassword: form.authMethod === "password" ? form.sshPassword : undefined,
        sshKeyPath:  form.authMethod === "key"      ? form.sshKeyPath  : undefined,
      });
      setTestResult(r.ok
        ? { ok: true,  msg: `连接正常 · ${r.latencyMs}ms` }
        : { ok: false, msg: r.error ?? "连接失败" });
    } catch (e) {
      setTestResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally { setTesting(false); }
  }

  // Validation: require the credential field matching the chosen auth method
  const formValid = !!form.host.trim() &&
    (form.authMethod === "key" ? !!form.sshKeyPath.trim() : !!form.sshPassword);

  function handleSubmit() {
    if (!formValid) return;
    addMutation.mutate({
      name:        form.name.trim() || form.host.trim(),
      host:        form.host.trim(),
      sshPort:     parseInt(form.sshPort) || 22,
      sshUser:     form.sshUser.trim() || "root",
      authMethod:  form.authMethod,
      sshPassword: form.authMethod === "password" ? form.sshPassword : undefined,
      sshKeyPath:  form.authMethod === "key"      ? form.sshKeyPath  : undefined,
      region:      form.region.trim(),
      spec:        form.spec.trim(),
      cores:       parseInt(form.cores) || 0,
      cost:        form.cost.trim(),
      tags:        form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      note:        form.note.trim(),
    });
  }

  return (
    <RNModal visible transparent animationType="fade" onRequestClose={() => { /* avoid IME mis-close */ }}>
      <View style={s.overlay}>
        <View style={s.modal}>
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={s.modalHdr}>
              <Text style={s.modalTitle}>添加服务器</Text>
              <Pressable onPress={onClose}
                style={({ pressed }) => [s.closeBtn, pressed && { backgroundColor: c.surface2 }]}>
                <Icon name="X" size={14} color={c.muted} />
              </Pressable>
            </View>

            <FRow label="名称" s={s}>
              <FInp fkey="name" form={form} setForm={setForm} placeholder="web-01（留空则用 IP）" s={s} c={c} />
            </FRow>
            <FRow label="主机" s={s}>
              <FInp fkey="host" form={form} setForm={setForm} placeholder="192.168.1.10" flex={1} s={s} c={c} />
              <Text style={s.fSep}>:</Text>
              <FInp fkey="sshPort" form={form} setForm={setForm} placeholder="22"
                style={{ width: 60, textAlign: "center", flex: 0 }} s={s} c={c} />
            </FRow>
            <FRow label="用户名" s={s}>
              <FInp fkey="sshUser" form={form} setForm={setForm} placeholder="root" s={s} c={c} />
            </FRow>

            <AuthSection form={form} setForm={setForm} isEdit={false} s={s} c={c} />

            <Pressable style={s.moreToggle} onPress={() => setShowMore((v) => !v)}>
              <Icon name={showMore ? "ChevronDown" : "ChevronRight"} size={13} color={c.accent} />
              <Text style={s.moreToggleText}>分类与标签（可选）</Text>
              {(form.region || form.tags) ? (
                <Text style={s.moreHint} numberOfLines={1}>
                  {[form.region, form.tags].filter(Boolean).join(" · ")}
                </Text>
              ) : null}
            </Pressable>
            {showMore && <ClassificationFields form={form} setForm={setForm} s={s} c={c} />}

            <View style={s.divider} />

            {testResult && (
              <Text style={[testResult.ok ? s.okText : s.errText, { marginBottom: 10 }]}
                numberOfLines={2}>
                {testResult.ok ? `✓ ${testResult.msg}` : `✕ ${testResult.msg}`}
              </Text>
            )}

            <View style={[s.actionRow, { gap: 10 }]}>
              <Pressable
                style={({ pressed }) => [s.secondaryBtn, { flex: 1, marginBottom: 0 },
                  (testing || !formValid) && s.btnDisabled, pressed && { opacity: 0.8 }]}
                onPress={handleTest}
                disabled={testing || !formValid}
              >
                {testing ? <Spinner size={12} color={c.muted} /> : <Icon name="Zap" size={12} color={c.text} />}
                <Text style={s.secondaryBtnText}>{testing ? "测试中…" : "测试"}</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [s.primaryBtn, { flex: 1 },
                  (!formValid || addMutation.isPending) && s.btnDisabled, pressed && { opacity: 0.85 }]}
                onPress={handleSubmit}
                disabled={!formValid || addMutation.isPending}
              >
                {addMutation.isPending
                  ? <Spinner size={12} color={c.accentText} />
                  : <Icon name="Check" size={12} color={c.accentText} />}
                <Text style={s.primaryBtnText}>
                  {addMutation.isPending ? "保存中…" : "保存"}
                </Text>
              </Pressable>
            </View>

            {addMutation.isError && (
              <Text style={[s.errText, { marginTop: 8 }]}>
                保存失败: {String(addMutation.error)}
              </Text>
            )}
          </ScrollView>
        </View>
      </View>
    </RNModal>
  );
}

// ── Edit Server Modal ──────────────────────────────────────────────────────────

function EditServerModal({ srv, c, s, onClose }: {
  srv: ServerSummary; c: Palette; s: Styles; onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();

  const credsRpc = useRpc(getCredentials);
  const editRpc  = useRpc(editServer);
  const testRpc  = useRpc(testServer);

  const credsQuery = useQuery({
    queryKey: ["monitor", "creds", srv.id],
    queryFn: () => credsRpc({ id: srv.id }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const [form, setForm] = useState<FormState>({
    name:       srv.name,
    host:       srv.host,
    sshPort:    String(srv.sshPort),
    sshUser:    "root",
    authMethod: srv.authMethod,
    sshKeyPath:  "",
    sshPassword: "",
    region:     srv.region,
    spec:       srv.spec,
    cores:      String(srv.cores),
    cost:       srv.cost,
    tags:       srv.tags.join(", "),
    note:       srv.note,
  });
  const [showMore, setShowMore]     = useState(!!(srv.region || srv.spec || srv.tags.length || srv.note));
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting]       = useState(false);

  // Populate user/keyPath once creds finish decrypting
  useEffect(() => {
    const d = credsQuery.data;
    if (!d) return;
    setForm((f) => ({
      ...f,
      sshUser:    f.sshUser === "root" ? d.user : f.sshUser,
      sshKeyPath: f.sshKeyPath || d.keyPath || f.sshKeyPath,
    }));
  }, [credsQuery.data]);

  const editMutation = useMutation({
    mutationFn: (input: Parameters<typeof editRpc>[0]) => editRpc(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["monitor", "servers"] });
      qc.invalidateQueries({ queryKey: ["monitor", "metrics"] });
      toast.show("已保存", { variant: "success" });
      onClose();
    },
    onError: (e) => toast.error(`保存失败: ${e instanceof Error ? e.message : String(e)}`),
  });

  async function handleTest() {
    setTesting(true); setTestResult(null);
    try {
      const r = await testRpc({ id: srv.id });
      setTestResult(r.ok
        ? { ok: true,  msg: `连接正常 · ${r.latencyMs}ms` }
        : { ok: false, msg: r.error ?? "连接失败" });
    } catch (e) {
      setTestResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally { setTesting(false); }
  }

  function handleSubmit() {
    const patch: Parameters<typeof editRpc>[0] = {
      id:         srv.id,
      name:       form.name.trim() || form.host.trim(),
      host:       form.host.trim(),
      sshPort:    parseInt(form.sshPort) || 22,
      sshUser:    form.sshUser.trim() || "root",
      authMethod: form.authMethod,
      region:     form.region.trim(),
      spec:       form.spec.trim(),
      cores:      parseInt(form.cores) || 0,
      cost:       form.cost.trim(),
      tags:       form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      note:       form.note.trim(),
    };
    if (form.authMethod === "key" && form.sshKeyPath.trim()) {
      patch.sshKeyPath = form.sshKeyPath.trim();
    }
    if (form.authMethod === "password" && form.sshPassword) {
      patch.sshPassword = form.sshPassword;
    }
    editMutation.mutate(patch);
  }

  return (
    <RNModal visible transparent animationType="fade" onRequestClose={() => { /* avoid IME mis-close */ }}>
      <View style={s.overlay}>
        <View style={s.modal}>
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={s.modalHdr}>
              <Text style={s.modalTitle}>编辑服务器</Text>
              <Pressable onPress={onClose}
                style={({ pressed }) => [s.closeBtn, pressed && { backgroundColor: c.surface2 }]}>
                <Icon name="X" size={14} color={c.muted} />
              </Pressable>
            </View>

            <FRow label="名称" s={s}>
              <FInp fkey="name" form={form} setForm={setForm} placeholder="web-01" s={s} c={c} />
            </FRow>
            <FRow label="主机" s={s}>
              <FInp fkey="host" form={form} setForm={setForm} placeholder="192.168.1.10" flex={1} s={s} c={c} />
              <Text style={s.fSep}>:</Text>
              <FInp fkey="sshPort" form={form} setForm={setForm} placeholder="22"
                style={{ width: 60, textAlign: "center", flex: 0 }} s={s} c={c} />
            </FRow>
            <FRow label="用户名" s={s}>
              <FInp fkey="sshUser" form={form} setForm={setForm} placeholder="root" s={s} c={c} />
            </FRow>

            <AuthSection form={form} setForm={setForm} isEdit s={s} c={c} />

            <Pressable style={s.moreToggle} onPress={() => setShowMore((v) => !v)}>
              <Icon name={showMore ? "ChevronDown" : "ChevronRight"} size={13} color={c.accent} />
              <Text style={s.moreToggleText}>分类与标签</Text>
              {!showMore && (srv.region || srv.tags.length > 0) && (
                <Text style={s.moreHint} numberOfLines={1}>
                  {[srv.region, srv.tags.join(", ")].filter(Boolean).join(" · ")}
                </Text>
              )}
            </Pressable>
            {showMore && <ClassificationFields form={form} setForm={setForm} s={s} c={c} />}

            <View style={s.divider} />

            {testResult && (
              <Text style={[testResult.ok ? s.okText : s.errText, { marginBottom: 10 }]}
                numberOfLines={2}>
                {testResult.ok ? `✓ ${testResult.msg}` : `✕ ${testResult.msg}`}
              </Text>
            )}

            <View style={[s.actionRow, { gap: 10 }]}>
              <Pressable
                style={({ pressed }) => [s.secondaryBtn, { flex: 1, marginBottom: 0 }, testing && s.btnDisabled, pressed && { opacity: 0.8 }]}
                onPress={handleTest}
                disabled={testing}
              >
                {testing ? <Spinner size={12} color={c.muted} /> : <Icon name="Zap" size={12} color={c.text} />}
                <Text style={s.secondaryBtnText}>{testing ? "测试中…" : "测试"}</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [s.primaryBtn, { flex: 1 },
                  editMutation.isPending && s.btnDisabled, pressed && { opacity: 0.85 }]}
                onPress={handleSubmit}
                disabled={editMutation.isPending}
              >
                {editMutation.isPending
                  ? <Spinner size={12} color={c.accentText} />
                  : <Icon name="Check" size={12} color={c.accentText} />}
                <Text style={s.primaryBtnText}>
                  {editMutation.isPending ? "保存中…" : "保存"}
                </Text>
              </Pressable>
            </View>

            {editMutation.isError && (
              <Text style={[s.errText, { marginTop: 8 }]}>
                保存失败: {String(editMutation.error)}
              </Text>
            )}
          </ScrollView>
        </View>
      </View>
    </RNModal>
  );
}

// ── Self-stats panel (plugin's own footprint) ──────────────────────────────────

function SelfStatsPanel({ stats, s, c }: {
  stats: SelfStats | undefined; s: Styles; c: Palette;
}) {
  const [open, setOpen] = useState(false);
  if (!stats) return null;

  // Heuristic verdict: is this plugin cheap or expensive?
  const heavy = stats.cpuPct > 5 || stats.rssMB > 150;
  const verdictColor = heavy ? c.warning : c.success;
  const verdict = heavy
    ? "开销偏高"
    : "开销正常";

  return (
    <View style={s.selfPanel}>
      <Pressable style={({ pressed }) => [s.selfHdr, pressed && { opacity: 0.8 }]}
        onPress={() => setOpen((v) => !v)}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={13} color={verdictColor} />
          <Icon name="Activity" size={12} color={verdictColor} />
          <Text style={[s.selfTitle, { color: verdictColor }]}>插件自身开销 · {verdict}</Text>
        </View>
        <Text style={s.selfSummary}>
          {stats.rssMB} MB · CPU {stats.cpuPct}% · 复用 {stats.muxHits} 次
        </Text>
      </Pressable>

      {open && (
        <View style={s.selfBody}>
          <View style={s.selfGrid}>
            <SelfCell label="内存 RSS"     value={`${stats.rssMB} MB`}     s={s} c={c} warn={stats.rssMB > 150} />
            <SelfCell label="JS 堆"        value={`${stats.heapMB} MB`}    s={s} c={c} />
            <SelfCell label="CPU 近间隔"   value={`${stats.cpuPct}%`}      s={s} c={c} warn={stats.cpuPct > 5} />
            <SelfCell label="CPU 累计"     value={`${stats.cpuTotalSec}s`} s={s} c={c} />
            <SelfCell label="SSH 调用"     value={`${stats.sshCalls} 次`}  s={s} c={c} />
            <SelfCell label="连接复用"     value={`${stats.muxHits} 次`}   s={s} c={c} />
            <SelfCell label="退避跳过"     value={`${stats.skipped} 次`}   s={s} c={c} />
            <SelfCell label="SSH 平均耗时" value={`${stats.sshAvgMs} ms`}  s={s} c={c} />
            <SelfCell label="SSH 失败"     value={`${stats.sshErrors} 次`} s={s} c={c} warn={stats.sshErrors > stats.sshCalls * 0.5 && stats.sshCalls > 4} />
            <SelfCell label="运行时长"     value={fmtUptime(stats.uptimeSec)} s={s} c={c} />
          </View>
          <Text style={s.selfNote}>
            连接复用 = 通过已建立的 SSH 主连接取数（省去重复握手）；退避跳过 = 离线服务器按指数退避暂停探测。
            PID {stats.pid} · 监控 {stats.servers} 台 · 缓存 {stats.cacheEntries} 条
          </Text>
        </View>
      )}
    </View>
  );
}

function SelfCell({ label, value, warn, s, c }: {
  label: string; value: string; warn?: boolean; s: Styles; c: Palette;
}) {
  return (
    <View style={s.selfCell}>
      <Text style={s.selfCellLabel}>{label}</Text>
      <Text style={[s.selfCellVal, warn && { color: c.warning }]}>{value}</Text>
    </View>
  );
}

// ── Main surface ───────────────────────────────────────────────────────────────

export function MonitorSurface({ theme, layout }: PluginSurfaceProps) {
  const compact = layout.compact;
  const qc = useQueryClient();
  const toast = useToast();

  const isDark = useMemo(() => detectDark(theme), [theme]);
  const c = useMemo(() => makePalette(theme, isDark), [theme, isDark]);
  const s = useMemo(() => makeStyles(c, compact), [c, compact]);

  const listRpc    = useRpc(listServers);
  const metricsRpc = useRpc(getMetrics);
  const selfRpc    = useRpc(getSelfStats);

  // ── Filter state
  const [fStatus, setFStatus] = useState<"all" | "online" | "offline">("all");
  const [fRegion, setFRegion] = useState<string>("all");
  const [fCores,  setFCores]  = useState<string>("all");

  // ── Modal state
  const [detailId, setDetailId]   = useState<string | null>(null);
  const [showAddForm, setShowAdd] = useState(false);
  const [editId,    setEditId]    = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["monitor", "servers"],
    queryFn: () => listRpc({}),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 25_000,
  });

  const metricsQuery = useQuery({
    queryKey: ["monitor", "metrics"],
    queryFn: () => metricsRpc({ forceRefresh: false }),
    refetchInterval: 45_000,
    refetchIntervalInBackground: false,
    staleTime: 40_000,
    enabled: !!(listQuery.data?.servers.length),
  });

  // Plugin's own footprint — cheap RPC, piggybacks on the metrics cadence
  const selfQuery = useQuery({
    queryKey: ["monitor", "self"],
    queryFn: () => selfRpc({}),
    refetchInterval: 45_000,
    refetchIntervalInBackground: false,
    staleTime: 40_000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => metricsRpc({ forceRefresh: true }),
    onSuccess: (data) => {
      qc.setQueryData(["monitor", "metrics"], data);
      qc.invalidateQueries({ queryKey: ["monitor", "servers"] });
    },
    onError: (e) => toast.error(`刷新失败: ${e instanceof Error ? e.message : String(e)}`),
  });

  // ── Derived data
  const servers  = listQuery.data?.servers ?? [];
  const metMap   = useMemo(() => {
    const m = new Map<string, Metrics>();
    for (const x of metricsQuery.data?.metrics ?? []) m.set(x.serverId, x);
    return m;
  }, [metricsQuery.data]);

  const regions = useMemo(
    () => ["all", ...Array.from(new Set(servers.map((sv) => sv.region).filter(Boolean)))],
    [servers],
  );
  const coreOptions = useMemo(
    () => ["all", ...Array.from(new Set(servers.map((sv) => String(sv.cores)).filter((co) => co !== "0")))],
    [servers],
  );

  const visible = useMemo(() => servers.filter((srv) => {
    if (fStatus !== "all" && srv.status !== fStatus) return false;
    if (fRegion !== "all" && srv.region !== fRegion) return false;
    if (fCores  !== "all" && String(srv.cores) !== fCores) return false;
    return true;
  }), [servers, fStatus, fRegion, fCores]);

  const grouped = useMemo(() => {
    const map = new Map<string, ServerSummary[]>();
    for (const srv of visible) {
      const r = srv.region || "未分组";
      if (!map.has(r)) map.set(r, []);
      map.get(r)!.push(srv);
    }
    return map;
  }, [visible]);

  const onlineCnt  = servers.filter((srv) => srv.status === "online").length;
  const offlineCnt = servers.filter((srv) => srv.status === "offline").length;
  const avgCpu = useMemo(() => {
    const vals = [...metMap.values()].filter((m) => m.cpu).map((m) => m.cpu!.usage);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b) / vals.length) : null;
  }, [metMap]);
  const avgMem = useMemo(() => {
    const vals = [...metMap.values()].filter((m) => m.memory).map((m) =>
      Math.round((m.memory!.used / m.memory!.total) * 100)
    );
    return vals.length ? Math.round(vals.reduce((a, b) => a + b) / vals.length) : null;
  }, [metMap]);

  const detailServer = detailId ? servers.find((srv) => srv.id === detailId) ?? null : null;
  const editServer_  = editId   ? servers.find((srv) => srv.id === editId)   ?? null : null;

  // ── Render
  if (listQuery.isLoading) {
    return (
      <View style={s.screen}>
        <View style={s.loadingBox}>
          <ActivityIndicator color={c.muted} />
          <Text style={[s.mutedText, { marginTop: 10 }]}>加载中…</Text>
        </View>
      </View>
    );
  }

  if (listQuery.error) {
    return (
      <View style={s.screen}>
        <View style={s.loadingBox}>
          <Icon name="AlertTriangle" size={28} color={c.danger} />
          <Text style={[s.errText, { marginTop: 10 }]}>加载失败: {String(listQuery.error)}</Text>
          <Pressable style={[s.secondaryBtn, { marginTop: 14, paddingHorizontal: 20 }]}
            onPress={() => listQuery.refetch()}>
            <Text style={s.secondaryBtnText}>重试</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      {/* Top bar */}
      <View style={s.topbar}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.header}>服务器监控</Text>
          <Text style={s.subtitle}>
            {servers.length} 台 · 在线 {onlineCnt} · 离线 {offlineCnt}
            {metricsQuery.dataUpdatedAt ? ` · ${timeAgo(metricsQuery.dataUpdatedAt)}更新` : ""}
          </Text>
        </View>
        <View style={s.hdrRight}>
          <Pressable
            style={({ pressed }) => [s.ghostBtn, refreshMutation.isPending && s.btnDisabled,
              pressed && { backgroundColor: c.surface2 }]}
            onPress={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
          >
            {refreshMutation.isPending
              ? <Spinner size={12} color={c.text} />
              : <Icon name="RefreshCw" size={12} color={c.text} />}
            <Text style={s.ghostBtnText}>{refreshMutation.isPending ? "刷新中…" : "刷新"}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [s.fab, pressed && { opacity: 0.85 }]}
            onPress={() => setShowAdd(true)}
          >
            <Icon name="Plus" size={18} color="#fff" />
          </Pressable>
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: compact ? 12 : 16 }}
        showsVerticalScrollIndicator={false}>
        {/* Stat tiles */}
        <View style={s.tiles}>
          <View style={s.tile}>
            <View style={s.tileLabelRow}>
              <Icon name="Signal" size={11} color={c.success} />
              <Text style={s.tileLabel}>在线</Text>
            </View>
            <Text style={[s.tileVal, { color: c.success }]}>{onlineCnt}</Text>
          </View>
          <View style={s.tile}>
            <View style={s.tileLabelRow}>
              <Icon name="SignalZero" size={11} color={c.danger} />
              <Text style={s.tileLabel}>离线</Text>
            </View>
            <Text style={[s.tileVal, { color: offlineCnt > 0 ? c.danger : c.text }]}>{offlineCnt}</Text>
          </View>
          <View style={s.tile}>
            <View style={s.tileLabelRow}>
              <Icon name="Cpu" size={11} color={avgCpu != null && avgCpu >= 70 ? c.warning : c.muted} />
              <Text style={s.tileLabel}>平均 CPU</Text>
            </View>
            <Text style={[s.tileVal, avgCpu != null && avgCpu >= 70 ? { color: c.warning } : {}]}>
              {avgCpu != null ? `${avgCpu}%` : "—"}
            </Text>
          </View>
          <View style={s.tile}>
            <View style={s.tileLabelRow}>
              <Icon name="MemoryStick" size={11} color={avgMem != null && avgMem >= 70 ? c.warning : c.muted} />
              <Text style={s.tileLabel}>平均内存</Text>
            </View>
            <Text style={[s.tileVal, avgMem != null && avgMem >= 70 ? { color: c.warning } : {}]}>
              {avgMem != null ? `${avgMem}%` : "—"}
            </Text>
          </View>
        </View>

        {/* Filter bar */}
        {servers.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterBar}>
            <View style={s.filterRow}>
              {(["all", "online", "offline"] as const).map((v) => (
                <Chip key={v} s={s}
                  label={v === "all" ? `全部 ${servers.length}` : v === "online" ? `在线 ${onlineCnt}` : `离线 ${offlineCnt}`}
                  active={fStatus === v} onPress={() => setFStatus(v)} />
              ))}
              <View style={s.filterSep} />
              <Text style={s.filterLabel}>地区</Text>
              {regions.map((r) => (
                <Chip key={r} s={s} label={r === "all" ? "全部" : r}
                  active={fRegion === r} onPress={() => setFRegion(r)} />
              ))}
              <View style={s.filterSep} />
              <Text style={s.filterLabel}>规格</Text>
              {coreOptions.map((co) => (
                <Chip key={co} s={s} label={co === "all" ? "全部" : `${co} 核`}
                  active={fCores === co} onPress={() => setFCores(co)} />
              ))}
            </View>
          </ScrollView>
        )}

        {/* Server grid */}
        {servers.length === 0 ? (
          <View style={s.emptyState}>
            <Icon name="Server" size={34} color={c.muted} />
            <Text style={s.emptyTitle}>还没有服务器</Text>
            <Text style={s.mutedText}>添加第一台服务器，开始监控 CPU / 内存 / 磁盘 / 网络</Text>
            <Pressable
              style={({ pressed }) => [s.primaryBtn, { marginTop: 16, paddingHorizontal: 18 }, pressed && { opacity: 0.85 }]}
              onPress={() => setShowAdd(true)}
            >
              <Icon name="Plus" size={13} color={c.accentText} />
              <Text style={s.primaryBtnText}>添加第一台服务器</Text>
            </Pressable>
          </View>
        ) : visible.length === 0 ? (
          <View style={s.emptyState}>
            <Icon name="SearchX" size={30} color={c.muted} />
            <Text style={[s.mutedText, { marginTop: 10 }]}>没有符合筛选条件的服务器</Text>
          </View>
        ) : (
          Array.from(grouped.entries()).map(([region, list]) => (
            <View key={region} style={s.regionGroup}>
              <View style={s.regionHdr}>
                <View style={s.regionLine} />
                <Text style={s.regionName}>{region}</Text>
                <Text style={s.regionCount}>{list.length} 台</Text>
                <View style={s.regionLine} />
              </View>
              <View style={s.grid}>
                {list.map((srv) => (
                  <ServerCard key={srv.id} srv={srv} m={metMap.get(srv.id)}
                    s={s} c={c} onOpen={setDetailId} />
                ))}
              </View>
            </View>
          ))
        )}

        {/* Plugin self-monitoring — proves whether this plugin is the lag source */}
        <SelfStatsPanel stats={selfQuery.data} s={s} c={c} />

        <Text style={s.versionFooter}>server-monitor v0.4.0 · mux 复用 + 离线退避</Text>
      </ScrollView>

      {detailServer && (
        <DetailModal
          srv={detailServer}
          m={metMap.get(detailServer.id)}
          c={c} s={s}
          onClose={() => setDetailId(null)}
          onEdit={(id) => { setDetailId(null); setEditId(id); }}
        />
      )}

      {showAddForm && (
        <AddServerModal c={c} s={s} onClose={() => setShowAdd(false)} />
      )}

      {editServer_ && (
        <EditServerModal srv={editServer_} c={c} s={s} onClose={() => setEditId(null)} />
      )}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
// Typography scale (aligned with provider-switcher):
//   page title 17/700 · card title 15/600 · body 13 · secondary 12 · caption 11

function makeStyles(c: Palette, compact: boolean) {
  return {
    screen:     { flex: 1, backgroundColor: c.bg },
    loadingBox: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const, padding: 40 },

    // Top bar
    topbar:     { flexDirection: "row" as const, alignItems: "center" as const,
                  paddingHorizontal: 16, paddingVertical: 12, gap: 10,
                  borderBottomWidth: 1, borderColor: c.border, backgroundColor: c.surface0 },
    header:     { fontSize: 17, fontWeight: "700" as const, color: c.text },
    subtitle:   { fontSize: 12, color: c.muted, marginTop: 2 },
    hdrRight:   { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },

    ghostBtn:   { flexDirection: "row" as const, alignItems: "center" as const, gap: 5,
                  paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8,
                  borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 },
    ghostBtnText: { fontSize: 12, fontWeight: "600" as const, color: c.text },
    fab:        { width: 36, height: 36, borderRadius: 18, backgroundColor: c.accent,
                  alignItems: "center" as const, justifyContent: "center" as const },

    // Tiles
    tiles:      { flexDirection: "row" as const, gap: 10, marginBottom: 14 },
    tile:       { flex: 1, backgroundColor: c.surface0, borderRadius: 12, padding: 14,
                  borderWidth: 1, borderColor: c.border },
    tileLabelRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5, marginBottom: 6 },
    tileLabel:  { fontSize: 12, color: c.muted },
    tileVal:    { fontSize: 24, fontWeight: "700" as const, color: c.text },

    // Filter bar
    filterBar:  { marginBottom: 14 },
    filterRow:  { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    filterSep:  { width: 1, height: 16, backgroundColor: c.border, marginHorizontal: 4 },
    filterLabel:{ fontSize: 12, color: c.muted },
    chip:       { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20,
                  borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0 },
    chipOn:     { borderColor: c.accent, backgroundColor: `${c.accent}1a` },
    chipPressed:{ backgroundColor: c.surface2 },
    chipText:   { fontSize: 12, color: c.muted },
    chipTextOn: { color: c.accent, fontWeight: "600" as const },

    // Region group
    regionGroup:{ marginBottom: 18 },
    regionHdr:  { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, marginBottom: 10 },
    regionLine: { flex: 1, height: 1, backgroundColor: c.border },
    regionName: { fontSize: 12, fontWeight: "600" as const, color: c.muted },
    regionCount:{ fontSize: 11, color: c.muted, backgroundColor: c.surface1,
                  paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },

    // Grid
    grid:       { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 12 },

    // Card
    card:       { width: "48%" as any, backgroundColor: c.surface0, borderRadius: 12,
                  padding: compact ? 12 : 15, borderWidth: 1, borderColor: c.border },
    cardPressed:{ borderColor: c.accent, backgroundColor: c.surface1 },
    cardHdr:    { flexDirection: "row" as const, justifyContent: "space-between" as const,
                  alignItems: "flex-start" as const, marginBottom: 10, gap: 8 },
    cardAvatar: { width: 32, height: 32, borderRadius: 9,
                  alignItems: "center" as const, justifyContent: "center" as const },
    sname:      { fontSize: 15, fontWeight: "600" as const, color: c.text },
    shost:      { fontSize: 12, color: c.muted, marginTop: 2, fontFamily: MONO },
    badge:      { flexDirection: "row" as const, alignItems: "center" as const, gap: 5,
                  paddingHorizontal: 9, paddingVertical: 4, borderRadius: 7 },
    dot:        { width: 6, height: 6, borderRadius: 3 },
    badgeText:  { fontSize: 11, fontWeight: "600" as const },
    tagRow:     { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, marginBottom: 10 },
    tag:        { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
                  backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border },
    tagText:    { fontSize: 11, color: c.muted },
    metaRow:    { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 10, marginBottom: 10 },
    metaText:   { fontSize: 11.5, color: c.muted },

    // Metric bar
    metricRow:  { marginBottom: 9 },
    metricHdr:  { flexDirection: "row" as const, justifyContent: "space-between" as const,
                  alignItems: "center" as const, marginBottom: 4 },
    metricLabel:{ fontSize: 11, color: c.muted, fontWeight: "500" as const },
    metricVal:  { fontSize: 12, color: c.muted, fontWeight: "500" as const },
    track:      { height: 6, backgroundColor: c.surface2, borderRadius: 3, overflow: "hidden" as const },
    fill:       { height: "100%" as any, borderRadius: 3 },

    // Network
    netRow:     { flexDirection: "row" as const, alignItems: "center" as const, gap: 12,
                  marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.border },
    netText:    { fontSize: 12, color: c.muted },

    // Offline
    offlineBox: { marginVertical: 10 },
    offlineText:{ fontSize: 12.5, color: c.muted, marginBottom: 6 },
    errText:    { fontSize: 12, color: c.danger, lineHeight: 17 },
    okText:     { fontSize: 12, color: c.success },
    mutedText:  { fontSize: 12.5, color: c.muted },

    // Card footer
    cardFooter: { flexDirection: "row" as const, justifyContent: "space-between" as const,
                  alignItems: "center" as const, marginTop: 10, paddingTop: 10,
                  borderTopWidth: 1, borderTopColor: c.border },
    footerTime: { fontSize: 11.5, color: c.muted },
    connBtnText:{ fontSize: 12, color: c.accent, fontWeight: "500" as const },

    // Buttons
    primaryBtn: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "center" as const,
                  gap: 5, paddingVertical: 9, paddingHorizontal: 14, borderRadius: 8,
                  backgroundColor: c.accent },
    primaryBtnText: { fontSize: 12.5, fontWeight: "600" as const, color: c.accentText },
    secondaryBtn:   { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "center" as const,
                      gap: 5, paddingVertical: 9, paddingHorizontal: 14, borderRadius: 8,
                      borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, marginBottom: 6 },
    secondaryBtnText:{ fontSize: 12.5, fontWeight: "600" as const, color: c.text },
    dangerBtn:  { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "center" as const,
                  gap: 5, paddingVertical: 9, paddingHorizontal: 14, borderRadius: 8,
                  borderWidth: 1, borderColor: `${c.danger}50` },
    dangerBtnText:{ fontSize: 12.5, fontWeight: "600" as const, color: c.danger },
    btnDisabled:{ opacity: 0.45 },

    // Empty
    emptyState: { alignItems: "center" as const, paddingVertical: 48 },
    emptyTitle: { fontSize: 14, fontWeight: "600" as const, color: c.text, marginTop: 12, marginBottom: 4 },

    // Modal
    overlay:    { flex: 1, backgroundColor: c.backdrop,
                  justifyContent: "center" as const, alignItems: "center" as const },
    modal:      { width: "88%" as any, maxWidth: 560, maxHeight: "88%" as any,
                  backgroundColor: c.surface0, borderRadius: 14,
                  padding: compact ? 16 : 20, borderWidth: 1, borderColor: c.border },
    modalHdr:   { flexDirection: "row" as const, justifyContent: "space-between" as const,
                  alignItems: "flex-start" as const, marginBottom: 16, gap: 10 },
    modalTitle: { fontSize: 17, fontWeight: "700" as const, color: c.text },
    modalSub:   { fontSize: 12, color: c.muted, marginTop: 3 },
    closeBtn:   { width: 32, height: 32, borderRadius: 9, borderWidth: 1, borderColor: c.border,
                  backgroundColor: c.surface1, alignItems: "center" as const, justifyContent: "center" as const },
    sectionTitle:{ fontSize: 11, fontWeight: "600" as const, color: c.muted,
                   textTransform: "uppercase" as const, letterSpacing: 0.6, marginBottom: 8 },
    divider:    { height: 1, backgroundColor: c.border, marginVertical: 14 },
    actionRow:  { flexDirection: "row" as const, gap: 8 },

    // SSH block
    sshBlock:   { flexDirection: "row" as const, alignItems: "center" as const,
                  backgroundColor: c.surface1, borderRadius: 9, padding: 12, marginBottom: 14,
                  gap: 8, borderWidth: 1, borderColor: c.border },
    sshCmd:     { flex: 1, fontSize: 12.5, color: c.accent, fontFamily: MONO },
    copyBtn:    { width: 30, height: 30, borderRadius: 7, backgroundColor: c.surface0,
                  borderWidth: 1, borderColor: c.border,
                  alignItems: "center" as const, justifyContent: "center" as const },

    // Cred rows
    credRows:   { gap: 8 },
    credRow:    { flexDirection: "row" as const, alignItems: "center" as const,
                  backgroundColor: c.surface1, borderRadius: 9, padding: 11, gap: 10,
                  borderWidth: 1, borderColor: c.border },
    credLabel:  { fontSize: 12, color: c.muted, width: 62 },
    credVal:    { flex: 1, fontSize: 12.5, color: c.text, fontFamily: MONO },
    credMasked: { letterSpacing: 3, color: c.muted },
    credActions:{ flexDirection: "row" as const, gap: 6 },
    icoBtn:     { width: 30, height: 30, borderRadius: 7, backgroundColor: c.surface0,
                  borderWidth: 1, borderColor: c.border,
                  alignItems: "center" as const, justifyContent: "center" as const },
    icoBtnCopied:{ borderColor: c.success, backgroundColor: `${c.success}15` },

    // Info grid
    infoGrid:   { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    infoCell:   { width: "48%" as any, backgroundColor: c.surface1, borderRadius: 9,
                  padding: 11, borderWidth: 1, borderColor: c.border },
    infoCellLabel:{ fontSize: 11, color: c.muted, marginBottom: 4 },
    infoCellVal:{ fontSize: 13, fontWeight: "600" as const, color: c.text },
    noteText:   { fontSize: 12.5, color: c.muted, lineHeight: 19, marginTop: 10,
                  padding: 11, backgroundColor: c.surface1, borderRadius: 9 },

    // Form rows
    fRow:       { flexDirection: "row" as const, alignItems: "center" as const, marginBottom: 10 },
    fLabel:     { width: 62, fontSize: 12.5, color: c.muted, fontWeight: "500" as const, flexShrink: 0 },
    fField:     { flex: 1, flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
    fInput:     { flex: 1, backgroundColor: c.surface1, borderRadius: 8, borderWidth: 1,
                  borderColor: c.border, paddingHorizontal: 11, paddingVertical: 8,
                  fontSize: 13, color: c.text },
    fSep:       { fontSize: 14, color: c.muted, paddingHorizontal: 3 },

    // Collapsible section
    moreToggle: { flexDirection: "row" as const, alignItems: "center" as const,
                  paddingVertical: 8, gap: 5, marginBottom: 2 },
    moreToggleText: { fontSize: 13, color: c.accent, fontWeight: "500" as const },
    moreHint:   { fontSize: 11.5, color: c.muted, flex: 1 },
    moreBody:   { marginBottom: 4 },

    // Self-monitoring panel
    selfPanel:  { marginTop: 18, backgroundColor: c.surface0, borderRadius: 12,
                  borderWidth: 1, borderColor: c.border, overflow: "hidden" as const },
    selfHdr:    { flexDirection: "row" as const, justifyContent: "space-between" as const,
                  alignItems: "center" as const, paddingHorizontal: 14, paddingVertical: 11 },
    selfTitle:  { fontSize: 12.5, fontWeight: "600" as const },
    selfSummary:{ fontSize: 11.5, color: c.muted },
    selfBody:   { paddingHorizontal: 14, paddingBottom: 14, borderTopWidth: 1, borderTopColor: c.border },
    selfGrid:   { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 12 },
    selfCell:   { width: "23%" as any, backgroundColor: c.surface1, borderRadius: 8,
                  padding: 9, borderWidth: 1, borderColor: c.border },
    selfCellLabel:{ fontSize: 10.5, color: c.muted, marginBottom: 3 },
    selfCellVal:{ fontSize: 12.5, fontWeight: "600" as const, color: c.text },
    selfNote:   { fontSize: 11, color: c.muted, marginTop: 12, lineHeight: 16 },

    // Form misc
    formHint:   { fontSize: 11, color: c.muted, marginTop: 3 },
    authToggle: { flexDirection: "row" as const, gap: 8, flex: 1 },
    authOption: { flex: 1, flexDirection: "row" as const, alignItems: "center" as const,
                  justifyContent: "center" as const, gap: 5,
                  paddingVertical: 9, borderRadius: 8, borderWidth: 1,
                  borderColor: c.border, backgroundColor: c.surface1 },
    authOptionOn:   { borderColor: c.accent, backgroundColor: `${c.accent}18` },
    authOptionText: { fontSize: 13, color: c.muted },
    authOptionTextOn:{ fontSize: 13, color: c.accent, fontWeight: "600" as const },

    versionFooter: { fontSize: 11, color: c.muted, textAlign: "right" as const,
                     marginTop: 14, opacity: 0.7 },
  };
}
