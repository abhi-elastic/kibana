/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useQuery } from '@kbn/react-query';
import type { ListTraceAgentsResponse } from '../../../common/http_api/investigation_scope';
import { listTraceAgents } from '../api/investigation_scope';
import { contextEngineQueryKeys } from './query_keys';
import { useKibana } from './use_kibana';

/** Matches the value-suggestion provider's one-minute memoize. */
export const TRACE_AGENTS_STALE_TIME_MS = 60_000;

/**
 * Agents observed in the current space's traces for a time range. Entries come only from the
 * traces (raw ids), never from the Agent Builder registry: a registered agent without traces has
 * nothing to investigate, and an external agent is never registered.
 */
export const useTraceAgents = ({
  from,
  to,
  enabled = true,
}: {
  from: string;
  to: string;
  enabled?: boolean;
}) => {
  const {
    services: { http },
  } = useKibana();

  const { data, isLoading, isError, error, refetch } = useQuery<ListTraceAgentsResponse, Error>({
    queryKey: contextEngineQueryKeys.investigationScope.traceAgents(from, to),
    queryFn: ({ signal }) => listTraceAgents(http, { from, to, signal }),
    enabled,
    staleTime: TRACE_AGENTS_STALE_TIME_MS,
    keepPreviousData: true,
  });

  return {
    agents: data?.agents ?? [],
    method: data?.method,
    tracesIndex: data?.traces_index,
    isLoading: enabled && isLoading,
    isError,
    error,
    refetch,
  };
};
