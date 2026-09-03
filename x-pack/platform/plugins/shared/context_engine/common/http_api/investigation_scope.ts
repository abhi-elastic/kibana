/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AiIndexSource } from './ai_indices';

/** One problem found while validating an ES|QL source; `position` is set for parser errors. */
export interface EsqlSourceValidationError {
  message: string;
  /** `static` for parser errors, otherwise the Elasticsearch error type (e.g. `verification_exception`). */
  type: string;
  position?: { min: number; max: number };
}

export interface ValidateEsqlSourceRequest {
  esql: string;
}

export type ValidateEsqlSourceResponse =
  | { valid: true }
  | { valid: false; errors: EsqlSourceValidationError[] };

export interface PreviewSourcesRequest {
  sources: AiIndexSource[];
}

export interface EsqlSourcePreview {
  source: AiIndexSource;
  status: 'ok' | 'invalid';
  columns: string[];
  /** Up to 5 sample rows, positional to `columns`. */
  rows: unknown[][];
  resolved_indices: string[];
  /** Document count over the resolved indices, capped by `count_capped`. */
  doc_count?: number;
  count_capped: boolean;
  errors: EsqlSourceValidationError[];
}

export interface SkippedSourcePreview {
  source: AiIndexSource;
  status: 'skipped';
  reason: string;
}

export type SourcePreview = EsqlSourcePreview | SkippedSourcePreview;

export interface PreviewSourcesResponse {
  sources: SourcePreview[];
  summary: {
    valid_sources: number;
    invalid_sources: number;
    skipped_sources: number;
    resolved_indices: string[];
    doc_count: number;
    count_capped: boolean;
  };
}

export interface TraceAgentEntry {
  /** Raw `attributes.gen_ai.agent.id` as carried by the traces. */
  agent_id: string;
  /** Present only when the ES|QL fallback ran; `terms_enum` returns no counts. */
  requests?: number;
}

export interface ListTraceAgentsResponse {
  agents: TraceAgentEntry[];
  /** How the list was obtained. */
  method: 'terms_enum' | 'esql';
  traces_index: string;
}

export interface TraceScopePreviewResponse {
  traces_index: string;
  requests: number;
  conversations: number;
  tool_calls: number;
  failed_tool_calls: number;
  /** Set when a custom ES|QL scope failed validation; counts are zero in that case. */
  errors?: EsqlSourceValidationError[];
}
