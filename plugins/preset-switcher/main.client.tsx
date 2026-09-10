import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createAgentWithPreset,
  exportPreset,
  importPreset,
  listPresets,
  previewPreset,
  removePreset,
  repairPreset,
} from "./contracts";

// Contracts live in ./contracts (node-free) and are shared with the backend
// entry, so input/output shapes can never drift between the two sides.

export function MainSurface({ theme, layout, navigation }: PluginSurfaceProps) {
  const listRpc = useRpc(listPresets);
  const previewRpc = useRpc(previewPreset);
  const repairRpc = useRpc(repairPreset);
  const createRpc = useRpc(createAgentWithPreset);
  const importRpc = useRpc(importPreset);
  const exportRpc = useRpc(exportPreset);
  const removeRpc = useRpc(removePreset);
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<string | null>(null);
  const [showPersona, setShowPersona] = useState(false);
  const [zipPath, setZipPath] = useState("");
  const [exportPath, setExportPath] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  const listQuery = useQuery({
    queryKey: ["presets", "list"],
    queryFn: () => listRpc({}),
  });

  const previewQuery = useQuery({
    queryKey: ["presets", "preview", selected],
    queryFn: () => previewRpc({ presetId: selected as string }),
    enabled: !!selected && showPersona,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["presets"] });

  const createMutation = useMutation({
    mutationFn: (presetId: string) => createRpc({ presetId }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      navigation?.openAgent({ agentId: res.agentId });
    },
  });

  const repairMutation = useMutation({
    mutationFn: () => repairRpc({}),
    onSuccess: invalidate,
  });

  const importMutation = useMutation({
    mutationFn: (path: string) => importRpc({ zipPath: path }),
    onSuccess: (res) => {
      setZipPath("");
      setSelected(res.id);
      invalidate();
    },
  });

  const exportMutation = useMutation({
    mutationFn: ({ presetId, destPath }: { presetId: string; destPath: string }) =>
      exportRpc({ presetId, destPath }),
  });

  const removeMutation = useMutation({
    mutationFn: (presetId: string) => removeRpc({ presetId }),
    onSuccess: (_res, presetId) => {
      if (selected === presetId) setSelected(null);
      setConfirmRemove(false);
      invalidate();
    },
  });

  const compact = layout.compact;
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: compact ? 14 : 22,
        backgroundColor: theme.colors.surface0,
      },
      header: {
        color: theme.colors.foreground,
        fontSize: compact ? 19 : 23,
        fontWeight: "600" as const,
        marginBottom: 6,
      },
      subtitle: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 12 : 13,
        marginBottom: 14,
        lineHeight: (compact ? 17 : 19) as number,
      },
      warnBox: {
        padding: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.statusWarning,
        marginBottom: 12,
      },
      warnText: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        lineHeight: 17,
      },
      card: {
        padding: compact ? 12 : 16,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        borderWidth: 2,
        borderColor: theme.colors.border,
        marginBottom: compact ? 8 : 10,
      },
      cardSelected: { borderColor: theme.colors.accent },
      cardTop: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        marginBottom: 4,
        gap: 8,
      },
      name: {
        color: theme.colors.foreground,
        fontSize: compact ? 15 : 17,
        fontWeight: "600" as const,
        flexShrink: 1,
      },
      badges: { flexDirection: "row" as const, gap: 6 },
      badge: {
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 5,
        backgroundColor: theme.colors.surface2,
      },
      badgeText: {
        color: theme.colors.statusSuccess,
        fontSize: 10,
        fontWeight: "600" as const,
      },
      badgeMutedText: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        fontWeight: "600" as const,
      },
      badgeWarnText: {
        color: theme.colors.statusWarning,
        fontSize: 10,
        fontWeight: "600" as const,
      },
      desc: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 11.5 : 12.5,
        lineHeight: (compact ? 16 : 18) as number,
        marginBottom: 8,
      },
      row: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 6,
      },
      chip: {
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 5,
        backgroundColor: theme.colors.surface2,
      },
      chipText: { color: theme.colors.foregroundMuted, fontSize: 10.5 },
      chipAccent: { color: theme.colors.accent, fontSize: 10.5 },
      chipWarn: { color: theme.colors.statusWarning, fontSize: 10.5 },
      cwd: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        marginTop: 7,
        opacity: 0.75,
      },
      linkRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 10,
        marginTop: 9,
      },
      link: {
        paddingHorizontal: 9,
        paddingVertical: 5,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
      },
      linkText: { color: theme.colors.foreground, fontSize: 11.5 },
      linkDangerText: { color: theme.colors.statusDanger, fontSize: 11.5 },
      personaBox: {
        marginTop: 9,
        padding: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      personaText: {
        color: theme.colors.foreground,
        fontSize: 11,
        lineHeight: 16,
        fontFamily: compact ? undefined : "monospace",
      },
      primary: {
        marginTop: 14,
        padding: compact ? 13 : 15,
        borderRadius: 9,
        backgroundColor: theme.colors.accent,
        alignItems: "center" as const,
      },
      primaryDisabled: { opacity: 0.45 },
      primaryText: {
        color: theme.colors.accentForeground,
        fontSize: compact ? 14 : 15,
        fontWeight: "600" as const,
      },
      secondary: {
        marginTop: 8,
        padding: 10,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: theme.colors.border,
        alignItems: "center" as const,
      },
      secondaryText: { color: theme.colors.foregroundMuted, fontSize: 12.5 },
      sectionTitle: {
        color: theme.colors.foreground,
        fontSize: 13,
        fontWeight: "600" as const,
        marginTop: 18,
        marginBottom: 6,
      },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        color: theme.colors.foreground,
        fontSize: 12,
        backgroundColor: theme.colors.surface1,
        marginBottom: 8,
      },
      ok: {
        color: theme.colors.statusSuccess,
        fontSize: 12,
        marginTop: 10,
        lineHeight: 17,
      },
      err: {
        color: theme.colors.statusDanger,
        fontSize: 12,
        marginTop: 10,
        lineHeight: 17,
      },
    }),
    [theme, compact],
  );

  if (listQuery.isLoading) {
    return (
      <View style={styles.screen}>
        <Text style={styles.header}>预设切换</Text>
        <Text style={styles.subtitle}>加载中…</Text>
      </View>
    );
  }

  if (listQuery.error) {
    return (
      <View style={styles.screen}>
        <Text style={styles.header}>预设切换</Text>
        <Text style={styles.err}>加载失败: {String(listQuery.error)}</Text>
        <Pressable style={styles.secondary} onPress={() => listQuery.refetch()}>
          <Text style={styles.secondaryText}>重试</Text>
        </Pressable>
      </View>
    );
  }

  const presets = listQuery.data?.presets ?? [];
  const scanErrors = listQuery.data?.scanErrors ?? [];
  const selectedPreset = presets.find((p) => p.id === selected);

  return (
    <ScrollView style={styles.screen}>
      <Text style={styles.header}>预设切换</Text>
      <Text style={styles.subtitle}>
        每个预设在自己的目录中启动 agent：人格 = PERSONA.md，技能按 provider adapter
        挂载。导入 zip 预设包即可扩展；做普通项目选「默认编码」。
      </Text>

      {scanErrors.length > 0 && (
        <View style={styles.warnBox}>
          <Text style={styles.warnText}>
            ⚠️ {scanErrors.length} 个预设目录的 preset.json 解析失败：
            {"\n"}
            {scanErrors.map((e) => `• ${e.dir}\n  ${e.error}`).join("\n")}
          </Text>
        </View>
      )}

      {presets.map((preset) => {
        const isSelected = selected === preset.id;
        return (
          <View key={preset.id}>
            <Pressable
              onPress={() => {
                setSelected(preset.id);
                setShowPersona(false);
                setConfirmRemove(false);
              }}
              style={[styles.card, isSelected && styles.cardSelected]}
            >
              <View style={styles.cardTop}>
                <Text style={styles.name}>{preset.name}</Text>
                <View style={styles.badges}>
                  <View style={styles.badge}>
                    <Text style={styles.badgeMutedText}>
                      {preset.origin === "seed" ? "内置" : "导入"}
                    </Text>
                  </View>
                  <View style={styles.badge}>
                    <Text style={preset.skillsReady ? styles.badgeText : styles.badgeWarnText}>
                      {preset.skills.length === 0
                        ? "无技能"
                        : preset.skillsReady
                          ? "技能✓"
                          : "技能缺失"}
                    </Text>
                  </View>
                  <View style={styles.badge}>
                    <Text style={styles.badgeMutedText}>
                      {preset.personaChars > 0 ? `persona ${preset.personaChars}字` : "无人格"}
                    </Text>
                  </View>
                </View>
              </View>

              <Text style={styles.desc}>{preset.description}</Text>

              <View style={styles.row}>
                <View style={styles.chip}>
                  <Text style={styles.chipAccent}>{preset.provider}</Text>
                </View>
                <View style={styles.chip}>
                  <Text style={styles.chipText}>{preset.model}</Text>
                </View>
                <View style={styles.chip}>
                  <Text style={styles.chipText}>{preset.modeId}</Text>
                </View>
                {preset.hasProtocol && (
                  <View style={styles.chip}>
                    <Text style={styles.chipAccent}>含内联协议</Text>
                  </View>
                )}
                {preset.skills.map((s) => (
                  <View key={s} style={styles.chip}>
                    <Text
                      style={
                        preset.missingSkills.includes(s) ? styles.chipWarn : styles.chipAccent
                      }
                    >
                      {s}
                    </Text>
                  </View>
                ))}
              </View>

              <Text style={styles.cwd} numberOfLines={1}>
                {preset.cwd}
              </Text>

              {isSelected && (
                <View style={styles.linkRow}>
                  <Pressable style={styles.link} onPress={() => setShowPersona((v) => !v)}>
                    <Text style={styles.linkText}>
                      {showPersona ? "收起 persona" : "查看 persona"}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.link}
                    onPress={() => createMutation.mutate(preset.id)}
                    disabled={createMutation.isPending}
                  >
                    <Text style={styles.linkText}>
                      {createMutation.isPending ? "启动中…" : "启动此预设"}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.link}
                    onPress={() => {
                      const dest = exportPath.trim() || `${preset.cwd}/../${preset.id}.zip`;
                      exportMutation.mutate({ presetId: preset.id, destPath: dest });
                    }}
                    disabled={exportMutation.isPending}
                  >
                    <Text style={styles.linkText}>
                      {exportMutation.isPending ? "导出中…" : "导出 zip"}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.link}
                    onPress={() => {
                      if (!confirmRemove) {
                        setConfirmRemove(true);
                        return;
                      }
                      removeMutation.mutate(preset.id);
                    }}
                    disabled={removeMutation.isPending}
                  >
                    <Text style={styles.linkDangerText}>
                      {removeMutation.isPending
                        ? "删除中…"
                        : confirmRemove
                          ? "确认删除？"
                          : "删除"}
                    </Text>
                  </Pressable>
                </View>
              )}

              {isSelected && confirmRemove && (
                <Text style={styles.cwd}>
                  将删除整个预设目录（含 CLAUDE.md / 技能联接），共享技能库不受影响。再点一次「确认删除？」执行。
                </Text>
              )}
            </Pressable>

            {isSelected && showPersona && (
              <View style={styles.personaBox}>
                {previewQuery.isLoading && <Text style={styles.personaText}>读取 persona…</Text>}
                {previewQuery.error && (
                  <Text style={styles.err}>读取失败: {String(previewQuery.error)}</Text>
                )}
                {previewQuery.data && (
                  <>
                    <Text style={styles.personaText}>
                      {previewQuery.data.persona || "（本预设不覆盖 system prompt）"}
                    </Text>
                    <Text style={styles.cwd}>
                      {previewQuery.data.personaChars} 字 · 技能已挂载:{" "}
                      {previewQuery.data.skillsMounted ? "是" : "否"}
                    </Text>
                  </>
                )}
              </View>
            )}
          </View>
        );
      })}

      <Pressable
        style={[styles.primary, !selected && styles.primaryDisabled]}
        disabled={!selected || createMutation.isPending}
        onPress={() => selected && createMutation.mutate(selected)}
      >
        <Text style={styles.primaryText}>
          {createMutation.isPending
            ? "启动中…"
            : selected
              ? `以「${selectedPreset?.name ?? selected}」启动 agent`
              : "先选择一个预设"}
        </Text>
      </Pressable>

      <Pressable
        style={styles.secondary}
        onPress={() => repairMutation.mutate()}
        disabled={repairMutation.isPending}
      >
        <Text style={styles.secondaryText}>
          {repairMutation.isPending ? "修复中…" : "修复预设目录（重建技能挂载 / 上下文文件）"}
        </Text>
      </Pressable>

      <Text style={styles.sectionTitle}>导入预设包（zip）</Text>
      <TextInput
        style={styles.input}
        value={zipPath}
        onChangeText={setZipPath}
        placeholder="zip 文件的绝对路径，如 D:/packs/web-recon.zip"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable
        style={[styles.secondary, !zipPath.trim() && styles.primaryDisabled]}
        disabled={!zipPath.trim() || importMutation.isPending}
        onPress={() => importMutation.mutate(zipPath.trim())}
      >
        <Text style={styles.secondaryText}>
          {importMutation.isPending ? "导入中…" : "导入"}
        </Text>
      </Pressable>

      <Text style={styles.sectionTitle}>导出路径（可选）</Text>
      <TextInput
        style={styles.input}
        value={exportPath}
        onChangeText={setExportPath}
        placeholder="留空 = 预设目录旁生成 <id>.zip"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
      />

      {createMutation.isSuccess && (
        <Text style={styles.ok}>
          ✅ 已启动「{createMutation.data.presetName}」 · {createMutation.data.provider} · persona{" "}
          {createMutation.data.personaChars} 字 · 技能{" "}
          {createMutation.data.skillsMounted ? "已挂载" : "未挂载"}
          {"\n"}
          cwd: {createMutation.data.cwd}
        </Text>
      )}
      {createMutation.isError && (
        <Text style={styles.err}>❌ 启动失败: {String(createMutation.error)}</Text>
      )}
      {repairMutation.isSuccess && (
        <Text style={styles.ok}>✅ 已修复 {repairMutation.data.repaired.length} 个预设目录</Text>
      )}
      {repairMutation.isError && (
        <Text style={styles.err}>❌ 修复失败: {String(repairMutation.error)}</Text>
      )}
      {importMutation.isSuccess && (
        <Text style={styles.ok}>
          ✅ 已导入「{importMutation.data.id}」 · {importMutation.data.files.length} 个文件
          {importMutation.data.skillsInstalled.length > 0 &&
            ` · 新装技能: ${importMutation.data.skillsInstalled.join(", ")}`}
          {importMutation.data.skillsSkipped.length > 0 &&
            ` · 已存在跳过: ${importMutation.data.skillsSkipped.join(", ")}`}
        </Text>
      )}
      {importMutation.isError && (
        <Text style={styles.err}>❌ 导入失败: {String(importMutation.error)}</Text>
      )}
      {exportMutation.isSuccess && (
        <Text style={styles.ok}>
          ✅ 已导出「{exportMutation.data.id}」 → {exportMutation.data.destPath}（
          {exportMutation.data.files} 个文件, {exportMutation.data.bytes} 字节）
        </Text>
      )}
      {exportMutation.isError && (
        <Text style={styles.err}>❌ 导出失败: {String(exportMutation.error)}</Text>
      )}
      {removeMutation.isSuccess && <Text style={styles.ok}>✅ 预设已删除</Text>}
      {removeMutation.isError && (
        <Text style={styles.err}>❌ 删除失败: {String(removeMutation.error)}</Text>
      )}
    </ScrollView>
  );
}
