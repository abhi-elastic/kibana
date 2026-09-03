/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type {
  AiIndexInvestigationScope,
  GetAiIndexResponse,
} from '../../../common/http_api/ai_indices';
import type {
  PreviewSourcesResponse,
  TraceScopePreviewResponse,
} from '../../../common/http_api/investigation_scope';
import { investigationStageIndex } from '../../../common/investigation';
import type { InvestigationStage } from '../../../common/investigation';
import type { InvestigationEvent } from '../../types';
import { useKibana } from './use_kibana';

export interface InvestigationStatus {
  stage: InvestigationStage | undefined;
  investigationId: string | undefined;
  savedWorkflowIds: string[];
}

export const INITIAL_INVESTIGATION_STATUS: InvestigationStatus = {
  stage: undefined,
  investigationId: undefined,
  savedWorkflowIds: [],
};

/** Folds chat events into the panel status; stages never move backwards within a run. */
export const investigationStatusReducer = (
  status: InvestigationStatus,
  event: InvestigationEvent
): InvestigationStatus => {
  switch (event.type) {
    case 'stage': {
      const moved =
        status.stage === undefined ||
        investigationStageIndex(event.stage) >= investigationStageIndex(status.stage);
      return {
        ...status,
        stage: moved ? event.stage : status.stage,
        investigationId: event.investigationId ?? status.investigationId,
      };
    }
    case 'automation_saved':
      return {
        ...status,
        stage: 'generated',
        savedWorkflowIds: status.savedWorkflowIds.includes(event.workflowId)
          ? status.savedWorkflowIds
          : [...status.savedWorkflowIds, event.workflowId],
      };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};

interface UseRunInvestigationParams {
  aiIndex: GetAiIndexResponse | undefined;
  scope: AiIndexInvestigationScope;
  sourcePreview?: PreviewSourcesResponse;
  tracePreview?: TraceScopePreviewResponse;
  /** Stage persisted server-side, used after a reload when no chat events have arrived yet. */
  persistedStage?: InvestigationStage;
  /** Called on every progress event so the page can refetch the AI index / automations. */
  onProgress: () => void;
}

export const useRunInvestigation = ({
  aiIndex,
  scope,
  sourcePreview,
  tracePreview,
  persistedStage,
  onProgress,
}: UseRunInvestigationParams) => {
  const {
    services: { getAgentBuilderIntegration },
  } = useKibana();
  const provider = getAgentBuilderIntegration?.()?.investigation;

  const [status, dispatch] = useReducer(investigationStatusReducer, INITIAL_INVESTIGATION_STATUS);
  const [isRunning, setIsRunning] = useState(false);

  const onProgressRef = useRef(onProgress);
  useLayoutEffect(() => {
    onProgressRef.current = onProgress;
  });

  const isProviderAvailable = useMemo(
    () => provider?.canRun({ aiIndex }) ?? false,
    [provider, aiIndex]
  );

  useEffect(() => {
    if (!provider || !aiIndex?.id) {
      return;
    }
    return provider.subscribeToInvestigationEvents(aiIndex.id, (event) => {
      dispatch(event);
      setIsRunning(false);
      onProgressRef.current();
    });
  }, [provider, aiIndex?.id]);

  const run = useCallback(async () => {
    if (!isProviderAvailable || !aiIndex || !provider) {
      return;
    }
    setIsRunning(true);
    try {
      await provider.runInvestigation({ aiIndex, scope, sourcePreview, tracePreview });
    } finally {
      // The side panel has opened; the badges take over from here.
      setIsRunning(false);
    }
  }, [provider, isProviderAvailable, aiIndex, scope, sourcePreview, tracePreview]);

  return {
    isProviderAvailable,
    isRunning,
    run,
    stage: status.stage ?? persistedStage,
    investigationId: status.investigationId,
    savedWorkflowIds: status.savedWorkflowIds,
  };
};
