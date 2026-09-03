/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { HttpStart } from '@kbn/core-http-browser';
import {
  AI_INDEX_INTERNAL_API_VERSION,
  sourcesPreviewPath,
  sourcesValidatePath,
  traceAgentsPath,
  traceScopePreviewPath,
} from '../../../common/constants';
import type { AiIndexSource } from '../../../common/http_api/ai_indices';
import type {
  ListTraceAgentsResponse,
  PreviewSourcesResponse,
  TraceScopePreviewResponse,
  ValidateEsqlSourceResponse,
} from '../../../common/http_api/investigation_scope';

const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

export const validateEsqlSource = (
  http: HttpStart,
  { esql, signal }: { esql: string; signal?: AbortSignal }
): Promise<ValidateEsqlSourceResponse> =>
  http.post<ValidateEsqlSourceResponse>(sourcesValidatePath, {
    version: AI_INDEX_INTERNAL_API_VERSION,
    body: JSON.stringify({ esql }),
    ...withSignal(signal),
  });

export const previewSources = (
  http: HttpStart,
  { sources, signal }: { sources: AiIndexSource[]; signal?: AbortSignal }
): Promise<PreviewSourcesResponse> =>
  http.post<PreviewSourcesResponse>(sourcesPreviewPath, {
    version: AI_INDEX_INTERNAL_API_VERSION,
    body: JSON.stringify({ sources }),
    ...withSignal(signal),
  });

export interface TraceRange {
  from: string;
  to: string;
}

export const listTraceAgents = (
  http: HttpStart,
  { from, to, signal }: TraceRange & { signal?: AbortSignal }
): Promise<ListTraceAgentsResponse> =>
  http.get<ListTraceAgentsResponse>(traceAgentsPath, {
    version: AI_INDEX_INTERNAL_API_VERSION,
    query: { from, to },
    ...withSignal(signal),
  });

export const previewTraceScope = (
  http: HttpStart,
  {
    from,
    to,
    agentId,
    esql,
    signal,
  }: TraceRange & { agentId?: string; esql?: string; signal?: AbortSignal }
): Promise<TraceScopePreviewResponse> =>
  http.get<TraceScopePreviewResponse>(traceScopePreviewPath, {
    version: AI_INDEX_INTERNAL_API_VERSION,
    query: {
      from,
      to,
      ...(agentId !== undefined ? { agentId } : {}),
      ...(esql !== undefined ? { esql } : {}),
    },
    ...withSignal(signal),
  });
