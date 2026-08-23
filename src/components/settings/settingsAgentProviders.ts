import {
  LLM_PROVIDER_PRESETS,
  isLocalLlmProvider,
  llmProviderConfigNames,
} from '../../../shared/llm-providers';
import type { VendorId } from './vendorIcons';
import { secret, text, type SettingsVendorPage } from './settingsFields';

const llmPage = (preset: (typeof LLM_PROVIDER_PRESETS)[number]): SettingsVendorPage => {
  const names = llmProviderConfigNames(preset.id);
  return {
    key: `llm/${preset.id}`,
    vendor: preset.id as VendorId,
    title: preset.label,
    note: preset.id === 'anthropic'
      ? '内置 Agent 需要 Anthropic API Key。Claude Code 订阅用户请通过「外部 Agent 接入 (MCP)」连接；OpenChatCut 不接收 Claude OAuth。'
      : '每个厂商独立保存地址、密钥与模型。先测试连接，成功后可从接口返回的模型中选择。',
    ...(preset.id === 'anthropic'
      ? { noteAction: { label: '外部 Agent 接入 (MCP)', action: 'open-mcp-guide' } }
      : {}),
    fields: [
      {
        name: names.baseUrl,
        label: 'API URL',
        kind: 'text',
        defaultLabel: preset.baseUrl,
        note: '填写完整 API 前缀；可使用官方地址、自建网关或兼容中转。',
      },
      secret(names.apiKey, isLocalLlmProvider(preset.id) ? 'API Key（可选）' : 'API Key'),
      ...(preset.id === 'openai' ? [{
        name: 'LLM_OPENAI_API_MODE',
        label: '接口格式',
        kind: 'select' as const,
        defaultLabel: 'Responses API（推荐）',
        note: '选择服务实际支持的协议；OpenAI 使用 Responses API，兼容服务使用 Chat Completions API。',
        options: [{ value: 'chat', label: 'Chat Completions API' }],
      }] : []),
      {
        name: names.model,
        label: '模型',
        kind: 'text',
        defaultLabel: preset.defaultModel,
        discoverableModel: true,
        note: '测试连接后可直接选择接口返回的模型，也可以手动填写模型 ID。',
        options: [{ value: preset.defaultModel, label: preset.defaultModel }],
      },
    ],
  };
};

const CODEX_PAGE: SettingsVendorPage = {
  key: 'llm/codex',
  vendor: 'openai',
  title: 'OpenAI · Codex',
  connection: 'codex',
  note: '使用 ChatGPT 订阅登录，由官方 Codex CLI 管理凭据、续期与退出。OpenChatCut 不会读取或显示 OAuth 凭据。',
  fields: [
    {
      name: 'CODEX_MODEL', label: 'Codex 模型', kind: 'text',
      defaultLabel: 'Codex 默认模型', discoverableModel: true,
      note: '登录后可读取当前账号可用的模型，也可以手动填写模型 ID。',
    },
    {
      name: 'CODEX_REASONING_EFFORT', label: '推理强度', kind: 'select',
      options: [{ value: '', label: '模型默认' }],
      note: '读取模型后显示当前模型支持的档位；留空使用该模型的默认值。',
    },
  ],
};

const XAI_OAUTH_PAGE: SettingsVendorPage = {
  key: 'llm/xai-oauth', vendor: 'xai-oauth', title: 'xAI · Grok (订阅登录)',
  connection: 'xai-oauth',
  note: '使用 SuperGrok 或 X Premium+ 订阅登录：官方 Grok CLI 管理登录与凭据（终端运行 grok login），OpenChatCut 导入会话并自动续期，不会读取或显示 OAuth 凭据。',
  fields: [{
    name: 'LLM_XAI_OAUTH_MODEL', label: '模型', kind: 'text', defaultLabel: 'grok-4.6',
    discoverableModel: true,
    note: '测试连接后可直接选择接口返回的模型，也可以手动填写模型 ID。',
    options: [{ value: 'grok-4.6', label: 'grok-4.6' }],
  }],
};

const AGENT_VENDOR_PAGES: readonly SettingsVendorPage[] = LLM_PROVIDER_PRESETS.flatMap((preset) => {
  if (preset.id === 'xai-oauth') return [XAI_OAUTH_PAGE];
  const page = llmPage(preset);
  return preset.id === 'openai' ? [page, CODEX_PAGE] : [page];
});

const VISION_PAGE: SettingsVendorPage = {
  key: 'llm/vision', vendor: 'vision', title: '视觉理解', fields: [],
};

export const PROXY_PAGE: SettingsVendorPage = {
  key: 'agent/proxy', vendor: 'proxy', title: '网络代理', kind: 'settings',
  note: '国内网络访问海外模型（Gemini / OpenAI / Anthropic / Mistral 等）失败时，'
    + '可在此填写本地代理地址（如 http://127.0.0.1:7890）。'
    + '留空则使用系统环境变量（HTTPS_PROXY / HTTP_PROXY）。'
    + '生效范围：Agent 模型、AI 生成、模型下载、R2 云同步。',
  fields: [text('PROXY_URL', '代理地址', '例如 http://127.0.0.1:7890')],
};

export const AGENT_VENDOR_PAGES_WITH_VISION: readonly SettingsVendorPage[] = [
  ...AGENT_VENDOR_PAGES,
  VISION_PAGE,
];
