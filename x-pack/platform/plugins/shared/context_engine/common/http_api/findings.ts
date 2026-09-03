/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AiIndexInvestigationMode, AiIndexSource } from './ai_indices';
import type { InvestigationStage } from '../investigation';

/**
 * The single global Context Engine findings index. Global like improvements: findings hang off an
 * AI index, which has no space dimension, and one index keeps `deleteByAiIndex` complete. It holds
 * two document kinds told apart by `doc_type`: one `investigation` record per run and one `finding`
 * record per fingerprint (`ai_index_id + kind + subject`), re-used across runs.
 */
export const FINDINGS_INDEX = 'context-engine-findings';

export const OBSERVED_FINDING_KINDS = [
  'tool_error',
  'partial_tool_error',
  'validation_error',
  'loop',
  'empty_retrieval',
  'soft_failure',
  'timeout_or_latency',
  'token_runaway',
  'unsupported_operation',
  'system_error',
  'discovery_loop',
] as const;

export const HYPOTHESIZED_FINDING_KINDS = [
  'discovery_risk',
  'query_risk',
  'consolidation_cost',
  'reading_cost',
  'spread_without_join_key',
  'probe_unanswerable',
] as const;

export const FINDING_KINDS = [...OBSERVED_FINDING_KINDS, ...HYPOTHESIZED_FINDING_KINDS] as const;

export type ObservedFindingKind = (typeof OBSERVED_FINDING_KINDS)[number];
export type HypothesizedFindingKind = (typeof HYPOTHESIZED_FINDING_KINDS)[number];
export type FindingKind = (typeof FINDING_KINDS)[number];

/** How the finding was obtained; a description, not a tier. */
export type FindingEvidenceType = 'observed' | 'hypothesized';

export const FINDING_CONFIDENCES = ['confirmed', 'strong', 'suggestive'] as const;
export type FindingConfidence = (typeof FINDING_CONFIDENCES)[number];

export const FINDING_IMPACTS = ['high', 'medium', 'low'] as const;
export type FindingImpact = (typeof FINDING_IMPACTS)[number];

export const KI_USEFULNESS_VALUES = ['likely', 'possible', 'unlikely'] as const;
export type KiUsefulness = (typeof KI_USEFULNESS_VALUES)[number];

export const FINDING_DECISIONS = [
  'dismiss',
  'known_issue',
  'create_ki',
  'create_ki_and_signal',
] as const;
export type FindingDecision = (typeof FINDING_DECISIONS)[number];

/** Decisions that suppress the same fingerprint in later runs. */
export const SUPPRESSING_DECISIONS: readonly FindingDecision[] = ['dismiss', 'known_issue'];

/** Decisions that ask for a KI (with or without a signal). */
export const CREATE_DECISIONS: readonly FindingDecision[] = ['create_ki', 'create_ki_and_signal'];

/**
 * Where a finding stands.
 *
 * - `open` — recorded, awaiting a decision.
 * - `suppressed` — matched a prior `dismiss` / `known_issue`; reported but not up for decision.
 * - `decided` — a decision was recorded in this or a prior run.
 * - `planned` — a `create_ki*` decision was turned into a plan item.
 * - `generated` — a KI or automation exists for it.
 */
export type FindingStatus = 'open' | 'suppressed' | 'decided' | 'planned' | 'generated';

/** Recurrence over the sampled requests; required for `observed` findings. */
export interface FindingPrevalence {
  affected_requests: number;
  sampled_requests: number;
  affected_fraction: number;
  distinct_conversations: number;
  /** Set when prevalence was counted over the bounded detail set rather than the full sample. */
  counted_over?: 'sample' | 'detail_set';
}

export type ScaleUnitKind = 'indices' | 'entities' | 'probes' | 'fields' | 'documents';

/** Breadth of a measured property; required for `hypothesized` findings. */
export interface FindingScale {
  affected_units: number;
  total_units: number;
  unit_kind: ScaleUnitKind;
}

export interface FindingEvidence {
  /** Named counts behind the finding, e.g. `{ calls: 120, errors: 17 }`. */
  counts?: Record<string, number>;
  sample_trace_ids?: string[];
  /** The query that reproduces the evidence, when there is one. */
  esql?: string;
  /** Which measured property the finding rests on (hypothesized). */
  measured_property?: string;
  /** Short free text: an error message, a field name pair, an exemplar. */
  notes?: string;
}

export type FindingGateRule = 'prevalence' | 'scale' | 'none';

/** Why the finding is or is not KI-eligible, shown on every card. */
export interface FindingGate {
  rule: FindingGateRule;
  passed: boolean;
  reason: string;
}

export interface FindingDecisionRecord {
  decision: FindingDecision;
  reason?: string;
  decided_at: string;
  decided_by?: string;
  /** The investigation the decision was taken in. */
  investigation_id?: string;
}

/** What the pipeline eventually produced for the finding. */
export interface FindingOutcome {
  ki_ids?: string[];
  workflow_ids?: string[];
  signal_ki_id?: string;
  updated_at: string;
}

