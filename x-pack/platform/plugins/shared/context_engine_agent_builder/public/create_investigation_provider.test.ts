/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ChatEventType, ToolResultType } from '@kbn/agent-builder-common';
import type { AgentBuilderPluginStart } from '@kbn/agent-builder-browser';
import { coreMock } from '@kbn/core/public/mocks';
import type { GetAiIndexResponse } from '@kbn/context-engine-plugin/common/http_api/ai_indices';
import type {
  InvestigationRecord,
  StartInvestigationResponse,
} from '@kbn/context-engine-plugin/common/http_api/findings';
import { BehaviorSubject, Subject } from 'rxjs';
import {
  CONTEXT_ENGINE_AGENT_ENSURE_PATH,
  CONTEXT_ENGINE_AGENT_ID,
} from '../common/agent_builder_agents';
import {
  AI_INDEX_ATTACHMENT_TYPE,
  INVESTIGATION_ATTACHMENT_TYPE,
} from '../common/agent_builder_attachments';
import { KI_INVESTIGATION_SKILL_ID } from '../common/agent_builder_skills';
import {
  CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID,
  CONTEXT_ENGINE_SAVE_AUTOMATION_TOOL_ID,
} from '../common/agent_builder_tools';
import {
  buildScopeSnapshot,
  createInvestigationProvider,
  toInvestigationEvent,
} from './create_investigation_provider';

const aiIndex: GetAiIndexResponse = {
  id: 'my-ai-index',
  description: 'Support tickets',
  managed: false,
  dest: { type: 'data_stream', value: 'ai-index-ds-my-ai-index' },
  automations: [{ type: 'workflow', value: 'wf-existing' }],
  sources: [
    { type: 'esql', value: 'FROM tickets' },
    { type: 'connector', value: 'connector-1' },
  ],
  date_created: '2026-01-01T00:00:00.000Z',
  date_modified: '2026-01-01T00:00:00.000Z',
};

const investigation: InvestigationRecord = {
  doc_type: 'investigation',
  investigation_id: 'inv-1',
  ai_index_id: 'my-ai-index',
  stage: 'scoped',
  '@timestamp': '2026-09-01T00:00:00.000Z',
  started_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  scope: { mode: 'both', sources: [{ type: 'esql', value: 'FROM tickets' }] },
  finding_ids: [],
};

const startResponse: StartInvestigationResponse = {
  investigation,
  prior_decisions: [
    {
      finding_id: 'f-old',
      kind: 'system_error',
      subject: 'chat:ssl',
      decision: 'known_issue',
      reason: 'Certificate renewal',
      decided_at: '2026-08-20T00:00:00.000Z',
    },
  ],
};

const createProvider = ({
  hasAgentBuilder = true,
  hasPrivilege = true,
}: {
  hasAgentBuilder?: boolean;
  hasPrivilege?: boolean;
} = {}) => {
  const openChat = jest.fn();
  const activeConversation$ = new BehaviorSubject<{ id?: string } | null>({
    id: 'conversation-1',
  });
  const chatEvents$ = new Subject<{
    type: ChatEventType;
    data: Record<string, unknown>;
  }>();
  const getChatEvents$ = jest.fn().mockReturnValue(chatEvents$);

  const agentBuilder = hasAgentBuilder
    ? ({
        openChat,
        events: {
          ui: { activeConversation$ },
          getChatEvents$,
        },
      } as unknown as AgentBuilderPluginStart)
    : undefined;

  const core = coreMock.createStart();
  core.application.capabilities = {
    ...core.application.capabilities,
    agentBuilder: { show: hasPrivilege },
  };
  core.http.post.mockImplementation(async (path: unknown) => {
    if (path === CONTEXT_ENGINE_AGENT_ENSURE_PATH) {
      return { agent_id: CONTEXT_ENGINE_AGENT_ID, created: true };
    }
    return startResponse;
  });

  const provider = createInvestigationProvider({
    agentBuilder,
    application: core.application,
    http: core.http,
    notifications: core.notifications,
  });

  return { provider, openChat, chatEvents$, getChatEvents$, core };
};

