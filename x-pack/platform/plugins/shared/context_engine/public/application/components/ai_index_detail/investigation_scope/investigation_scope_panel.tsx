/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  EuiFlexGroup,
  EuiFlexItem,
  EuiHorizontalRule,
  EuiPanel,
  EuiSkeletonText,
  EuiSpacer,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import { FormattedMessage } from '@kbn/i18n-react';
import React, { useEffect, useMemo, useState } from 'react';
import type {
  AiIndexInvestigationScope,
  AiIndexInvestigationTraceScope,
  AiIndexSource,
  GetAiIndexResponse,
} from '../../../../../common/http_api/ai_indices';
import type { TraceScopePreviewResponse } from '../../../../../common/http_api/investigation_scope';
import { useLatestInvestigation } from '../../../hooks/use_latest_investigation';
import { useRunInvestigation } from '../../../hooks/use_run_investigation';
import { useSaveInvestigationScope } from '../../../hooks/use_save_investigation_scope';
import { useSourcePreview } from '../../../hooks/use_source_preview';
import { useTraceScopePreview } from '../../../hooks/use_trace_scope_preview';
import { InvestigationPanel } from './investigation_panel';
import { ModeSelector } from './mode_selector';
import { SourceScopeSection } from './source_scope_section';
import { DEFAULT_TRACE_TIME_RANGE, TraceScopeSection } from './trace_scope_section';

export const DEFAULT_INVESTIGATION_SCOPE: AiIndexInvestigationScope = { mode: 'both' };

const includesSources = (scope: AiIndexInvestigationScope) => scope.mode !== 'traces';
const includesTraces = (scope: AiIndexInvestigationScope) => scope.mode !== 'sources';

const hasTraceSelection = (trace: AiIndexInvestigationTraceScope | undefined): boolean =>
  Boolean(trace?.agent_id) || Boolean(trace?.esql && trace.esql.trim().length > 0);

/**
 * Why "Run investigation" is unavailable for the current scope, or `undefined` when it can run.
 * Deterministic and local: it never calls the agent.
 */
export const getInvestigationBlocker = ({
  scope,
  sources,
  tracePreview,
  isProviderAvailable,
}: {
  scope: AiIndexInvestigationScope;
  sources: AiIndexSource[];
  tracePreview: TraceScopePreviewResponse | undefined;
  isProviderAvailable: boolean;
}): string | undefined => {
  if (!isProviderAvailable) {
    return i18n.translate('xpack.contextEngine.investigationScope.blocked.noAgentBuilder', {
      defaultMessage: 'Agent Builder is not available in this deployment.',
    });
  }
  const esqlSources = sources.filter((source) => source.type === 'esql');
  if (includesSources(scope) && esqlSources.length === 0) {
    return i18n.translate('xpack.contextEngine.investigationScope.blocked.noSources', {
      defaultMessage: 'Add at least one index or ES|QL source, or switch to Traces only.',
    });
  }
  if (includesTraces(scope) && !hasTraceSelection(scope.trace)) {
    return i18n.translate('xpack.contextEngine.investigationScope.blocked.noTraceScope', {
      defaultMessage: 'Pick an agent or write a trace query, or switch to Sources only.',
    });
  }
  if (includesTraces(scope) && tracePreview?.errors && tracePreview.errors.length > 0) {
    return i18n.translate('xpack.contextEngine.investigationScope.blocked.invalidTraceScope', {
      defaultMessage: 'Fix the trace query before running the investigation.',
    });
  }
  if (includesTraces(scope) && tracePreview && tracePreview.requests === 0) {
    return i18n.translate('xpack.contextEngine.investigationScope.blocked.noRequests', {
      defaultMessage:
        'No requests in the selected range. Widen the time range or pick another agent.',
    });
  }
  return undefined;
};

interface InvestigationScopePanelProps {
  isLoading: boolean;
  aiIndex: GetAiIndexResponse | undefined;
  isManaged: boolean;
  onEditSources: () => void;
  onChanged: () => void;
}

