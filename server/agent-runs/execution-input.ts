import {
  defaultModelForProvider,
  normalizeLlmProvider,
  normalizeOpenAiApiMode,
} from '../../shared/llm-providers';
import { resolveLlmProviderConfig } from '../llm-config';
import { getKey, type KeyName } from '../keystore';
import type { ServerRunInput } from './executor';
import type { ValidatedCreateInput } from './request';
import { digestValue } from './store-values';
import { resolveServerRunToolCatalog } from './tool-policy';

export function resolveRunExecution(
  body: Record<string, unknown>,
  input: ValidatedCreateInput,
  origin: string,
  askOnly: boolean,
): ServerRunInput {
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const requestedModel = input.model;
  const backend = body.backend === 'codex' ? 'codex' : 'api';
  const readKey = (name: string): string => getKey(name as KeyName);
  const codexBackend = backend === 'codex';
  const config = codexBackend
    ? { provider: 'openai', model: '' }
    : resolveLlmProviderConfig(provider || getKey('LLM_PROVIDER'), readKey);
  const effectiveProvider = normalizeLlmProvider(config.provider);
  const effectiveModel = requestedModel || config.model || defaultModelForProvider(effectiveProvider);
  const openAiApiMode = normalizeOpenAiApiMode(body.openAiApiMode);
  const tools = resolveServerRunToolCatalog(input.tools, askOnly);
  return {
    messages: input.messages,
    backend,
    provider: effectiveProvider,
    model: effectiveModel,
    openAiApiMode,
    cacheMode: input.cacheMode,
    maxOutputTokens: input.maxOutputTokens,
    autonomousAcceptance: input.autonomousAcceptance,
    maxAcceptanceIterations: input.maxAcceptanceIterations,
    origin,
    tools,
    instructions: input.instructions,
  };
}

export function runRequestDigests(
  input: ValidatedCreateInput,
  execution: ServerRunInput,
  askOnly: boolean,
  sessionGeneration: string,
): { readonly userInputDigest: string; readonly requestShapeHash: string } {
  const userInputDigest = digestValue(input.messages);
  return {
    userInputDigest,
    requestShapeHash: digestValue({
      projectId: input.projectId,
      sessionGeneration,
      userInputDigest,
      askOnly,
      references: input.references,
      externalSessionId: input.externalSessionId,
      context: input.context,
      provider: execution.provider,
      model: execution.model,
      openAiApiMode: execution.openAiApiMode,
      cacheMode: execution.cacheMode,
      maxOutputTokens: execution.maxOutputTokens,
      autonomousAcceptance: execution.autonomousAcceptance,
      maxAcceptanceIterations: execution.maxAcceptanceIterations,
      tools: execution.tools,
      instructions: execution.instructions,
    }),
  };
}
