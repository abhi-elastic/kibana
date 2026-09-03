/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AppMountParameters, CoreStart } from '@kbn/core/public';
import type { ConsolePluginStart } from '@kbn/console-plugin/public';
import type { DataPublicPluginStart } from '@kbn/data-plugin/public';
import type { SharePluginStart } from '@kbn/share-plugin/public';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/public';
import type { TriggersAndActionsUIPublicPluginStart } from '@kbn/triggers-actions-ui-plugin/public';
import type { WorkflowsExtensionsPublicPluginSetup } from '@kbn/workflows-extensions/public';
import type { AttachmentInput } from '@kbn/agent-builder-common/attachments';
import type {
  AiIndexHttpItem,
  AiIndexInvestigationScope,
  GetAiIndexResponse,
} from '../common/http_api/ai_indices';
import type {
  PreviewSourcesResponse,
  TraceScopePreviewResponse,
} from '../common/http_api/investigation_scope';
import type { InvestigationStage } from '../common/investigation';
import type { ContextEngineAppChromeAdapter } from './app_chrome_adapter';

/**
 * Context passed to the "Analyze & improve" chat opener: the AI index the user is looking at and,
 * optionally, the tag/group they are scoped to. The opener fetches the signals server-side; the
 * materialized signals are intentionally NOT passed so the opener always works from the
 * authoritative, complete set.
 */
export interface AnalyzeAndImproveContext {
  aiIndex: AiIndexHttpItem;
  /** The tag/group the action is scoped to, when drilled into a single group. */
  tag?: string;
}

/** Opens Agent Builder to analyze the given signals. */
export type ChatOpener = (context: AnalyzeAndImproveContext) => void | Promise<void>;

/** Options passed to Agent Builder `openChat` for an Analyze & improve hand-off. */
export interface AnalyzeChatOptions {
  /** Feedback agent to open. */
  agentId?: string;
  /** When true, start a new conversation. */
  newConversation: boolean;
  /** Session tag for this AI index's conversation. */
  sessionTag: string;
  /** Attachments passed to Agent Builder. */
  attachments: AttachmentInput[];
}

export type { ContextEngineAppChromeAdapter } from './app_chrome_adapter';

export interface SuggestAutomationParams {
  aiIndex: GetAiIndexResponse;
  onSaved: () => void;
}

/** Powers the Suggest automation button. Registered via {@link AgentBuilderIntegration}. */
export interface SuggestAutomationProvider {
  canSuggest: (params: { aiIndex: GetAiIndexResponse | undefined; isManaged: boolean }) => boolean;
  suggestAutomation: (params: SuggestAutomationParams) => void;
  /** Subscribe to successful save_automation tool results for an AI index. Returns unsubscribe. */
  subscribeToAutomationSaved: (aiIndexId: string, onSaved: () => void) => () => void;
}

export interface RunInvestigationParams {
  aiIndex: GetAiIndexResponse;
  scope: AiIndexInvestigationScope;
  /** Deterministic preview of the ES|QL sources, when the user ran it. */
  sourcePreview?: PreviewSourcesResponse;
  /** Bounded trace counts for the selected agent or custom scope, when available. */
  tracePreview?: TraceScopePreviewResponse;
}

/** Progress events surfaced from the Agent Builder conversation to the Overview page. */
export type InvestigationEvent =
  | { type: 'stage'; stage: InvestigationStage; investigationId?: string }
  | { type: 'automation_saved'; workflowId: string };

/** Powers the "Run investigation in Agent Builder" button. */
export interface InvestigationProvider {
  canRun: (params: { aiIndex: GetAiIndexResponse | undefined }) => boolean;
  runInvestigation: (params: RunInvestigationParams) => void | Promise<void>;
  /** Subscribe to investigation progress for an AI index. Returns unsubscribe. */
  subscribeToInvestigationEvents: (
    aiIndexId: string,
    onEvent: (event: InvestigationEvent) => void
  ) => () => void;
}

/** Agent Builder hooks registered by context_engine_agent_builder. */
export interface AgentBuilderIntegration {
  suggestAutomation: SuggestAutomationProvider;
  investigation?: InvestigationProvider;
  /**
   * Create-if-absent install of the shared Context Engine agent in the current space, resolving
   * to its id, or `undefined` when it could not be ensured. Used by every Context Engine hand-off.
   */
  ensureAgentId?: () => Promise<string | undefined>;
}

export interface ContextEnginePluginSetup {
  registerAppChromeAdapter: (adapter: ContextEngineAppChromeAdapter) => void;
}

export interface ContextEnginePluginStart {
  /** Registers suggest-automation hooks used by the Context Engine UI. */
  registerAgentBuilderIntegration: (integration: AgentBuilderIntegration) => void;
}

export interface ContextEngineSetupDependencies {
  workflowsExtensions: WorkflowsExtensionsPublicPluginSetup;
}

export interface ContextEngineStartDependencies {
  data: DataPublicPluginStart;
  share: SharePluginStart;
  triggersActionsUi: TriggersAndActionsUIPublicPluginStart;
  console?: ConsolePluginStart;
  spaces?: SpacesPluginStart;
}

export interface ContextEngineServicesContextDeps {
  history: AppMountParameters['history'];
  appChrome?: ContextEngineAppChromeAdapter;
}

export type ContextEngineAppServices = CoreStart & ContextEngineServicesContextDeps;
