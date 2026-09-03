/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useQuery } from '@kbn/react-query';
import type { TraceScopePreviewResponse } from '../../../common/http_api/investigation_scope';
import { previewTraceScope } from '../api/investigation_scope';
import { contextEngineQueryKeys } from './query_keys';
import { useKibana } from './use_kibana';

const PREVIEW_STALE_TIME_MS = 60_000;

/**
 * Bounded request / tool-call counts for a trace scope. Fetched only once an agent (or a custom
 * ES|QL scope) is selected, and cached per (agent, range, esql).
 */
export const useTraceScopePreview = ({
  from,
  to,
  agentId,
  esql,
}: {
  from: string;
  to: string;
  agentId?: string;
  esql?: string;
}) => {
  const {
    services: { http },
  } = useKibana();

  const enabled = Boolean(agentId) || Boolean(esql && esql.trim().length > 0);

  const { data, isLoading, isError, error } = useQuery<TraceScopePreviewResponse, Error>({
    queryKey: contextEngineQueryKeys.investigationScope.traceScopePreview(
      from,
      to,
      agentId ?? '',
      esql ?? ''
    ),
    queryFn: ({ signal }) => previewTraceScope(http, { from, to, agentId, esql, signal }),
    enabled,
    staleTime: PREVIEW_STALE_TIME_MS,
    keepPreviousData: true,
  });

  return { preview: data, isLoading: enabled && isLoading, isError, error };
};
