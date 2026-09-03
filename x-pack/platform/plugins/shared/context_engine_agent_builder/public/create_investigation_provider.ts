/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { isToolResultEvent, ToolResultType, type ToolResult } from '@kbn/agent-builder-common';
import type { AgentBuilderPluginStart } from '@kbn/agent-builder-browser';
import type { ApplicationStart, HttpStart, NotificationsStart } from '@kbn/core/public';
import { i18n } from '@kbn/i18n';
import { EMPTY, switchMap } from 'rxjs';
import type {
  InvestigationEvent,
  InvestigationProvider,
  RunInvestigationParams,
} from '@kbn/context-engine-plugin/public/types';
import {
  AI_INDEX_INTERNAL_API_VERSION,
  aiIndexInvestigationsPath,
} from '@kbn/context-engine-plugin/common/constants';
import type {
  InvestigationScopeSnapshot,
  StartInvestigationRequest,
  StartInvestigationResponse,
} from '@kbn/context-engine-plugin/common/http_api/findings';
import {
  INVESTIGATION_STAGES,
  buildInvestigationSessionTag,
} from '@kbn/context-engine-plugin/common/investigation';
import type { InvestigationStage } from '@kbn/context-engine-plugin/common/investigation';
import { buildInvestigationAttachmentData } from '@kbn/context-engine-plugin/common/investigation_schemas';
import {
  AI_INDEX_ATTACHMENT_TYPE,
  INVESTIGATION_ATTACHMENT_TYPE,
} from '../common/agent_builder_attachments';
import { KI_INVESTIGATION_SKILL_ID } from '../common/agent_builder_skills';
import {
  CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID,
  CONTEXT_ENGINE_SAVE_AUTOMATION_TOOL_ID,
} from '../common/agent_builder_tools';
import { ensureContextEngineAgentId } from './ensure_agent';

const AGENT_BUILDER_CAPABILITY = 'agentBuilder';

const RUN_INVESTIGATION_INITIAL_MESSAGE = i18n.translate(
  'xpack.contextEngine.aiIndexDetail.investigation.runInitialMessage',
  {
    defaultMessage:
      'Load [/{skillId}](skill://{skillId}) and investigate the attached scope. Return findings for review before creating anything.',
    values: { skillId: KI_INVESTIGATION_SKILL_ID },
  }
);

const isInvestigationStage = (value: unknown): value is InvestigationStage =>
  typeof value === 'string' && (INVESTIGATION_STAGES as readonly string[]).includes(value);

const readString = (data: Record<string, unknown>, key: string): string | undefined =>
  typeof data[key] === 'string' ? (data[key] as string) : undefined;

/**
 * Maps one successful tool result to an Investigation panel event, or `undefined` when the result
 * belongs to another AI index or another tool.
 */
export const toInvestigationEvent = (
  toolId: string,
  result: ToolResult,
  aiIndexId: string
): InvestigationEvent | undefined => {
  if (result.type !== ToolResultType.other) {
    return undefined;
  }
  const data = result.data as Record<string, unknown>;

  if (toolId === CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID) {
    if (readString(data, 'ai_index_id') !== aiIndexId) {
      return undefined;
    }
    const stage = data.stage;
    if (!isInvestigationStage(stage)) {
      return undefined;
    }
    return { type: 'stage', stage, investigationId: readString(data, 'investigation_id') };
  }

  if (toolId === CONTEXT_ENGINE_SAVE_AUTOMATION_TOOL_ID) {
    if (readString(data, 'aiIndexId') !== aiIndexId) {
      return undefined;
    }
    const workflowId = readString(data, 'workflowId');
    return workflowId ? { type: 'automation_saved', workflowId } : undefined;
  }

  return undefined;
};

/**
 * Snapshot the page's scope plus its deterministic previews into what the investigation record
 * stores. Connector sources are not investigated in this version and are left out.
 */