/** What the agent records; everything else on {@link Finding} is derived by the store. */
export interface FindingInput {
  kind: FindingKind;
  evidence_type: FindingEvidenceType;
  title: string;
  summary: string;
  /**
   * The thing the KI would address, e.g. `execute_esql:verification_exception`,
   * `logs-*:field_overlap`. Part of the fingerprint, so it must be stable across runs.
   */
  subject: string;
  confidence: FindingConfidence;
  impact: FindingImpact;
  ki_usefulness: KiUsefulness;
  prevalence?: FindingPrevalence;
  scale?: FindingScale;
  evidence: FindingEvidence;
}

export interface Finding extends FindingInput {
  doc_type: 'finding';
  finding_id: string;
  ai_index_id: string;
  /** The run that last recorded this fingerprint. */
  investigation_id: string;
  '@timestamp': string;
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  ki_eligible: boolean;
  gate: FindingGate;
  status: FindingStatus;
  /** The prior decision that suppressed this occurrence, when `status` is `suppressed`. */
  suppressed_by?: FindingDecisionRecord;
  decision?: FindingDecisionRecord;
  outcome?: FindingOutcome;
}

export type AccessMode = 'queries' | 'text_only' | 'unknown';

export interface InvestigationProbe {
  probe_id: string;
  question: string;
  /** Indices / sources on the answer path, when known. */
  answer_path?: string[];
  answerable?: boolean;
}

/** One measured fact: a data property per index, a probe answer path, or a T12/T13 trace row. */
export interface InvestigationMeasurement {
  measurement_id: string;
  kind: string;
  subject: string;
  values: Record<string, number | string | boolean | null>;
  notes?: string;
}

export type StrategyShape = 'systemic' | 'targeted_only' | 'both' | 'none';

export interface StrategyFamily {
  family_id: string;
  family: string;
  unit_key: string;
  unit_count: number;
  extraction: 'llm' | 'mechanical';
  freshness: 'static' | 'cursor';
  readiness: 'routing_only' | 'query_ready';
  /** Probe ids or task-shape ids the family serves. */
  serves: string[];
}

export interface StrategyTargetedKi {
  finding_id: string;
  ki_type: string;
}

export interface InvestigationStrategy {
  shape: StrategyShape;
  families: StrategyFamily[];
  targeted_kis: StrategyTargetedKi[];
  cost_estimate: string;
  rationale: string;
  approved_at?: string;
  approved_by?: string;
}

export interface PlanWorkflowSpec {
  plan_item_id: string;
  family_id: string;
  name: string;
  unit_key: string;
  foreach: string;
  freshness_cursor?: string;
  readiness: 'routing_only' | 'query_ready';
  spec: string;
  workflow_id?: string;
}

export interface PlanTargetedKiSpec {
  plan_item_id: string;
  finding_id: string;
  ki_type: string;
  title: string;
  spec: string;
  ki_id?: string;
}

export interface InvestigationPlan {
  workflows: PlanWorkflowSpec[];
  targeted_kis: PlanTargetedKiSpec[];
}

/** Snapshot of the scope the run started from, so a later session can resume without the page. */
export interface InvestigationScopeSnapshot {
  mode: AiIndexInvestigationMode;
  sources: AiIndexSource[];
  source_summary?: {
    valid_sources: number;
    resolved_indices: string[];
    doc_count: number;
    count_capped: boolean;
  };
  trace?: {
    agent_id?: string;
    from: string;
    to: string;
    custom_esql?: string;
    counts?: {
      requests: number;
      conversations: number;
      tool_calls: number;
      failed_tool_calls: number;
    };
  };
}

export interface InvestigationRecord {
  doc_type: 'investigation';
  investigation_id: string;
  ai_index_id: string;
  stage: InvestigationStage;
  '@timestamp': string;
  started_at: string;
  updated_at: string;
  started_by?: string;
  scope: InvestigationScopeSnapshot;
  access_mode?: AccessMode;
  probes?: InvestigationProbe[];
  measurements?: InvestigationMeasurement[];
  finding_ids: string[];
  strategy?: InvestigationStrategy;
  plan?: InvestigationPlan;
  /** Fixed-shape closing statement: checks run, eligible, rare, not fired, skipped. */
  run_summary?: Record<string, number>;
}

export interface ListFindingsResponse {
  items: Finding[];
  total: number;
}

export interface ListInvestigationsResponse {
  items: InvestigationRecord[];
  total: number;
}

export interface GetLatestInvestigationResponse {
  investigation: InvestigationRecord | undefined;
  findings: Finding[];
}

/** A dismiss / known-issue decision from an earlier run, carried so suppression is deterministic. */
export interface PriorDecision extends FindingDecisionRecord {
  finding_id: string;
  kind: Finding['kind'];
  subject: string;
}

export interface StartInvestigationRequest {
  scope: InvestigationScopeSnapshot;
}

export interface StartInvestigationResponse {
  investigation: InvestigationRecord;
  prior_decisions: PriorDecision[];
}
