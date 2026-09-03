/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EuiProvider } from '@elastic/eui';
import { coreMock } from '@kbn/core/public/mocks';
import { dataPluginMock } from '@kbn/data-plugin/public/mocks';
import { I18nProvider } from '@kbn/i18n-react';
import { KibanaContextProvider } from '@kbn/kibana-react-plugin/public';
import { QueryClient, QueryClientProvider } from '@kbn/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import {
  aiIndexInvestigationScopePath,
  aiIndexLatestInvestigationPath,
  traceAgentsPath,
  traceScopePreviewPath,
} from '../../../../../common/constants';
import type { GetAiIndexResponse } from '../../../../../common/http_api/ai_indices';
import type { InvestigationStage } from '../../../../../common/investigation';
import type { AgentBuilderIntegration, InvestigationEvent } from '../../../../types';
import { InvestigationScopePanel } from './investigation_scope_panel';

jest.mock('@kbn/esql/public', () => ({
  ESQLLangEditor: ({
    query,
    onTextLangQueryChange,
  }: {
    query: { esql: string };
    onTextLangQueryChange: (query: { esql: string }) => void;
  }) => (
    <textarea
      data-test-subj="mockEsqlEditor"
      value={query.esql}
      onChange={(event) => onTextLangQueryChange({ esql: event.target.value })}
    />
  ),
}));

const AI_INDEX: GetAiIndexResponse = {
  id: 'support-context',
  managed: false,
  date_created: '2026-01-01T00:00:00.000Z',
  date_modified: '2026-01-01T00:00:00.000Z',
  dest: { type: 'index', value: 'support-context' },
  automations: [],
  sources: [{ type: 'esql', value: 'FROM support-tickets' }],
};

const createIntegration = () => {
  const listeners = new Map<string, (event: InvestigationEvent) => void>();
  const integration: AgentBuilderIntegration = {
    suggestAutomation: {
      canSuggest: () => false,
      suggestAutomation: jest.fn(),
      subscribeToAutomationSaved: () => () => {},
    },
    investigation: {
      canRun: () => true,
      runInvestigation: jest.fn(),
      subscribeToInvestigationEvents: (aiIndexId, onEvent) => {
        listeners.set(aiIndexId, onEvent);
        return () => listeners.delete(aiIndexId);
      },
    },
  };
  return {
    integration,
    emit: (aiIndexId: string, event: InvestigationEvent) =>
      act(() => {
        listeners.get(aiIndexId)?.(event);
      }),
  };
};

const createServices = (
  integration?: AgentBuilderIntegration,
  { latestStage }: { latestStage?: InvestigationStage } = {}
) => {
  const services = coreMock.createStart();
  (services.http.get as jest.Mock).mockImplementation((path: string) => {
    if (path === aiIndexLatestInvestigationPath.replace('{aiIndexId}', AI_INDEX.id)) {
      return Promise.resolve({
        investigation: latestStage
          ? { investigation_id: 'inv-1', ai_index_id: AI_INDEX.id, stage: latestStage }
          : undefined,
        findings: [],
      });
    }
    if (path === traceAgentsPath) {
      return Promise.resolve({
        agents: [{ agent_id: 'support-agent' }],
        method: 'terms_enum',
        traces_index: 'traces-agent_builder.otel-default',
      });
    }
    if (path === traceScopePreviewPath) {
      return Promise.resolve({
        traces_index: 'traces-agent_builder.otel-default',
        requests: 12,
        conversations: 5,
        tool_calls: 40,
        failed_tool_calls: 3,
      });
    }
    return Promise.resolve(undefined);
  });
  (services.http.put as jest.Mock).mockImplementation((_path: string, options) =>
    Promise.resolve({ investigation_scope: JSON.parse(options.body) })
  );
  (services.settings.client.get as jest.Mock).mockReturnValue(true);
  return {
    ...services,
    data: dataPluginMock.createStartContract(),
    getAgentBuilderIntegration: () => integration,
  };
};

const renderPanel = (
  props: Partial<React.ComponentProps<typeof InvestigationScopePanel>> = {},
  services = createServices()
) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onChanged = jest.fn();
  const onEditSources = jest.fn();
  return {
    services,
    onChanged,
    onEditSources,
    ...render(
      <I18nProvider>
        <EuiProvider>
          <KibanaContextProvider services={services}>
            <QueryClientProvider client={queryClient}>
              <InvestigationScopePanel
                isLoading={false}
                aiIndex={AI_INDEX}
                isManaged={false}
                onEditSources={onEditSources}
                onChanged={onChanged}
                {...props}
              />
            </QueryClientProvider>
          </KibanaContextProvider>
        </EuiProvider>
      </I18nProvider>
    ),
  };
};