export const InvestigationScopePanel = ({
  isLoading,
  aiIndex,
  isManaged,
  onEditSources,
  onChanged,
}: InvestigationScopePanelProps) => {
  const sources = useMemo<AiIndexSource[]>(() => aiIndex?.sources ?? [], [aiIndex?.sources]);
  const [scope, setScope] = useState<AiIndexInvestigationScope>(
    aiIndex?.investigation_scope ?? DEFAULT_INVESTIGATION_SCOPE
  );

  // Adopt the server copy when a different AI index loads or another writer changed the scope.
  useEffect(() => {
    if (aiIndex?.investigation_scope) {
      setScope(aiIndex.investigation_scope);
    }
  }, [aiIndex?.id, aiIndex?.investigation_scope]);

  const { saveScope } = useSaveInvestigationScope(aiIndex?.id);
  const {
    runPreview,
    preview: sourcePreview,
    isPreviewing,
    previewError,
    resetPreview,
  } = useSourcePreview();

  const trace = scope.trace;
  const tracePreviewQuery = useTraceScopePreview({
    from: trace?.time_range.from ?? DEFAULT_TRACE_TIME_RANGE.from,
    to: trace?.time_range.to ?? DEFAULT_TRACE_TIME_RANGE.to,
    agentId: includesTraces(scope) ? trace?.agent_id : undefined,
    esql: includesTraces(scope) ? trace?.esql : undefined,
  });

  // After a reload the badges come from the store rather than from chat events.
  const { investigation: latestInvestigation, invalidate: refetchLatestInvestigation } =
    useLatestInvestigation(aiIndex?.id);

  const handleProgress = () => {
    refetchLatestInvestigation();
    onChanged();
  };

  const { isProviderAvailable, isRunning, run, stage, savedWorkflowIds } = useRunInvestigation({
    aiIndex,
    scope,
    sourcePreview,
    tracePreview: tracePreviewQuery.preview,
    persistedStage: latestInvestigation?.stage,
    onProgress: handleProgress,
  });

  const persist = (next: AiIndexInvestigationScope) => {
    setScope(next);
    if (aiIndex && !isManaged) {
      saveScope(next).catch(() => {
        // Surfaced through the mutation's error toast; keep the local draft.
      });
    }
  };

  const handleModeChange = (mode: AiIndexInvestigationScope['mode']) => {
    persist({
      mode,
      ...(mode !== 'sources' && scope.trace ? { trace: scope.trace } : {}),
    });
  };

  const handleTraceChange = (nextTrace: AiIndexInvestigationTraceScope) => {
    persist({ mode: scope.mode, trace: nextTrace });
  };

  useEffect(() => {
    resetPreview();
  }, [aiIndex?.sources, resetPreview]);

  const blocker = useMemo(
    () =>
      getInvestigationBlocker({
        scope,
        sources,
        tracePreview: tracePreviewQuery.preview,
        isProviderAvailable,
      }),
    [scope, sources, tracePreviewQuery.preview, isProviderAvailable]
  );

  return (
    <EuiPanel hasBorder paddingSize="l" data-test-subj="contextInvestigationScopePanel">
      <EuiFlexGroup alignItems="flexStart" gutterSize="m" responsive={false}>
        <EuiFlexItem css={{ minWidth: 0 }}>
          <EuiTitle size="s">
            <h2>
              <FormattedMessage
                id="xpack.contextEngine.investigationScope.title"
                defaultMessage="Scope"
              />
            </h2>
          </EuiTitle>
          <EuiSpacer size="xs" />
          <EuiText size="s" color="subdued">
            <p>
              <FormattedMessage
                id="xpack.contextEngine.investigationScope.description"
                defaultMessage="What the Context Engine agent may inspect for this AI index. Changes are saved as you go."
              />
            </p>
          </EuiText>
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="m" />
      {isLoading ? (
        <EuiSkeletonText lines={4} data-test-subj="contextInvestigationScopeLoading" />
      ) : (
        <>
          <ModeSelector mode={scope.mode} onChange={handleModeChange} isDisabled={isManaged} />
          {includesSources(scope) && (
            <>
              <EuiHorizontalRule margin="m" />
              <SourceScopeSection
                sources={sources}
                canEdit={aiIndex !== undefined && !isManaged}
                onEditSources={onEditSources}
                onPreview={() => runPreview(sources)}
                isPreviewing={isPreviewing}
                preview={sourcePreview}
                previewError={previewError}
              />
            </>
          )}
          {includesTraces(scope) && (
            <>
              <EuiHorizontalRule margin="m" />
              <TraceScopeSection
                trace={trace}
                onChange={handleTraceChange}
                preview={tracePreviewQuery.preview}
                isPreviewing={tracePreviewQuery.isLoading}
                isDisabled={isManaged}
              />
            </>
          )}
          <EuiHorizontalRule margin="m" />
          <InvestigationPanel
            canRun={blocker === undefined && !isManaged}
            blockedReason={blocker}
            isRunning={isRunning}
            onRun={run}
            stage={stage}
            savedWorkflowCount={savedWorkflowIds.length}
          />
        </>
      )}
    </EuiPanel>
  );
};