export const buildScopeSnapshot = ({
  aiIndex,
  scope,
  sourcePreview,
  tracePreview,
}: RunInvestigationParams): InvestigationScopeSnapshot => {
  const sources = aiIndex.sources.filter((source) => source.type === 'esql');
  const includeTrace = scope.mode !== 'sources' && scope.trace !== undefined;
  return {
    mode: scope.mode,
    sources,
    ...(sourcePreview
      ? {
          source_summary: {
            valid_sources: sourcePreview.summary.valid_sources,
            resolved_indices: sourcePreview.summary.resolved_indices,
            doc_count: sourcePreview.summary.doc_count,
            count_capped: sourcePreview.summary.count_capped,
          },
        }
      : {}),
    ...(includeTrace && scope.trace
      ? {
          trace: {
            ...(scope.trace.agent_id ? { agent_id: scope.trace.agent_id } : {}),
            from: scope.trace.time_range.from,
            to: scope.trace.time_range.to,
            ...(scope.trace.esql ? { custom_esql: scope.trace.esql } : {}),
            ...(tracePreview && !tracePreview.errors?.length
              ? {
                  counts: {
                    requests: tracePreview.requests,
                    conversations: tracePreview.conversations,
                    tool_calls: tracePreview.tool_calls,
                    failed_tool_calls: tracePreview.failed_tool_calls,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
};

export const createInvestigationProvider = ({
  agentBuilder,
  application,
  http,
  notifications,
}: {
  agentBuilder: AgentBuilderPluginStart | undefined;
  application: ApplicationStart;
  http: HttpStart;
  notifications: NotificationsStart;
}): InvestigationProvider => {
  return {
    canRun: ({ aiIndex }) =>
      aiIndex !== undefined &&
      application.capabilities[AGENT_BUILDER_CAPABILITY]?.show === true &&
      agentBuilder?.openChat !== undefined,

    runInvestigation: async (params) => {
      if (!agentBuilder?.openChat) {
        return;
      }
      const { aiIndex } = params;
      const scope = buildScopeSnapshot(params);

      let started: StartInvestigationResponse;
      try {
        started = await http.post<StartInvestigationResponse>(
          aiIndexInvestigationsPath.replace('{aiIndexId}', encodeURIComponent(aiIndex.id)),
          {
            version: AI_INDEX_INTERNAL_API_VERSION,
            body: JSON.stringify({ scope } satisfies StartInvestigationRequest),
          }
        );
      } catch (error) {
        notifications.toasts.addError(error as Error, {
          title: i18n.translate(
            'xpack.contextEngine.aiIndexDetail.investigation.startFailedTitle',
            { defaultMessage: 'Could not start the investigation' }
          ),
        });
        return;
      }

      const agentId = await ensureContextEngineAgentId(http);
      const investigationData = buildInvestigationAttachmentData({
        investigation: started.investigation,
        findings: [],
        priorDecisions: started.prior_decisions,
      });

      agentBuilder.openChat({
        newConversation: true,
        autoSendInitialMessage: true,
        initialMessage: RUN_INVESTIGATION_INITIAL_MESSAGE,
        sessionTag: buildInvestigationSessionTag(aiIndex.id),
        ...(agentId ? { agentId } : {}),
        attachments: [
          {
            id: aiIndex.id,
            type: AI_INDEX_ATTACHMENT_TYPE,
            description:
              aiIndex.description ??
              i18n.translate('xpack.contextEngine.aiIndexDetail.investigation.aiIndexAttachment', {
                defaultMessage: 'AI index {name}',
                values: { name: aiIndex.id },
              }),
            data: {
              id: aiIndex.id,
              description: aiIndex.description,
              dest: aiIndex.dest,
              sources: aiIndex.sources,
              automations: aiIndex.automations,
            },
          },
          {
            id: started.investigation.investigation_id,
            type: INVESTIGATION_ATTACHMENT_TYPE,
            description: i18n.translate(
              'xpack.contextEngine.aiIndexDetail.investigation.investigationAttachment',
              {
                defaultMessage: 'Investigation scope for {name}',
                values: { name: aiIndex.id },
              }
            ),
            data: investigationData,
          },
        ],
      });
    },

    subscribeToInvestigationEvents: (aiIndexId, onEvent) => {
      if (!agentBuilder?.events) {
        return () => {};
      }

      const subscription = agentBuilder.events.ui.activeConversation$
        .pipe(
          switchMap((conversation) =>
            conversation?.id ? agentBuilder.events.getChatEvents$(conversation.id) : EMPTY
          )
        )
        .subscribe((event) => {
          if (!isToolResultEvent(event)) {
            return;
          }
          const { tool_id: toolId, results } = event.data;
          for (const result of results) {
            const investigationEvent = toInvestigationEvent(toolId, result, aiIndexId);
            if (investigationEvent) {
              onEvent(investigationEvent);
            }
          }
        });

      return () => subscription.unsubscribe();
    },
  };
};