describe('InvestigationScopePanel', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows both sections by default and hides them per mode', async () => {
    renderPanel();

    expect(screen.getByTestId('contextSourceScopeSection')).toBeInTheDocument();
    expect(screen.getByTestId('contextTraceScopeSection')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('contextInvestigationMode-sources'));
    expect(screen.getByTestId('contextSourceScopeSection')).toBeInTheDocument();
    expect(screen.queryByTestId('contextTraceScopeSection')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('contextInvestigationMode-traces'));
    expect(screen.queryByTestId('contextSourceScopeSection')).not.toBeInTheDocument();
    expect(screen.getByTestId('contextTraceScopeSection')).toBeInTheDocument();
  });

  it('persists the mode through the investigation_scope route', async () => {
    const { services } = renderPanel();

    fireEvent.click(screen.getByTestId('contextInvestigationMode-sources'));

    await waitFor(() =>
      expect(services.http.put).toHaveBeenCalledWith(
        aiIndexInvestigationScopePath.replace('{aiIndexId}', AI_INDEX.id),
        expect.objectContaining({ body: JSON.stringify({ mode: 'sources' }) })
      )
    );
  });

  it('does not persist for managed AI indices', async () => {
    const { services } = renderPanel({ isManaged: true });

    expect(screen.getByTestId('contextRunInvestigationButton')).toBeDisabled();
    expect(services.http.put).not.toHaveBeenCalled();
  });

  it('blocks running until the trace scope has an agent, then hands off to Agent Builder', async () => {
    const { integration } = createIntegration();
    const services = createServices(integration);
    renderPanel({}, services);

    expect(screen.getByTestId('contextRunInvestigationButton')).toBeDisabled();
    expect(screen.getByTestId('contextRunInvestigationBlocked')).toHaveTextContent(
      'Pick an agent or write a trace query'
    );

    fireEvent.click(screen.getByTestId('contextInvestigationMode-sources'));
    await waitFor(() => expect(screen.getByTestId('contextRunInvestigationButton')).toBeEnabled());

    fireEvent.click(screen.getByTestId('contextRunInvestigationButton'));

    await waitFor(() =>
      expect(integration.investigation?.runInvestigation).toHaveBeenCalledWith(
        expect.objectContaining({
          aiIndex: AI_INDEX,
          scope: { mode: 'sources' },
        })
      )
    );
  });

  it('explains when Agent Builder is not available', () => {
    renderPanel({}, createServices(undefined));

    expect(screen.getByTestId('contextRunInvestigationBlocked')).toHaveTextContent(
      'Agent Builder is not available'
    );
  });

  it('advances the stage badges from chat events and refetches', async () => {
    const { integration, emit } = createIntegration();
    const { onChanged } = renderPanel({}, createServices(integration));

    emit(AI_INDEX.id, { type: 'stage', stage: 'findings_recorded', investigationId: 'inv-1' });

    await waitFor(() =>
      expect(screen.getByTestId('contextInvestigationStage-findings_recorded')).toHaveAttribute(
        'aria-current',
        'step'
      )
    );
    expect(onChanged).toHaveBeenCalledTimes(1);

    emit(AI_INDEX.id, { type: 'automation_saved', workflowId: 'wf-1' });

    await waitFor(() =>
      expect(screen.getByTestId('contextInvestigationStage-generated')).toHaveTextContent('(1)')
    );
  });

  it('shows the persisted stage from the findings store after a reload', async () => {
    renderPanel({}, createServices(undefined, { latestStage: 'strategy_approved' }));

    await waitFor(() =>
      expect(screen.getByTestId('contextInvestigationStage-strategy_approved')).toHaveAttribute(
        'aria-current',
        'step'
      )
    );
  });

  it('loads trace preview counts once a stored agent scope exists', async () => {
    renderPanel({
      aiIndex: {
        ...AI_INDEX,
        investigation_scope: {
          mode: 'traces',
          trace: { agent_id: 'support-agent', time_range: { from: 'now-7d', to: 'now' } },
        },
      },
    });

    const stats = await screen.findByTestId('contextTraceScopePreviewStats');
    await waitFor(() => expect(stats).toHaveTextContent('12'));
    expect(stats).toHaveTextContent('40');
    expect(stats).toHaveTextContent('3');
  });
});
