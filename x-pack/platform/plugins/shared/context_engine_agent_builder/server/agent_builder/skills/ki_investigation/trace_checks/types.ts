/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { FindingKind } from '@kbn/context-engine-plugin/common/http_api/findings';
import type { BaselineRow, BaselineThreshold, Prevalence, SampleBand } from './analysis';
import type { TraceScopeSelector } from './queries';

export type CheckId =
  | 'T1'
  | 'T2'
  | 'T3'
  | 'T4'
  | 'T5'
  | 'T6'
  | 'T7'
  | 'T8'
  | 'T9'
  | 'T10'
  | 'T11'
  | 'T12'
  | 'T13';

export type CheckStatus =
  /** The detector crossed its threshold for at least one signature. */
  | 'fired'
  | 'not_fired'
  /** Could not run: privacy flag off, empty cohort, missing field. */
  | 'skipped'
  /** Ran, but the request count is below the band the check needs. */
  | 'insufficient'
  /** Positive signal or protocol input, never a finding. */
  | 'provided';

export type ConfidenceCap = 'confirmed' | 'strong' | 'suggestive' | 'insufficient';

export interface CheckSignature {
  /** Stable pattern key, e.g. `platform.core.execute_esql|verification_exception ...`. */
  signature: string;
  kind: FindingKind;
  prevalence: Prevalence;
  /** Whether the sample includes the whole request sample or only the bounded detail set. */
  counted_over: 'sample' | 'detail_set';
  ki_eligible: boolean;
  /** Highest confidence the skill may assign from this evidence alone. */
  confidence_cap: ConfidenceCap;
  sample_trace_ids: string[];
  details: Record<string, unknown>;
}

export interface CheckRow {
  check_id: CheckId;
  name: string;
  status: CheckStatus;
  /** Human-readable gate that was applied, when the check has one. */
  threshold?: string;
  counts: Record<string, number>;
  signatures: CheckSignature[];
  note?: string;
}

export interface RequestProfile {
  trace_id: string;
  conversation_id?: string;
  calls: number;
  tools: string[];
  signature: string;
}

export interface Outlier {
  check_id: 'T3' | 'T4';
  trace_id: string;
  conversation_id?: string;
  calls: number;
  /** Set for T4: the tool whose repeats crossed the tool-level threshold. */
  tool?: string;
  signature: string;
  threshold: BaselineThreshold;
  baseline: BaselineRow;
  cohort_trace_ids: string[];
  cohort_rule: 'same_signature_at_or_below_median' | 'dominant_tool_at_median' | 'none';
}

export interface RequestStep {
  step: number;
  tool: string;
  digest: string;
  status: 'Ok' | 'Error' | 'Unset';
  status_message?: string;
  partial_error: boolean;
  empty_result: boolean;
  result_chars: number;
  duration_seconds: number;
}

export interface RequestDetail {
  trace_id: string;
  conversation_id?: string;
  role: 'outlier' | 'cohort' | 'error';
  steps: RequestStep[];
  first_user_message?: string;
  final_assistant_message?: string;
  finish_reason?: string;
  soft_failure: boolean;
}

export interface PrivacyFlags {
  tool_details: boolean;
  llm_responses: boolean;
  user_prompts: boolean;
}

export interface TraceChecksParameters {
  sample_cap: number;
  percentile: number;
  mad_multiplier: number;
  top_tools: number;
  prevalence_min_requests: number;
  prevalence_min_fraction: number;
  prevalence_min_conversations: number;
  detail_limit: number;
  token_growth_factor: number;
}

export interface TraceChecksResult {
  traces_index: string;
  scope: TraceScopeSelector;
  parameters: TraceChecksParameters;
  sample: {
    total_requests: number;
    sampled_requests: number;
    sampling_fraction: number;
    distinct_conversations: number;
    band: SampleBand;
  };
  privacy: PrivacyFlags;
  baselines: {
    request?: BaselineRow & BaselineThreshold;
    tools: Array<{ tool: string; total: number } & BaselineRow & BaselineThreshold>;
  };
  checks: CheckRow[];
  outliers: Outlier[];
  detail: RequestDetail[];
  coverage: {
    ran: number;
    fired: number;
    not_fired: number;
    skipped: number;
    insufficient: number;
  };
}
