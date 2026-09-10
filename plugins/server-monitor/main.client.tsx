import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import React, { useMemo, useState, useEffect } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listServers, getMetrics, getCredentials,
  addServer, editServer, removeServer, testServer, testNewConnection,
  getSelfStats,
} from "./contracts";
import type { ServerSummary, Metrics, SelfStats } from "./contracts";

// ── Helpers ────────────────────────────────────────────────────────────────────

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
  if (s < 60)  return `${s}s 前`;
  if (s < 3600) return `${Math.floor(s/60)}m 前`;
  return `${Math.floor(s/3600)}h 前`;
}

type Colors = Record<string, string>;
type Styles = ReturnType<typeof makeStyles>;

// ── Small shared components (top-level — stable identity across re-renders) ───

function Bar({ pct, s, c }: { pct: number; s: Styles; c: Colors }) {
  const sev = barSeverity(pct);
  const fill = sev === "danger" ? c.statusDanger
             : sev === "warn"   ? c.statusWarning
             : c.accent;
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
    <Pressable onPress={onPress} style={[s.chip, active && s.chipOn]}>
      <Text style={[s.chipText, active && s.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

function Tag({ label, variant = "default", s, c }: {
  label: string;
  variant?: "default" | "region" | "spec" | "prod" | "dev";
  s: Styles; c: Colors;
}) {
  const col: Record<string, string> = {
    default: c.foregroundMuted,
    region:  c.accent,
    spec:    c.foregroundMuted,
    prod:    c.statusWarning,
    dev:     c.statusSuccess,
  };
  return (
    <View style={s.tag}>
      <Text style={[s.tagText, { color: col[variant] ?? c.foregroundMuted }]}>{label}</Text>
    </View>
  );
}

function MetricRow({ label, pct, valueStr, s, c }: {
  label: string; pct: number; valueStr: string; s: Styles; c: Colors;
}) {
  const sev = barSeverity(pct);
  const valColor = sev === "danger" ? c.statusDanger : sev === "warn" ? c.statusWarning : c.foregroundMuted;
  return (
    <View style={s.metricRow}>
      <View style={s.metricHdr}>
        <Text style={s.metricLabel}>{label}</Text>
        <Text style={[s.metricVal, { color: valColor }]}>{valueStr}</Text>
      </View>
      <Bar pct={pct} s={s} c={c} />
    </View>
  );
}

function CredRow({ label, value, copyKey, copied, onCopy, masked, onToggleMask, s }: {
  label: string; value: string; copyKey: string;
  copied: string | null; onCopy: (v: string, k: string) => void;
  masked?: boolean; onToggleMask?: () => void; s: Styles;
}) {
  const display = masked ? "•".repeat(Math.min(value.length, 16)) : value;
  return (
    <View style={s.credRow}>
      <Text style={s.credLabel}>{label}</Text>
      <Text style={[s.credVal, masked && s.credMasked]} numberOfLines={1}>{display}</Text>
      <View style={s.credActions}>
        {onToggleMask && (
          <Pressable style={s.icoBtn} onPress={onToggleMask}>
            <Text style={s.icoBtnText}>{masked ? "显示" : "隐藏"}</Text>
          </Pressable>
        )}
        <Pressable
          style={[s.icoBtn, copied === copyKey && s.icoBtnCopied]}
          onPress={() => onCopy(value, copyKey)}
        >
          <Text style={[s.icoBtnText, copied === copyKey && s.icoBtnCopiedText]}>
            {copied === copyKey ? "已复制 ✓" : "复制"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function InfoCell({ label, value, danger, warn, s, c }: {
  label: string; value: string; danger?: boolean; warn?: boolean; s: Styles; c: Colors;
}) {
  const valColor = danger ? c.statusDanger : warn ? c.statusWarning : c.foreground;
  return (
    <View style={s.infoCell}>
      <Text style={s.infoCellLabel}>{label}</Text>
      <Text style={[s.infoCellVal, { color: valColor }]}>{value}</Text>
    </View>
  );
}

function ServerCard({ srv, m, s, c, onOpen }: {
  srv: ServerSummary; m: Metrics | undefined;
  s: Styles; c: Colors; onOpen: (id: string) => void;
}) {
  const offline = srv.status === "offline";
  const unknown = srv.status === "unknown";
  const statusColor = offline ? c.statusDanger : unknown ? c.foregroundMuted : c.statusSuccess;

  return (
    <Pressable
      style={({ pressed }) => [s.card, pressed && s.cardPressed]}
      onPress={() => onOpen(srv.id)}
    >
      <View style={s.cardHdr}>
        <View>
          <Text style={s.sname}>{srv.name}</Text>
          <Text style={s.shost}>{srv.host}:{srv.sshPort}</Text>
        </View>
        <View style={[s.badge, { backgroundColor: `${statusColor}22` }]}>
          <View style={[s.dot, { backgroundColor: statusColor }]} />
          <Text style={[s.badgeText, { color: statusColor }]}>
            {offline ? "离线" : unknown ? "未知" : "在线"}
          </Text>
        </View>
      </View>

      <View style={s.tagRow}>
        {srv.region ? <Tag label={srv.region} variant="region" s={s} c={c} /> : null}
        {srv.spec ? <Tag label={srv.spec} variant="spec" s={s} c={c} /> : null}
        {srv.tags.map((t) => (
          <Tag key={t} label={t} s={s} c={c}
            variant={t === "production" ? "prod" : t === "development" ? "dev" : "default"} />
        ))}
      </View>

      {m && m.status === "online" && m.cpu && m.memory && m.disk ? (
        <>
          <View style={s.metaRow}>
            {m.os && <Text style={s.metaText}>{m.os.name}</Text>}
            {m.uptime != null && <Text style={s.metaText}>▲ {fmtUptime(m.uptime)}</Text>}
            {m.load && <Text style={s.metaText}>负载 {m.load[0].toFixed(2)}</Text>}
          </View>

          <MetricRow label="CPU" pct={m.cpu.usage} valueStr={`${m.cpu.usage}%`} s={s} c={c} />
          <MetricRow
            label="内存"
            pct={Math.round((m.memory.used / m.memory.total) * 100)}
            valueStr={`${Math.round((m.memory.used / m.memory.total) * 100)}% · ${fmt(m.memory.used)} / ${fmt(m.memory.total)} GB`}
            s={s} c={c}
          />
          {m.disk[0] && (
            <MetricRow
              label={`磁盘 ${m.disk[0].mount}`}
              pct={Math.round((m.disk[0].used / m.disk[0].total) * 100)}
              valueStr={`${Math.round((m.disk[0].used / m.disk[0].total) * 100)}% · ${fmt(m.disk[0].used)} / ${fmt(m.disk[0].total)} GB`}
              s={s} c={c}
            />
          )}

          {m.network && (
            <View style={s.netRow}>
              {m.network.rxRate == null ? (
                <Text style={s.netText}>网络采样中…</Text>
              ) : (
                <>
                  <Text style={s.netText}>↓ {fmtRate(m.network.rxRate)}</Text>
                  <Text style={s.netText}>↑ {fmtRate(m.network.txRate ?? 0)}</Text>
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
        <Text style={s.mutedText}>加载指标中…</Text>
      )}

      <View style={s.cardFooter}>
        <Text style={s.mutedText}>{timeAgo(srv.lastFetchedAt)}</Text>
        <Pressable style={s.connBtn} onPress={() => onOpen(srv.id)}>
          <Text style={s.connBtnText}>🔑 连接信息</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

// ── Detail Modal (top-level) ───────────────────────────────────────────────────

function DetailModal({ srv, m, theme, compact, onClose, onEdit }: {
  srv: ServerSummary; m: Metrics | undefined;
  theme: PluginSurfaceProps["theme"]; compact: boolean;
  onClose: () => void; onEdit: (id: string) => void;
}) {
  const c = theme.colors;
  const s = useMemo(() => makeStyles(c, compact), [c, compact]);
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
      onClose();
    },
  });

  // Fix #3: include -i keyPath so the copied command actually works
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
    } finally { setTesting(false); }
  }

  return (
    <View style={s.overlay}>
      <View style={s.modal}>
        <ScrollView showsVerticalScrollIndicator={false}>
          <View style={s.modalHdr}>
            <View>
              <Text style={s.modalTitle}>{srv.name}</Text>
              {/* Fix #6: ServerSummary has no `os` — read it from metrics */}
              <Text style={s.modalSub}>{m?.os?.name ?? srv.host} · {srv.region} · {srv.spec}</Text>
            </View>
            <Pressable onPress={onClose} style={s.closeBtn}>
              <Text style={s.closeBtnText}>✕</Text>
            </Pressable>
          </View>

          <Text style={s.sectionTitle}>SSH 快速连接</Text>
          <View style={s.sshBlock}>
            <Text style={s.sshCmd} numberOfLines={1}>{sshCmd}</Text>
            <Pressable style={s.copyBtn} onPress={() => copy(sshCmd, "cmd")}>
              <Text style={s.copyBtnText}>{copied === "cmd" ? "已复制 ✓" : "复制"}</Text>
            </Pressable>
          </View>

          <Text style={s.sectionTitle}>认证信息</Text>
          {credsQuery.isLoading ? (
            <Text style={s.mutedText}>解密中…</Text>
          ) : creds ? (
            <View style={s.credRows}>
              <CredRow label="用户名" value={creds.user} copyKey="user" copied={copied} onCopy={copy} s={s} />
              {creds.password != null && (
                <CredRow
                  label="密码" value={creds.password} copyKey="pw"
                  copied={copied} onCopy={copy} s={s}
                  masked={!pwVisible} onToggleMask={() => setPwVisible((v) => !v)}
                />
              )}
              {creds.keyPath && (
                <CredRow label="私钥路径" value={creds.keyPath} copyKey="key" copied={copied} onCopy={copy} s={s} />
              )}
            </View>
          ) : null}

          <View style={s.divider} />

          <Text style={s.sectionTitle}>标签</Text>
          <View style={s.tagRow}>
            {srv.region ? <Tag label={srv.region} variant="region" s={s} c={c} /> : null}
            {srv.spec   ? <Tag label={srv.spec}   variant="spec"   s={s} c={c} /> : null}
            {srv.tags.map((t) => (
              <Tag key={t} label={t} s={s} c={c}
                variant={t === "production" ? "prod" : t === "development" ? "dev" : "default"} />
            ))}
          </View>

          <View style={s.divider} />

          <Text style={s.sectionTitle}>服务器信息</Text>
          <View style={s.infoGrid}>
            <InfoCell label="地区" value={srv.region || "—"} s={s} c={c} />
            <InfoCell label="规格" value={srv.spec   || "—"} s={s} c={c} />
            <InfoCell label="月费" value={srv.cost   || "—"} s={s} c={c} />
            <InfoCell label="认证" value={srv.authMethod === "key" ? "SSH 私钥" : "密码"} s={s} c={c} />
          </View>
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
            style={[s.secondaryBtn, testing && s.btnDisabled]}
            onPress={runTest}
            disabled={testing}
          >
            <Text style={s.secondaryBtnText}>{testing ? "测试中…" : "测试连接"}</Text>
          </Pressable>
          {testResult && (
            <Text style={testResult.ok ? s.okText : s.errText}>
              {testResult.ok
                ? `✅ 连接正常 · ${testResult.latencyMs}ms`
                : `❌ ${testResult.error}`}
            </Text>
          )}

          <View style={s.divider} />

          <View style={s.actionRow}>
            <Pressable style={s.secondaryBtn} onPress={() => onEdit(srv.id)}>
              <Text style={s.secondaryBtnText}>✎ 编辑配置</Text>
            </Pressable>
            {/* Fix #8: two-step delete confirmation */}
            <Pressable
              style={[s.dangerBtn, removeMutation.isPending && s.btnDisabled,
                confirmDel && { backgroundColor: `${c.statusDanger}22`, borderColor: c.statusDanger }]}
              onPress={() => {
                if (!confirmDel) { setConfirmDel(true); return; }
                removeMutation.mutate(srv.id);
              }}
              disabled={removeMutation.isPending}
            >
              <Text style={s.dangerBtnText}>
                {removeMutation.isPending ? "删除中…"
                  : confirmDel ? "⚠️ 再次点击确认删除"
                  : "✕ 删除服务器"}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </View>
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
  style?: any; s: Styles; c: Colors;
}) {
  return (
    <TextInput
      style={[s.fInput, flex != null && { flex }, style]}
      value={form[fkey]}
      onChangeText={(v) => setForm((f) => ({ ...f, [fkey]: v }))}
      placeholder={placeholder ?? ""}
      placeholderTextColor={c.foregroundMuted}
      secureTextEntry={secure}
      autoCapitalize="none"
      autoCorrect={false}
    />
  );
}

function ClassificationFields({ form, setForm, s, c }: {
  form: FormState; setForm: React.Dispatch<React.SetStateAction<FormState>>;
  s: Styles; c: Colors;
}) {
  return (
    <View style={s.moreBody}>
      <View style={s.fRow}>
        <Text style={s.fLabel}>地区</Text>
        <View style={s.fField}>
          <FInp fkey="region" form={form} setForm={setForm} placeholder="华东-上海" flex={1} s={s} c={c} />
        </View>
        <Text style={s.fSep} />
        <View style={{ width: 90 }}>
          <FInp fkey="spec" form={form} setForm={setForm} placeholder="4核 8GB" s={s} c={c} />
        </View>
      </View>
      <View style={s.fRow}>
        <Text style={s.fLabel}>核数</Text>
        <View style={s.fField}>
          <FInp fkey="cores" form={form} setForm={setForm} placeholder="4"
            style={{ width: 52, textAlign: "center", flex: 0 }} s={s} c={c} />
        </View>
        <Text style={s.fSep} />
        <View style={{ width: 90 }}>
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
  isEdit: boolean; s: Styles; c: Colors;
}) {
  return (
    <>
      <FRow label="认证" s={s}>
        <View style={s.authToggle}>
          {(["key", "password"] as const).map((m) => (
            <Pressable key={m}
              style={[s.authOption, form.authMethod === m && s.authOptionOn]}
              onPress={() => setForm((f) => ({ ...f, authMethod: m }))}>
              <Text style={[s.authOptionText, form.authMethod === m && s.authOptionTextOn]}>
                {m === "key" ? "🔑 私钥" : "🔒 密码"}
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
          <Text style={[s.formHint, { marginTop: -4, marginBottom: 8 }]}>
            密码经 AES-256-GCM 加密存储；本机已内置 plink 支持密码认证
          </Text>
        </>
      )}
    </>
  );
}

// ── Add Server Modal (top-level) ───────────────────────────────────────────────

function AddServerModal({ theme, compact, onClose }: {
  theme: PluginSurfaceProps["theme"]; compact: boolean; onClose: () => void;
}) {
  const c = theme.colors;
  const s = useMemo(() => makeStyles(c, compact), [c, compact]);
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
      onClose();
    },
  });

  // Fix #2: test via testNewConnection RPC — no temp record ever created
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
    <View style={s.overlay}>
      <View style={[s.modal, { paddingBottom: 8 }]}>
        <View style={[s.modalHdr, { marginBottom: 14 }]}>
          <Text style={s.modalTitle}>添加服务器</Text>
          <Pressable onPress={onClose} style={s.closeBtn}>
            <Text style={s.closeBtnText}>✕</Text>
          </Pressable>
        </View>

        <FRow label="名称" s={s}>
          <FInp fkey="name" form={form} setForm={setForm} placeholder="web-01（留空则用 IP）" s={s} c={c} />
        </FRow>
        <FRow label="主机" s={s}>
          <FInp fkey="host" form={form} setForm={setForm} placeholder="192.168.1.10" flex={1} s={s} c={c} />
          <Text style={s.fSep}>:</Text>
          <FInp fkey="sshPort" form={form} setForm={setForm} placeholder="22"
            style={{ width: 56, textAlign: "center", flex: 0 }} s={s} c={c} />
        </FRow>
        <FRow label="用户名" s={s}>
          <FInp fkey="sshUser" form={form} setForm={setForm} placeholder="root" s={s} c={c} />
        </FRow>

        <AuthSection form={form} setForm={setForm} isEdit={false} s={s} c={c} />

        <Pressable style={s.moreToggle} onPress={() => setShowMore((v) => !v)}>
          <Text style={s.moreToggleText}>
            {showMore ? "▾" : "▸"} 分类与标签（可选）
          </Text>
          {(form.region || form.tags) ? (
            <Text style={s.moreHint}>
              {[form.region, form.tags].filter(Boolean).join(" · ")}
            </Text>
          ) : null}
        </Pressable>
        {showMore && <ClassificationFields form={form} setForm={setForm} s={s} c={c} />}

        <View style={s.divider} />

        {testResult && (
          <Text style={[testResult.ok ? s.okText : s.errText, { marginBottom: 8, fontSize: 12 }]}
            numberOfLines={2}>
            {testResult.ok ? `✅ ${testResult.msg}` : `❌ ${testResult.msg}`}
          </Text>
        )}

        <View style={[s.actionRow, { gap: 8 }]}>
          <Pressable
            style={[s.secondaryBtn, { flex: 1, marginBottom: 0 },
              (testing || !formValid) && s.btnDisabled]}
            onPress={handleTest}
            disabled={testing || !formValid}
          >
            <Text style={s.secondaryBtnText}>{testing ? "测试中…" : "🔌 测试"}</Text>
          </Pressable>
          <Pressable
            style={[s.btn, s.btnPrimary, { flex: 1, justifyContent: "center" as const, paddingVertical: 10 },
              (!formValid || addMutation.isPending) && s.btnDisabled]}
            onPress={handleSubmit}
            disabled={!formValid || addMutation.isPending}
          >
            <Text style={s.btnPrimaryText}>
              {addMutation.isPending ? "保存中…" : "✓ 保存"}
            </Text>
          </Pressable>
        </View>

        {addMutation.isError && (
          <Text style={[s.errText, { marginTop: 6 }]}>
            保存失败: {String(addMutation.error)}
          </Text>
        )}
      </View>
    </View>
  );
}

// ── Edit Server Modal (top-level) ──────────────────────────────────────────────

function EditServerModal({ srv, theme, compact, onClose }: {
  srv: ServerSummary;
  theme: PluginSurfaceProps["theme"]; compact: boolean; onClose: () => void;
}) {
  const c = theme.colors;
  const s = useMemo(() => makeStyles(c, compact), [c, compact]);
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

  // Fix #10: populate user/keyPath once creds finish decrypting
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
      onClose();
    },
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
    <View style={s.overlay}>
      <View style={[s.modal, { paddingBottom: 8 }]}>
        <View style={[s.modalHdr, { marginBottom: 14 }]}>
          <Text style={s.modalTitle}>编辑服务器</Text>
          <Pressable onPress={onClose} style={s.closeBtn}>
            <Text style={s.closeBtnText}>✕</Text>
          </Pressable>
        </View>

        <FRow label="名称" s={s}>
          <FInp fkey="name" form={form} setForm={setForm} placeholder="web-01" s={s} c={c} />
        </FRow>
        <FRow label="主机" s={s}>
          <FInp fkey="host" form={form} setForm={setForm} placeholder="192.168.1.10" flex={1} s={s} c={c} />
          <Text style={s.fSep}>:</Text>
          <FInp fkey="sshPort" form={form} setForm={setForm} placeholder="22"
            style={{ width: 56, textAlign: "center", flex: 0 }} s={s} c={c} />
        </FRow>
        <FRow label="用户名" s={s}>
          <FInp fkey="sshUser" form={form} setForm={setForm} placeholder="root" s={s} c={c} />
        </FRow>

        <AuthSection form={form} setForm={setForm} isEdit s={s} c={c} />

        <Pressable style={s.moreToggle} onPress={() => setShowMore((v) => !v)}>
          <Text style={s.moreToggleText}>
            {showMore ? "▾" : "▸"} 分类与标签
          </Text>
          {!showMore && (srv.region || srv.tags.length > 0) && (
            <Text style={s.moreHint}>
              {[srv.region, srv.tags.join(", ")].filter(Boolean).join(" · ")}
            </Text>
          )}
        </Pressable>
        {showMore && <ClassificationFields form={form} setForm={setForm} s={s} c={c} />}

        <View style={s.divider} />

        {testResult && (
          <Text style={[testResult.ok ? s.okText : s.errText, { marginBottom: 8, fontSize: 12 }]}
            numberOfLines={2}>
            {testResult.ok ? `✅ ${testResult.msg}` : `❌ ${testResult.msg}`}
          </Text>
        )}

        <View style={[s.actionRow, { gap: 8 }]}>
          <Pressable
            style={[s.secondaryBtn, { flex: 1, marginBottom: 0 }, testing && s.btnDisabled]}
            onPress={handleTest}
            disabled={testing}
          >
            <Text style={s.secondaryBtnText}>{testing ? "测试中…" : "🔌 测试"}</Text>
          </Pressable>
          <Pressable
            style={[s.btn, s.btnPrimary, { flex: 1, justifyContent: "center" as const, paddingVertical: 10 },
              editMutation.isPending && s.btnDisabled]}
            onPress={handleSubmit}
            disabled={editMutation.isPending}
          >
            <Text style={s.btnPrimaryText}>
              {editMutation.isPending ? "保存中…" : "✓ 保存"}
            </Text>
          </Pressable>
        </View>

        {editMutation.isError && (
          <Text style={[s.errText, { marginTop: 6 }]}>
            保存失败: {String(editMutation.error)}
          </Text>
        )}
      </View>
    </View>
  );
}

// ── Self-stats panel (plugin's own footprint) ──────────────────────────────────

function SelfStatsPanel({ stats, s, c }: {
  stats: SelfStats | undefined; s: Styles; c: Colors;
}) {
  const [open, setOpen] = useState(false);
  if (!stats) return null;

  // Heuristic verdict: is this plugin cheap or expensive?
  const heavy = stats.cpuPct > 5 || stats.rssMB > 150;
  const verdictColor = heavy ? c.statusWarning : c.statusSuccess;
  const verdict = heavy
    ? "⚠️ 开销偏高 — 可考虑优化"
    : "✅ 开销正常 — 卡顿别怪我";

  return (
    <View style={s.selfPanel}>
      <Pressable style={s.selfHdr} onPress={() => setOpen((v) => !v)}>
        <Text style={[s.selfTitle, { color: verdictColor }]}>
          {open ? "▾" : "▸"} 插件自身开销 {verdict}
        </Text>
        <Text style={s.selfSummary}>
          {stats.rssMB} MB · CPU {stats.cpuPct}% · SSH {stats.sshCalls} 次
        </Text>
      </Pressable>

      {open && (
        <View style={s.selfBody}>
          <View style={s.selfGrid}>
            <SelfCell label="内存 RSS"    value={`${stats.rssMB} MB`}      s={s} c={c} warn={stats.rssMB > 150} />
            <SelfCell label="JS 堆"       value={`${stats.heapMB} MB`}     s={s} c={c} />
            <SelfCell label="CPU 近30s"   value={`${stats.cpuPct}%`}       s={s} c={c} warn={stats.cpuPct > 5} />
            <SelfCell label="CPU 累计"    value={`${stats.cpuTotalSec}s`}  s={s} c={c} />
            <SelfCell label="SSH 调用"    value={`${stats.sshCalls} 次`}   s={s} c={c} />
            <SelfCell label="SSH 失败"    value={`${stats.sshErrors} 次`}  s={s} c={c} warn={stats.sshErrors > stats.sshCalls * 0.5 && stats.sshCalls > 4} />
            <SelfCell label="SSH 平均耗时" value={`${stats.sshAvgMs} ms`}  s={s} c={c} />
            <SelfCell label="运行时长"    value={fmtUptime(stats.uptimeSec)} s={s} c={c} />
          </View>
          <Text style={s.selfNote}>
            估算能耗 ≈ {((stats.cpuPct / 100) * 15).toFixed(2)} W（按单核满载 15W 折算，仅供参考）·
            PID {stats.pid} · 监控 {stats.servers} 台 · 缓存 {stats.cacheEntries} 条
          </Text>
        </View>
      )}
    </View>
  );
}

function SelfCell({ label, value, warn, s, c }: {
  label: string; value: string; warn?: boolean; s: Styles; c: Colors;
}) {
  return (
    <View style={s.selfCell}>
      <Text style={s.selfCellLabel}>{label}</Text>
      <Text style={[s.selfCellVal, warn && { color: c.statusWarning }]}>{value}</Text>
    </View>
  );
}

// ── Main surface ───────────────────────────────────────────────────────────────

export function MonitorSurface({ theme, layout }: PluginSurfaceProps) {
  const compact = layout.compact;
  const qc = useQueryClient();

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
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
  });

  const metricsQuery = useQuery({
    queryKey: ["monitor", "metrics"],
    queryFn: () => metricsRpc({ forceRefresh: false }),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 20_000,
    enabled: !!(listQuery.data?.servers.length),
  });

  // Plugin's own footprint — cheap RPC, piggybacks on the metrics cadence
  const selfQuery = useQuery({
    queryKey: ["monitor", "self"],
    queryFn: () => selfRpc({}),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 20_000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => metricsRpc({ forceRefresh: true }),
    onSuccess: (data) => qc.setQueryData(["monitor", "metrics"], data),
  });

  // ── Derived data
  const servers  = listQuery.data?.servers ?? [];
  const metMap   = useMemo(() => {
    const m = new Map<string, Metrics>();
    for (const x of metricsQuery.data?.metrics ?? []) m.set(x.serverId, x);
    return m;
  }, [metricsQuery.data]);

  const regions = useMemo(
    () => ["all", ...Array.from(new Set(servers.map((s) => s.region).filter(Boolean)))],
    [servers],
  );
  const coreOptions = useMemo(
    () => ["all", ...Array.from(new Set(servers.map((s) => String(s.cores)).filter((co) => co !== "0")))],
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

  const c = theme.colors;
  const s = useMemo(() => makeStyles(c, compact), [c, compact]);

  // ── Render
  if (listQuery.isLoading) {
    return (
      <View style={s.screen}>
        <Text style={s.header}>服务器监控</Text>
        <Text style={s.mutedText}>加载中…</Text>
      </View>
    );
  }

  if (listQuery.error) {
    return (
      <View style={s.screen}>
        <Text style={s.header}>服务器监控</Text>
        <Text style={s.errText}>加载失败: {String(listQuery.error)}</Text>
        <Pressable style={s.secondaryBtn} onPress={() => listQuery.refetch()}>
          <Text style={s.secondaryBtnText}>重试</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={s.hdr}>
          <Text style={s.header}>服务器监控</Text>
          <View style={s.hdrRight}>
            <Text style={s.mutedText}>{timeAgo(metricsQuery.dataUpdatedAt)}</Text>
            <Pressable
              style={[s.btn, refreshMutation.isPending && s.btnDisabled]}
              onPress={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
            >
              <Text style={s.btnText}>{refreshMutation.isPending ? "刷新中…" : "↻ 全部刷新"}</Text>
            </Pressable>
            <Pressable style={[s.btn, s.btnPrimary]} onPress={() => setShowAdd(true)}>
              <Text style={s.btnPrimaryText}>＋ 添加服务器</Text>
            </Pressable>
          </View>
        </View>
        <Text style={s.subtitle}>
          {servers.length} 台服务器 · 在线 {onlineCnt} · 离线 {offlineCnt} · 后台停止自动刷新
        </Text>

        <View style={s.tiles}>
          <View style={s.tile}>
            <Text style={s.tileLabel}>在线</Text>
            <Text style={[s.tileVal, { color: c.statusSuccess }]}>{onlineCnt}</Text>
          </View>
          <View style={s.tile}>
            <Text style={s.tileLabel}>离线</Text>
            <Text style={[s.tileVal, { color: c.statusDanger }]}>{offlineCnt}</Text>
          </View>
          <View style={s.tile}>
            <Text style={s.tileLabel}>平均 CPU</Text>
            <Text style={[s.tileVal, avgCpu != null && avgCpu >= 70 ? { color: c.statusWarning } : {}]}>
              {avgCpu != null ? `${avgCpu}%` : "—"}
            </Text>
          </View>
          <View style={s.tile}>
            <Text style={s.tileLabel}>平均内存</Text>
            <Text style={[s.tileVal, avgMem != null && avgMem >= 70 ? { color: c.statusWarning } : {}]}>
              {avgMem != null ? `${avgMem}%` : "—"}
            </Text>
          </View>
        </View>

        {servers.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterBar}>
            <View style={s.filterRow}>
              {(["all", "online", "offline"] as const).map((v) => (
                <Chip key={v} s={s}
                  label={v === "all" ? `全部 ${servers.length}` : v === "online" ? `● 在线 ${onlineCnt}` : `✕ 离线 ${offlineCnt}`}
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

        {/* Fix #11: empty-state onboarding when no servers exist */}
        {servers.length === 0 ? (
          <View style={s.emptyState}>
            <Text style={s.emptyIcon}>🖥️</Text>
            <Text style={[s.mutedText, { fontSize: 14, marginBottom: 4 }]}>还没有服务器</Text>
            <Text style={s.mutedText}>添加第一台服务器，开始监控 CPU / 内存 / 磁盘 / 网络</Text>
            <Pressable
              style={[s.btn, s.btnPrimary, { marginTop: 14, paddingHorizontal: 22, paddingVertical: 10 }]}
              onPress={() => setShowAdd(true)}
            >
              <Text style={[s.btnPrimaryText, { fontSize: 14 }]}>＋ 添加第一台服务器</Text>
            </Pressable>
          </View>
        ) : visible.length === 0 ? (
          <View style={s.emptyState}>
            <Text style={s.emptyIcon}>🔍</Text>
            <Text style={s.mutedText}>没有符合筛选条件的服务器</Text>
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

        <Text style={[s.mutedText, { textAlign: "right", marginTop: 12 }]}>
          server-monitor v0.3.0
        </Text>
      </ScrollView>

      {detailServer && (
        <DetailModal
          srv={detailServer}
          m={metMap.get(detailServer.id)}
          theme={theme}
          compact={compact}
          onClose={() => setDetailId(null)}
          onEdit={(id) => { setDetailId(null); setEditId(id); }}
        />
      )}

      {showAddForm && (
        <AddServerModal theme={theme} compact={compact} onClose={() => setShowAdd(false)} />
      )}

      {editServer_ && (
        <EditServerModal srv={editServer_} theme={theme} compact={compact} onClose={() => setEditId(null)} />
      )}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

function makeStyles(c: Record<string, string>, compact: boolean) {
  const p = compact ? 14 : 20;
  return {
    screen:     { flex: 1, backgroundColor: c.surface0, padding: p },
    hdr:        { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, marginBottom: 4 },
    header:     { fontSize: compact ? 19 : 22, fontWeight: "600" as const, color: c.foreground },
    hdrRight:   { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    subtitle:   { fontSize: compact ? 11 : 12, color: c.foregroundMuted, marginBottom: 14 },

    // Tiles
    tiles:      { flexDirection: "row" as const, gap: 10, marginBottom: 14 },
    tile:       { flex: 1, backgroundColor: c.surface1, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: c.border },
    tileLabel:  { fontSize: 11, color: c.foregroundMuted, marginBottom: 4 },
    tileVal:    { fontSize: 22, fontWeight: "600" as const, color: c.foreground },

    // Filter bar
    filterBar:  { marginBottom: 14 },
    filterRow:  { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    filterSep:  { width: 1, height: 16, backgroundColor: c.border, marginHorizontal: 4 },
    filterLabel:{ fontSize: 11, color: c.foregroundMuted },
    chip:       { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 },
    chipOn:     { borderColor: c.accent, backgroundColor: `${c.accent}1a` },
    chipText:   { fontSize: 11.5, color: c.foregroundMuted },
    chipTextOn: { color: c.accent },

    // Region group
    regionGroup:{ marginBottom: 16 },
    regionHdr:  { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, marginBottom: 8 },
    regionLine: { flex: 1, height: 1, backgroundColor: c.surface2 },
    regionName: { fontSize: 11, fontWeight: "600" as const, color: c.foregroundMuted },
    regionCount:{ fontSize: 10, color: c.foregroundMuted, backgroundColor: c.surface2, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10 },

    // Grid
    grid:       { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 10 },

    // Card
    card:       { width: "48%" as any, backgroundColor: c.surface1, borderRadius: 11, padding: compact ? 12 : 14, borderWidth: 1.5, borderColor: c.border },
    cardPressed:{ borderColor: c.accent, backgroundColor: c.surface2 },
    cardHdr:    { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "flex-start" as const, marginBottom: 7 },
    sname:      { fontSize: compact ? 13 : 14, fontWeight: "600" as const, color: c.foreground },
    shost:      { fontSize: 10, color: c.foregroundMuted, marginTop: 2 },
    badge:      { flexDirection: "row" as const, alignItems: "center" as const, gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
    dot:        { width: 6, height: 6, borderRadius: 3 },
    badgeText:  { fontSize: 10.5, fontWeight: "600" as const },
    tagRow:     { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 5, marginBottom: 8 },
    tag:        { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 20, backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border },
    tagText:    { fontSize: 10, color: c.foregroundMuted },
    metaRow:    { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginBottom: 8 },
    metaText:   { fontSize: 10.5, color: c.foregroundMuted },

    // Metric bar
    metricRow:  { marginBottom: 7 },
    metricHdr:  { flexDirection: "row" as const, justifyContent: "space-between" as const, marginBottom: 3 },
    metricLabel:{ fontSize: 10, color: c.foregroundMuted, textTransform: "uppercase" as const, letterSpacing: 0.5, fontWeight: "500" as const },
    metricVal:  { fontSize: 11, color: c.foregroundMuted },
    track:      { height: 5, backgroundColor: c.surface2, borderRadius: 3, overflow: "hidden" as const },
    fill:       { height: "100%" as any, borderRadius: 3 },

    // Network
    netRow:     { flexDirection: "row" as const, gap: 10, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: c.surface2 },
    netText:    { fontSize: 11, color: c.foregroundMuted },

    // Offline
    offlineBox: { marginVertical: 8 },
    offlineText:{ fontSize: 11.5, color: c.foregroundMuted, marginBottom: 6 },
    errText:    { fontSize: 11, color: c.statusDanger, lineHeight: 16 },
    okText:     { fontSize: 11, color: c.statusSuccess },

    // Card footer
    cardFooter: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: c.surface2 },
    connBtn:    { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 5, backgroundColor: `${c.accent}1a`, borderWidth: 1, borderColor: `${c.accent}40` },
    connBtnText:{ fontSize: 10.5, color: c.accent },

    // Buttons
    btn:        { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 7, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 },
    btnText:    { fontSize: 12, color: c.foregroundMuted },
    btnPrimary: { backgroundColor: c.accent, borderColor: c.accent },
    btnPrimaryText: { fontSize: 12, color: c.accentForeground },
    btnDisabled:{ opacity: 0.45 },
    secondaryBtn:   { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: c.border, alignItems: "center" as const, marginBottom: 6 },
    secondaryBtnText:{ fontSize: 12.5, color: c.foregroundMuted },
    dangerBtn:  { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: `${c.statusDanger}50`, alignItems: "center" as const },
    dangerBtnText:{ fontSize: 12.5, color: c.statusDanger },

    // Empty
    emptyState: { alignItems: "center" as const, paddingVertical: 40 },
    emptyIcon:  { fontSize: 32, marginBottom: 10 },
    mutedText:  { fontSize: 12, color: c.foregroundMuted },

    // Modal
    overlay:    { position: "absolute" as const, inset: 0 as any, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "center" as const, alignItems: "center" as const, zIndex: 100 },
    modal:      { width: "88%" as any, maxHeight: "90%" as any, backgroundColor: c.surface1, borderRadius: 14, padding: compact ? 18 : 22, borderWidth: 1, borderColor: c.border },
    modalHdr:   { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "flex-start" as const, marginBottom: 16 },
    modalTitle: { fontSize: compact ? 17 : 19, fontWeight: "600" as const, color: c.foreground },
    modalSub:   { fontSize: 11.5, color: c.foregroundMuted, marginTop: 3 },
    closeBtn:   { width: 28, height: 28, borderRadius: 7, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2, alignItems: "center" as const, justifyContent: "center" as const },
    closeBtnText:{ fontSize: 13, color: c.foregroundMuted },
    sectionTitle:{ fontSize: 10.5, fontWeight: "600" as const, color: c.foregroundMuted, textTransform: "uppercase" as const, letterSpacing: 0.7, marginBottom: 8 },
    divider:    { height: 1, backgroundColor: c.surface2, marginVertical: 14 },
    actionRow:  { flexDirection: "row" as const, gap: 8 },

    // SSH block
    sshBlock:   { flexDirection: "row" as const, alignItems: "center" as const, backgroundColor: c.surface0, borderRadius: 8, padding: 10, marginBottom: 14, gap: 8, borderWidth: 1, borderColor: c.surface2 },
    sshCmd:     { flex: 1, fontSize: 12, color: c.accent, fontFamily: "monospace" },
    copyBtn:    { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border },
    copyBtnText:{ fontSize: 11, color: c.foregroundMuted },

    // Cred rows
    credRows:   { gap: 6 },
    credRow:    { flexDirection: "row" as const, alignItems: "center" as const, backgroundColor: c.surface2, borderRadius: 8, padding: 10, gap: 8, borderWidth: 1, borderColor: c.surface2 },
    credLabel:  { fontSize: 11, color: c.foregroundMuted, width: 60 },
    credVal:    { flex: 1, fontSize: 12, color: c.foreground, fontFamily: "monospace" },
    credMasked: { letterSpacing: 3, color: c.foregroundMuted },
    credActions:{ flexDirection: "row" as const, gap: 5 },
    icoBtn:     { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5, backgroundColor: c.surface0, borderWidth: 1, borderColor: c.border },
    icoBtnText: { fontSize: 10.5, color: c.foregroundMuted },
    icoBtnCopied:{ borderColor: c.statusSuccess, backgroundColor: `${c.statusSuccess}15` },
    icoBtnCopiedText:{ color: c.statusSuccess },

    // Info grid
    infoGrid:   { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    infoCell:   { width: "47%" as any, backgroundColor: c.surface2, borderRadius: 8, padding: 10, borderWidth: 1, borderColor: c.border },
    infoCellLabel:{ fontSize: 10, color: c.foregroundMuted, marginBottom: 3 },
    infoCellVal:{ fontSize: 12.5, fontWeight: "500" as const, color: c.foreground },
    noteText:   { fontSize: 12, color: c.foregroundMuted, lineHeight: 18, marginTop: 8, padding: 10, backgroundColor: c.surface2, borderRadius: 8 },

    // Compact form rows
    fRow:       { flexDirection: "row" as const, alignItems: "center" as const, marginBottom: 8 },
    fLabel:     { width: 58, fontSize: 12, color: c.foregroundMuted, fontWeight: "500" as const, flexShrink: 0 },
    fField:     { flex: 1, flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
    fInput:     { flex: 1, backgroundColor: c.surface2, borderRadius: 8, borderWidth: 1,
                  borderColor: c.border, paddingHorizontal: 10, paddingVertical: 7,
                  fontSize: 13, color: c.foreground },
    fSep:       { fontSize: 14, color: c.foregroundMuted, paddingHorizontal: 2 },

    // Collapsible section
    moreToggle: { flexDirection: "row" as const, alignItems: "center" as const,
                  paddingVertical: 8, gap: 6, marginBottom: 2 },
    moreToggleText: { fontSize: 13, color: c.accent, fontWeight: "500" as const },
    moreHint:   { fontSize: 11, color: c.foregroundMuted, flex: 1 },
    moreBody:   { marginBottom: 4 },

    // Self-monitoring panel
    selfPanel:  { marginTop: 16, backgroundColor: c.surface1, borderRadius: 10, borderWidth: 1, borderColor: c.border, overflow: "hidden" as const },
    selfHdr:    { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, paddingHorizontal: 12, paddingVertical: 10 },
    selfTitle:  { fontSize: 12, fontWeight: "600" as const },
    selfSummary:{ fontSize: 11, color: c.foregroundMuted },
    selfBody:   { paddingHorizontal: 12, paddingBottom: 12, borderTopWidth: 1, borderTopColor: c.surface2 },
    selfGrid:   { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 10 },
    selfCell:   { width: "23%" as any, backgroundColor: c.surface2, borderRadius: 7, padding: 8, borderWidth: 1, borderColor: c.border },
    selfCellLabel:{ fontSize: 9.5, color: c.foregroundMuted, marginBottom: 2 },
    selfCellVal:{ fontSize: 12, fontWeight: "600" as const, color: c.foreground },
    selfNote:   { fontSize: 10, color: c.foregroundMuted, marginTop: 10, lineHeight: 15 },

    // Form misc
    formHint:   { fontSize: 10, color: c.foregroundMuted, marginTop: 3 },
    authToggle: { flexDirection: "row" as const, gap: 8 },
    authOption: { flex: 1, paddingVertical: 8, borderRadius: 8, borderWidth: 1,
                  borderColor: c.border, backgroundColor: c.surface2, alignItems: "center" as const },
    authOptionOn:   { borderColor: c.accent, backgroundColor: `${c.accent}18` },
    authOptionText: { fontSize: 13, color: c.foregroundMuted },
    authOptionTextOn:{ fontSize: 13, color: c.accent, fontWeight: "600" as const },
  };
}
