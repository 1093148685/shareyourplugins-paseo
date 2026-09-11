/**
 * presets-data.ts — Provider preset catalog, ported from cc-switch
 * (src/config/claudeProviderPresets.ts, src/config/piProviderPresets.ts).
 *
 * Only the most commonly used presets are included. Add more as needed.
 * category order in UI: official > primePartner > partner > rest by name
 */
import type { ProviderCategory } from "./contracts";

export interface PresetTheme {
  icon?: "claude" | "generic";
  backgroundColor?: string;
  textColor?: string;
}

export interface ClaudePreset {
  id: string;
  name: string;
  websiteUrl: string;
  apiKeyUrl?: string;
  settingsConfig: Record<string, unknown>;
  category?: ProviderCategory;
  isPartner?: boolean;
  primePartner?: boolean;
  icon?: string;
  iconColor?: string;
  theme?: PresetTheme;
  endpointCandidates?: string[];
  modelsUrl?: string;
  apiKeyField?: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";
}

export interface PiPreset {
  id: string;
  name: string;
  providerKey: string;
  websiteUrl: string;
  apiKeyUrl?: string;
  settingsConfig: {
    name: string;
    baseUrl: string;
    api: string;
    apiKey: string;
    headers?: Record<string, string>;
    compat?: Record<string, unknown>;
    models: Array<{
      id: string;
      name?: string;
      reasoning?: boolean;
      input?: string[];
      contextWindow?: number;
      maxTokens?: number;
    }>;
  };
  category?: ProviderCategory;
  isPartner?: boolean;
  primePartner?: boolean;
  icon?: string;
  iconColor?: string;
}

// ── Claude presets ─────────────────────────────────────────────────────────────

