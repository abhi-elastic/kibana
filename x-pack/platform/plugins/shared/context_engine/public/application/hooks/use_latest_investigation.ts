/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useQuery, useQueryClient } from '@kbn/react-query';
import { useCallback } from 'react';
import type { GetLatestInvestigationResponse } from '../../../common/http_api/findings';
import { getLatestInvestigation } from '../api/findings';
import { contextEngineQueryKeys } from './query_keys';
import { useKibana } from './use_kibana';

/**
 * Newest investigation for an AI index and its findings, from the findings store. This is what the
 * Investigation panel shows after a reload, before (or instead of) any chat events.
 */
export const useLatestInvestigation = (aiIndexId: string | undefined, enabled = true) => {
  const {
    services: { http },
  } = useKibana();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery<GetLatestInvestigationResponse, Error>({
    queryKey: contextEngineQueryKeys.investigations.latest(aiIndexId ?? ''),
    queryFn: ({ signal }) =>
      getLatestInvestigation(http, { aiIndexId: aiIndexId as string, signal }),
    enabled: enabled && Boolean(aiIndexId),
    staleTime: 30_000,
  });

  const invalidate = useCallback(() => {
    if (aiIndexId) {
      queryClient.invalidateQueries({
        queryKey: contextEngineQueryKeys.investigations.latest(aiIndexId),
      });
    }
  }, [queryClient, aiIndexId]);

  return {
    investigation: data?.investigation,
    findings: data?.findings ?? [],
    isLoading: Boolean(aiIndexId) && isLoading,
    isError,
    error,
    invalidate,
  };
};