describe('createInvestigationProvider', () => {
  describe('canRun', () => {
    it('is false when agent builder is unavailable', () => {
      const { provider } = createProvider({ hasAgentBuilder: false });
      expect(provider.canRun({ aiIndex })).toBe(false);
    });

    it('is false without the agent builder privilege', () => {
      const { provider } = createProvider({ hasPrivilege: false });
      expect(provider.canRun({ aiIndex })).toBe(false);
    });

    it('is false without an AI index', () => {
      const { provider } = createProvider();
      expect(provider.canRun({ aiIndex: undefined })).toBe(false);
    });

    it('is true when agent builder is available and permitted', () => {
      const { provider } = createProvider();
      expect(provider.canRun({ aiIndex })).toBe(true);
    });
  });

  describe('buildScopeSnapshot', () => {
    it('drops connector sources and folds previews into the snapshot', () => {
      const snapshot = buildScopeSnapshot({
        aiIndex,
        scope: {
          mode: 'both',
          trace: {
            agent_id: 'support-agent',
            time_range: { from: 'now-7d', to: 'now' },
            esql: 'FROM traces | WHERE x',
          },
        },
        sourcePreview: {
          sources: [],
          summary: {
            valid_sources: 1,
            invalid_sources: 0,
            skipped_sources: 1,
            resolved_indices: ['tickets'],
            doc_count: 1200,
            count_capped: false,
          },
        },
        tracePreview: {
          traces_index: 'traces-agent_builder.otel-default',
          requests: 40,
          conversations: 12,
          tool_calls: 100,
          failed_tool_calls: 3,
        },
      });

      expect(snapshot).toEqual({
        mode: 'both',
        sources: [{ type: 'esql', value: 'FROM tickets' }],
        source_summary: {
          valid_sources: 1,
          resolved_indices: ['tickets'],
          doc_count: 1200,
          count_capped: false,
        },
        trace: {
          agent_id: 'support-agent',
          from: 'now-7d',
          to: 'now',
          custom_esql: 'FROM traces | WHERE x',
          counts: { requests: 40, conversations: 12, tool_calls: 100, failed_tool_calls: 3 },
        },
      });
    });

    it('omits the trace block in sources mode and counts when the trace preview failed', () => {
      const sourcesOnly = buildScopeSnapshot({
        aiIndex,
        scope: {
          mode: 'sources',
          trace: { time_range: { from: 'now-7d', to: 'now' } },
        },
      });
      expect(sourcesOnly).toEqual({
        mode: 'sources',
        sources: [{ type: 'esql', value: 'FROM tickets' }],
      });

      const failedPreview = buildScopeSnapshot({
        aiIndex,
        scope: { mode: 'traces', trace: { time_range: { from: 'now-1d', to: 'now' } } },
        tracePreview: {
          traces_index: 'traces-agent_builder.otel-default',
          requests: 0,
          conversations: 0,
          tool_calls: 0,
          failed_tool_calls: 0,
          errors: [{ message: 'unknown index', type: 'verification_exception' }],
        },
      });
      expect(failedPreview.trace).toEqual({ from: 'now-1d', to: 'now' });
    });
  });

  describe('runInvestigation', () => {
    it('starts the run, ensures the agent and opens chat with both attachments auto-sent', async () => {
      const { provider, openChat, core } = createProvider();

      await provider.runInvestigation({
        aiIndex,
        scope: {
          mode: 'both',
          trace: { agent_id: 'support-agent', time_range: { from: 'now-7d', to: 'now' } },
        },
      });

      expect(core.http.post).toHaveBeenCalledWith(
        '/internal/context_engine/ai_index/my-ai-index/investigations',
        expect.objectContaining({
          body: JSON.stringify({
            scope: {
              mode: 'both',
              sources: [{ type: 'esql', value: 'FROM tickets' }],
              trace: { agent_id: 'support-agent', from: 'now-7d', to: 'now' },
            },
          }),
        })
      );
      expect(core.http.post).toHaveBeenCalledWith(
        CONTEXT_ENGINE_AGENT_ENSURE_PATH,
        expect.objectContaining({ version: '1' })
      );

      expect(openChat).toHaveBeenCalledWith(
        expect.objectContaining({
          newConversation: true,
          autoSendInitialMessage: true,
          agentId: CONTEXT_ENGINE_AGENT_ID,
          sessionTag: 'context-engine-investigation-my-ai-index',
          initialMessage: expect.stringContaining(
            `[/${KI_INVESTIGATION_SKILL_ID}](skill://${KI_INVESTIGATION_SKILL_ID})`
          ),
          attachments: [
            expect.objectContaining({ id: 'my-ai-index', type: AI_INDEX_ATTACHMENT_TYPE }),
            expect.objectContaining({
              id: 'inv-1',
              type: INVESTIGATION_ATTACHMENT_TYPE,
              data: expect.objectContaining({
                investigation_id: 'inv-1',
                ai_index_id: 'my-ai-index',
                stage: 'scoped',
                prior_decisions: [
                  expect.objectContaining({ finding_id: 'f-old', decision: 'known_issue' }),
                ],
              }),
            }),
          ],
        })
      );
    });

    it('falls back to the default agent when the ensure call fails', async () => {
      const { provider, openChat, core } = createProvider();
      core.http.post.mockImplementation(async (path: unknown) => {
        if (path === CONTEXT_ENGINE_AGENT_ENSURE_PATH) {
          throw new Error('forbidden');
        }
        return startResponse;
      });

      await provider.runInvestigation({ aiIndex, scope: { mode: 'sources' } });

      expect(openChat).toHaveBeenCalledWith(
        expect.not.objectContaining({ agentId: expect.any(String) })
      );
    });

    it('shows a toast and does not open chat when the run cannot be started', async () => {
      const { provider, openChat, core } = createProvider();
      core.http.post.mockRejectedValue(new Error('boom'));

      await provider.runInvestigation({ aiIndex, scope: { mode: 'sources' } });

      expect(core.notifications.toasts.addError).toHaveBeenCalledTimes(1);
      expect(openChat).not.toHaveBeenCalled();
    });
  });

  describe('toInvestigationEvent', () => {
    it('maps record_investigation results for the AI index to stage events', () => {
      expect(
        toInvestigationEvent(
          CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID,
          {
            tool_result_id: 'r-1',
            type: ToolResultType.other,
            data: {
              action: 'decisions',
              investigation_id: 'inv-1',
              ai_index_id: 'my-ai-index',
              stage: 'decisions_recorded',
            },
          },
          'my-ai-index'
        )
      ).toEqual({ type: 'stage', stage: 'decisions_recorded', investigationId: 'inv-1' });
    });

    it('ignores results for other AI indexes, unknown stages and error results', () => {
      expect(
        toInvestigationEvent(
          CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID,
          {
            tool_result_id: 'r-1',
            type: ToolResultType.other,
            data: { ai_index_id: 'other', stage: 'planned' },
          },
          'my-ai-index'
        )
      ).toBeUndefined();
      expect(
        toInvestigationEvent(
          CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID,
          {
            tool_result_id: 'r-1',
            type: ToolResultType.other,
            data: { ai_index_id: 'my-ai-index', stage: 'bogus' },
          },
          'my-ai-index'
        )
      ).toBeUndefined();
      expect(
        toInvestigationEvent(
          CONTEXT_ENGINE_SAVE_AUTOMATION_TOOL_ID,
          { tool_result_id: 'r-1', type: ToolResultType.error, data: { message: 'x' } },
          'my-ai-index'
        )
      ).toBeUndefined();
    });

    it('maps save_automation results to automation_saved', () => {
      expect(
        toInvestigationEvent(
          CONTEXT_ENGINE_SAVE_AUTOMATION_TOOL_ID,
          {
            tool_result_id: 'r-1',
            type: ToolResultType.other,
            data: { aiIndexId: 'my-ai-index', workflowId: 'wf-new', status: 'attached' },
          },
          'my-ai-index'
        )
      ).toEqual({ type: 'automation_saved', workflowId: 'wf-new' });
    });
  });

  describe('subscribeToInvestigationEvents', () => {
    it('forwards events from the active conversation and stops after unsubscribe', () => {
      const onEvent = jest.fn();
      const { provider, chatEvents$, getChatEvents$ } = createProvider();

      const unsubscribe = provider.subscribeToInvestigationEvents('my-ai-index', onEvent);
      expect(getChatEvents$).toHaveBeenCalledWith('conversation-1');

      chatEvents$.next({
        type: ChatEventType.toolResult,
        data: {
          tool_call_id: 'c-1',
          tool_id: CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID,
          results: [
            {
              tool_result_id: 'r-1',
              type: ToolResultType.other,
              data: {
                action: 'findings',
                investigation_id: 'inv-1',
                ai_index_id: 'my-ai-index',
                stage: 'findings_recorded',
              },
            },
          ],
        },
      });
      chatEvents$.next({
        type: ChatEventType.toolResult,
        data: {
          tool_call_id: 'c-2',
          tool_id: CONTEXT_ENGINE_SAVE_AUTOMATION_TOOL_ID,
          results: [
            {
              tool_result_id: 'r-2',
              type: ToolResultType.other,
              data: { aiIndexId: 'my-ai-index', workflowId: 'wf-new', status: 'attached' },
            },
          ],
        },
      });

      expect(onEvent).toHaveBeenNthCalledWith(1, {
        type: 'stage',
        stage: 'findings_recorded',
        investigationId: 'inv-1',
      });
      expect(onEvent).toHaveBeenNthCalledWith(2, {
        type: 'automation_saved',
        workflowId: 'wf-new',
      });

      unsubscribe();
      chatEvents$.next({
        type: ChatEventType.toolResult,
        data: {
          tool_call_id: 'c-3',
          tool_id: CONTEXT_ENGINE_SAVE_AUTOMATION_TOOL_ID,
          results: [
            {
              tool_result_id: 'r-3',
              type: ToolResultType.other,
              data: { aiIndexId: 'my-ai-index', workflowId: 'wf-later', status: 'attached' },
            },
          ],
        },
      });
      expect(onEvent).toHaveBeenCalledTimes(2);
    });

    it('is a no-op without agent builder events', () => {
      const { provider } = createProvider({ hasAgentBuilder: false });
      expect(() =>
        provider.subscribeToInvestigationEvents('my-ai-index', jest.fn())()
      ).not.toThrow();
    });
  });
});