export const claudePresets: ClaudePreset[] = [
  {
    id: "claude-official",
    name: "Claude Official",
    websiteUrl: "https://www.anthropic.com/claude-code",
    settingsConfig: { env: {} },
    category: "official",
    theme: { icon: "claude", backgroundColor: "#D97757", textColor: "#FFFFFF" },
    icon: "anthropic",
    iconColor: "#D4915D",
  },
  {
    id: "kimi",
    name: "Kimi",
    primePartner: true,
    websiteUrl: "https://platform.kimi.com",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_MODEL: "kimi-k2.7-code",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k2.7-code",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k2.7-code",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k2.7-code",
      },
    },
    category: "cn_official",
    icon: "kimi",
    iconColor: "#6366F1",
  },
  {
    id: "kimi-for-coding",
    name: "Kimi For Coding",
    primePartner: true,
    websiteUrl: "https://www.kimi.com/code/",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_MODEL: "kimi-for-coding",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-for-coding",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-for-coding",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-for-coding",
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "262144",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144",
      },
    },
    category: "cn_official",
    icon: "kimi",
    iconColor: "#6366F1",
  },
  {
    id: "packycode",
    name: "PackyCode",
    websiteUrl: "https://www.packyapi.ai",
    apiKeyUrl: "https://www.packyapi.ai/register",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://www.packyapi.ai",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    },
    endpointCandidates: [
      "https://www.packyapi.ai",
      "https://cf.api.fan",
      "https://slb-v1.api.fan",
      "https://www.packyapi.com",
    ],
    category: "third_party",
    isPartner: true,
    icon: "packycode",
  },
  {
    id: "zeta-api",
    name: "ZetaAPI",
    websiteUrl: "https://zetaapi.ai",
    apiKeyUrl: "https://zetaapi.ai",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://api.zetaapi.ai",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    },
    category: "aggregator",
    isPartner: true,
    icon: "zetaapi",
  },
  {
    id: "qiniu",
    name: "Qiniu",
    websiteUrl: "https://s.qiniu.com/nMvAvy",
    apiKeyUrl: "https://s.qiniu.com/nMvAvy",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://api.qnaigc.com",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    },
    endpointCandidates: ["https://api.qnaigc.com", "https://api.modelink.ai"],
    category: "aggregator",
    isPartner: true,
    icon: "qiniu",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    websiteUrl: "https://platform.deepseek.com",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
      },
    },
    category: "cn_official",
    modelsUrl: "https://api.deepseek.com/models",
    icon: "deepseek",
    iconColor: "#1E88E5",
  },
  {
    id: "zhipu-glm",
    name: "Zhipu GLM",
    websiteUrl: "https://open.bigmodel.cn",
    apiKeyUrl: "https://www.bigmodel.cn/claude-code",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_MODEL: "glm-5.1",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.1",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.1",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.1",
      },
    },
    category: "cn_official",
    icon: "zhipu",
    iconColor: "#0F62FE",
  },
  {
    id: "zhipu-glm-en",
    name: "Z.ai GLM",
    websiteUrl: "https://z.ai",
    apiKeyUrl: "https://z.ai/subscribe",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_MODEL: "glm-5.1",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.1",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.1",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.1",
      },
    },
    category: "cn_official",
    icon: "zhipu",
    iconColor: "#0F62FE",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    websiteUrl: "https://siliconflow.cn",
    apiKeyUrl: "https://cloud.siliconflow.cn",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://api.siliconflow.cn",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_MODEL: "Pro/MiniMaxAI/MiniMax-M2.5",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "Pro/MiniMaxAI/MiniMax-M2.5",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "Pro/MiniMaxAI/MiniMax-M2.5",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "Pro/MiniMaxAI/MiniMax-M2.5",
      },
    },
    category: "aggregator",
    isPartner: true,
    icon: "siliconflow",
    iconColor: "#6E29F6",
  },
  {
    id: "ppio",
    name: "PPIO",
    websiteUrl: "https://ppio.com",
    apiKeyUrl: "https://ppio.com",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://api.ppio.com/anthropic",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_MODEL: "deepseek/deepseek-v4-flash-0731",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek/deepseek-v4-flash-0731",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek/deepseek-v4-flash-0731",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek/deepseek-v4-flash-0731",
      },
    },
    category: "aggregator",
    isPartner: true,
    endpointCandidates: ["https://api.ppio.com/anthropic"],
    modelsUrl: "https://api.ppio.com/openai/v1/models",
    icon: "ppio",
    iconColor: "#2874FF",
  },
  {
    id: "volcengine-coding",
    name: "火山 Coding Plan",
    websiteUrl: "https://www.volcengine.com/activity/codingplan",
    apiKeyUrl: "https://www.volcengine.com/activity/codingplan",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://ark.cn-beijing.volces.com/api/coding",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_MODEL: "ark-code-latest",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "ark-code-latest",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "ark-code-latest",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "ark-code-latest",
      },
    },
    category: "cn_official",
    isPartner: true,
    icon: "huoshan",
    iconColor: "#3370FF",
  },
  {
    id: "qianwen",
    name: "千问AI平台",
    websiteUrl: "https://platform.qianwenai.com",
    apiKeyUrl: "https://platform.qianwenai.com/home/api-keys",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://dashscope.aliyuncs.com/apps/anthropic",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_MODEL: "qwen3.8-max",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3.8-flash",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3.7-plus",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen3.8-max",
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "983616",
      },
    },
    category: "cn_official",
    icon: "qwen",
    iconColor: "#FF6A00",
  },
  {
    id: "baidu-qianfan-coding",
    name: "Baidu Qianfan Coding Plan",
    websiteUrl: "https://cloud.baidu.com/product/qianfan_modelbuilder",
    apiKeyUrl: "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://qianfan.baidubce.com/anthropic/coding",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_MODEL: "qianfan-code-latest",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "qianfan-code-latest",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "qianfan-code-latest",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "qianfan-code-latest",
      },
    },
    category: "cn_official",
    endpointCandidates: ["https://qianfan.baidubce.com/anthropic/coding"],
    icon: "baidu",
    iconColor: "#2932E1",
  },
  {
    id: "shengsuanyun",
    name: "Shengsuanyun",
    websiteUrl: "https://www.shengsuanyun.com",
    apiKeyUrl: "https://www.shengsuanyun.com",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://router.shengsuanyun.com/api",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_MODEL: "anthropic/claude-sonnet-5",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-haiku-4.5",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "anthropic/claude-sonnet-5",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-5",
      },
    },
    category: "aggregator",
    isPartner: true,
    icon: "shengsuanyun",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    websiteUrl: "https://openrouter.ai",
    apiKeyUrl: "https://openrouter.ai/keys",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    },
    category: "aggregator",
    icon: "openrouter",
    iconColor: "#6366F1",
  },
];

// ── Pi presets ─────────────────────────────────────────────────────────────────

export const piPresets: PiPreset[] = [
  {
    id: "pi-kimi",
    name: "Kimi",
    providerKey: "cc-switch-kimi",
    websiteUrl: "https://platform.kimi.com",
    apiKeyUrl: "https://platform.kimi.com/console/api-keys",
    settingsConfig: {
      name: "Kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      api: "openai-completions",
      apiKey: "",
      models: [
        { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
        { id: "kimi-k3", name: "Kimi K3", reasoning: true, contextWindow: 262144, maxTokens: 32768 },
      ],
    },
    category: "cn_official",
    primePartner: true,
    icon: "kimi",
    iconColor: "#6366F1",
  },
  {
    id: "pi-kimi-for-coding",
    name: "Kimi For Coding",
    providerKey: "cc-switch-kimi-for-coding",
    websiteUrl: "https://www.kimi.com/code/",
    apiKeyUrl: "https://platform.kimi.com/console/api-keys",
    settingsConfig: {
      name: "Kimi For Coding",
      baseUrl: "https://api.kimi.com/coding",
      api: "anthropic-messages",
      apiKey: "",
      models: [
        { id: "kimi-for-coding", name: "Kimi For Coding", maxTokens: 32768 },
      ],
    },
    category: "cn_official",
    primePartner: true,
    icon: "kimi",
    iconColor: "#6366F1",
  },
  {
    id: "pi-packycode",
    name: "PackyCode",
    providerKey: "cc-switch-packy-code",
    websiteUrl: "https://www.packyapi.ai",
    apiKeyUrl: "https://www.packyapi.ai/register",
    settingsConfig: {
      name: "PackyCode",
      baseUrl: "https://www.packyapi.ai",
      api: "anthropic-messages",
      apiKey: "",
      models: [
        { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
        { id: "claude-opus-5", name: "Claude Opus 5" },
      ],
    },
    category: "third_party",
    isPartner: true,
    icon: "packycode",
  },
  {
    id: "pi-qiniu",
    name: "Qiniu",
    providerKey: "cc-switch-qiniu",
    websiteUrl: "https://s.qiniu.com/nMvAvy",
    apiKeyUrl: "https://s.qiniu.com/nMvAvy",
    settingsConfig: {
      name: "Qiniu",
      baseUrl: "https://api.qnaigc.com/v1",
      api: "openai-completions",
      apiKey: "",
      models: [
        { id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
      ],
    },
    category: "aggregator",
    isPartner: true,
    icon: "qiniu",
  },
  {
    id: "pi-deepseek",
    name: "DeepSeek",
    providerKey: "deepseek",
    websiteUrl: "https://platform.deepseek.com",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    settingsConfig: {
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      api: "openai-completions",
      apiKey: "",
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
      },
      models: [
        { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, contextWindow: 131072, maxTokens: 8192 },
        { id: "deepseek-flash", name: "DeepSeek Flash", contextWindow: 131072, maxTokens: 8192 },
      ],
    },
    category: "cn_official",
    icon: "deepseek",
    iconColor: "#1E88E5",
  },
  {
    id: "pi-zhipu",
    name: "Zhipu GLM",
    providerKey: "zhipu",
    websiteUrl: "https://open.bigmodel.cn",
    apiKeyUrl: "https://www.bigmodel.cn/claude-code",
    settingsConfig: {
      name: "Zhipu GLM",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      api: "openai-completions",
      apiKey: "",
      models: [
        { id: "glm-5.1", name: "GLM 5.1", reasoning: true, contextWindow: 131072, maxTokens: 8192 },
      ],
    },
    category: "cn_official",
    icon: "zhipu",
    iconColor: "#0F62FE",
  },
  {
    id: "pi-openrouter",
    name: "OpenRouter",
    providerKey: "openrouter",
    websiteUrl: "https://openrouter.ai",
    apiKeyUrl: "https://openrouter.ai/keys",
    settingsConfig: {
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      api: "openai-completions",
      apiKey: "",
      models: [],
    },
    category: "aggregator",
    icon: "openrouter",
    iconColor: "#6366F1",
  },
];

// ── Paseo presets (reuse Claude presets; paseo config has same shape) ──────────

export const paseoPresets: ClaudePreset[] = claudePresets.filter(
  (p) => p.category !== "official"
);

// Sort order: official > primePartner > partner > rest by name (mirrors cc-switch)
export function sortPresets<T extends { category?: string; isPartner?: boolean; primePartner?: boolean; name: string }>(
  presets: T[]
): T[] {
  return [...presets].sort((a, b) => {
    const score = (p: typeof a) => {
      if (p.category === "official") return 0;
      if (p.primePartner) return 1;
      if (p.isPartner) return 2;
      return 3;
    };
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name);
  });
}
