/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod/v4';
import { aiIndexIdFieldSchema, aiIndexSourceSchema } from './ai_index_schemas';
import {
  MAX_AI_INDEX_SOURCES,
  MAX_FINDINGS_PER_INVESTIGATION,
  MAX_FINDING_ESQL_LENGTH,
  MAX_FINDING_SAMPLE_TRACE_IDS,
  MAX_FINDING_SUBJECT_LENGTH,
  MAX_FINDING_TEXT_LENGTH,
  MAX_INVESTIGATION_MEASUREMENTS,
  MAX_INVESTIGATION_PROBES,
  MAX_INVESTIGATION_TIME_RANGE_LENGTH,
  MAX_INVESTIGATION_TRACE_AGENT_ID_LENGTH,
  MAX_INVESTIGATION_TRACE_ESQL_LENGTH,
  MAX_PLAN_ITEMS,
  MAX_STRATEGY_FAMILIES,
} from './constants';
import {
  FINDING_CONFIDENCES,
  FINDING_DECISIONS,
  FINDING_IMPACTS,
  FINDING_KINDS,
  KI_USEFULNESS_VALUES,
} from './http_api/findings';
import type {
  Finding,
  FindingDecisionRecord,
  InvestigationPlan,
  InvestigationRecord,
  InvestigationStrategy,
} from './http_api/findings';
import { INVESTIGATION_STAGES, investigationStageIndex } from './investigation';
import type { InvestigationStage } from './investigation';

const MAX_ID_LENGTH = 128;
const MAX_SHORT_TEXT_LENGTH = 512;
const MAX_COUNTS_PER_EVIDENCE = 20;
const MAX_MEASUREMENT_VALUES = 30;
const MAX_ANSWER_PATH_ENTRIES = 20;
const MAX_SERVES_ENTRIES = 20;
const MAX_PRIOR_DECISIONS = 100;
const MAX_RUN_SUMMARY_ENTRIES = 20;

const idSchema = z.string().min(1).max(MAX_ID_LENGTH);
const shortTextSchema = z.string().max(MAX_SHORT_TEXT_LENGTH);
const textSchema = z.string().max(MAX_FINDING_TEXT_LENGTH);
const nonNegativeInt = z.number().int().min(0);

export const investigationStageSchema = z.enum(INVESTIGATION_STAGES);
export const accessModeSchema = z.enum(['queries', 'text_only', 'unknown']);

export const findingPrevalenceSchema = z.object({
  affected_requests: nonNegativeInt,
  sampled_requests: nonNegativeInt,
  affected_fraction: z.number().min(0).max(1),
  distinct_conversations: nonNegativeInt,
  counted_over: z.enum(['sample', 'detail_set']).optional(),
});

export const findingScaleSchema = z.object({
  affected_units: nonNegativeInt,
  total_units: nonNegativeInt,
  unit_kind: z.enum(['indices', 'entities', 'probes', 'fields', 'documents']),
});

export const findingEvidenceSchema = z.object({
  counts: z
    .record(z.string().max(64), z.number())
    .refine((counts) => Object.keys(counts).length <= MAX_COUNTS_PER_EVIDENCE, {
      message: `At most ${MAX_COUNTS_PER_EVIDENCE} named counts`,
    })
    .optional(),
  sample_trace_ids: z.array(idSchema).max(MAX_FINDING_SAMPLE_TRACE_IDS).optional(),
  esql: z.string().max(MAX_FINDING_ESQL_LENGTH).optional(),
  measured_property: shortTextSchema.optional(),
  notes: textSchema.optional(),
});

/** What the agent records for one finding; the store derives ids, gates and status. */
export const findingInputSchema = z
  .object({
    kind: z.enum(FINDING_KINDS),
    evidence_type: z.enum(['observed', 'hypothesized']),
    title: z.string().min(1).max(MAX_SHORT_TEXT_LENGTH),
    summary: z.string().min(1).max(MAX_FINDING_TEXT_LENGTH),
    subject: z.string().min(1).max(MAX_FINDING_SUBJECT_LENGTH),
    confidence: z.enum(FINDING_CONFIDENCES),
    impact: z.enum(FINDING_IMPACTS),
    ki_usefulness: z.enum(KI_USEFULNESS_VALUES),
    prevalence: findingPrevalenceSchema.optional(),
    scale: findingScaleSchema.optional(),
    evidence: findingEvidenceSchema,
  })
  .superRefine((finding, ctx) => {
    if (finding.evidence_type === 'observed' && !finding.prevalence) {
      ctx.addIssue({
        code: 'custom',
        path: ['prevalence'],
        message: 'Observed findings need prevalence (affected requests over the sample).',
      });
    }
    if (finding.evidence_type === 'hypothesized' && !finding.scale) {
      ctx.addIssue({
        code: 'custom',
        path: ['scale'],
        message: 'Hypothesized findings need scale (affected units over total units).',
      });
    }
  });

export const findingDecisionInputSchema = z.object({
  finding_id: idSchema,
  decision: z.enum(FINDING_DECISIONS),
  reason: textSchema.optional(),
});

export const investigationProbeSchema = z.object({
  probe_id: idSchema,
  question: z.string().min(1).max(MAX_FINDING_TEXT_LENGTH),
  answer_path: z.array(shortTextSchema).max(MAX_ANSWER_PATH_ENTRIES).optional(),
  answerable: z.boolean().optional(),
});

export const investigationMeasurementSchema = z.object({
  measurement_id: idSchema,
  kind: z.string().min(1).max(64),
  subject: z.string().min(1).max(MAX_FINDING_SUBJECT_LENGTH),
  values: z
    .record(
      z.string().max(64),
      z.union([z.number(), z.string().max(MAX_SHORT_TEXT_LENGTH), z.boolean(), z.null()])
    )
    .refine((values) => Object.keys(values).length <= MAX_MEASUREMENT_VALUES, {
      message: `At most ${MAX_MEASUREMENT_VALUES} values per measurement`,
    }),
  notes: textSchema.optional(),
});

export const strategyFamilySchema = z.object({
  family_id: idSchema,
  family: z.string().min(1).max(MAX_SHORT_TEXT_LENGTH),
  unit_key: z.string().min(1).max(MAX_SHORT_TEXT_LENGTH),
  unit_count: nonNegativeInt,
  extraction: z.enum(['llm', 'mechanical']),
  freshness: z.enum(['static', 'cursor']),
  readiness: z.enum(['routing_only', 'query_ready']),
  serves: z.array(idSchema).max(MAX_SERVES_ENTRIES),
});

export const strategyTargetedKiSchema = z.object({
  finding_id: idSchema,
  ki_type: z.string().min(1).max(64),
});

export const investigationStrategySchema = z
  .object({
    shape: z.enum(['systemic', 'targeted_only', 'both', 'none']),
    families: z.array(strategyFamilySchema).max(MAX_STRATEGY_FAMILIES),
    targeted_kis: z.array(strategyTargetedKiSchema).max(MAX_PLAN_ITEMS),
    cost_estimate: z.string().max(MAX_SHORT_TEXT_LENGTH),
    rationale: z.string().max(MAX_FINDING_TEXT_LENGTH),
    approved_at: z.string().optional(),
    approved_by: shortTextSchema.optional(),
  })
  .superRefine((strategy, ctx) => {
    if (
      (strategy.shape === 'systemic' || strategy.shape === 'both') &&
      strategy.families.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['families'],
        message: `A '${strategy.shape}' strategy needs at least one family.`,
      });
    }
    if (
      (strategy.shape === 'targeted_only' || strategy.shape === 'both') &&
      strategy.targeted_kis.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['targeted_kis'],
        message: `A '${strategy.shape}' strategy needs at least one targeted KI.`,
      });
    }
    if (
      strategy.shape === 'none' &&
      (strategy.families.length > 0 || strategy.targeted_kis.length > 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['shape'],
        message: "Shape 'none' cannot carry families or targeted KIs.",
      });
    }
    if (strategy.shape !== 'none' && strategy.rationale.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['rationale'],
        message: 'Cite the measurements or accepted findings the strategy rests on.',
      });
    }
  });

export const planWorkflowSpecSchema = z.object({
  plan_item_id: idSchema,
  family_id: idSchema,
  name: z.string().min(1).max(MAX_SHORT_TEXT_LENGTH),
  unit_key: z.string().min(1).max(MAX_SHORT_TEXT_LENGTH),
  foreach: z.string().min(1).max(MAX_FINDING_TEXT_LENGTH),
  freshness_cursor: shortTextSchema.optional(),
  readiness: z.enum(['routing_only', 'query_ready']),
  spec: z.string().min(1).max(MAX_FINDING_ESQL_LENGTH),
  workflow_id: shortTextSchema.optional(),
});

export const planTargetedKiSpecSchema = z.object({
  plan_item_id: idSchema,
  finding_id: idSchema,
  ki_type: z.string().min(1).max(64),
  title: z.string().min(1).max(MAX_SHORT_TEXT_LENGTH),
  spec: z.string().min(1).max(MAX_FINDING_ESQL_LENGTH),
  ki_id: shortTextSchema.optional(),
});

export const investigationPlanSchema = z
  .object({
    workflows: z.array(planWorkflowSpecSchema).max(MAX_PLAN_ITEMS),
    targeted_kis: z.array(planTargetedKiSpecSchema).max(MAX_PLAN_ITEMS),
  })
  .superRefine((plan, ctx) => {
    const ids = [...plan.workflows, ...plan.targeted_kis].map((item) => item.plan_item_id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['workflows'],
        message: 'plan_item_id must be unique.',
      });
    }
  });

export const investigationScopeSnapshotSchema = z.object({
  mode: z.enum(['sources', 'traces', 'both']),
  sources: z.array(aiIndexSourceSchema).max(MAX_AI_INDEX_SOURCES),
  source_summary: z
    .object({
      valid_sources: nonNegativeInt,
      resolved_indices: z.array(z.string().max(MAX_SHORT_TEXT_LENGTH)).max(500),
      doc_count: nonNegativeInt,
      count_capped: z.boolean(),
    })
    .optional(),
  trace: z
    .object({
      agent_id: z.string().min(1).max(MAX_INVESTIGATION_TRACE_AGENT_ID_LENGTH).optional(),
      from: z.string().min(1).max(MAX_INVESTIGATION_TIME_RANGE_LENGTH),
      to: z.string().min(1).max(MAX_INVESTIGATION_TIME_RANGE_LENGTH),
      custom_esql: z.string().min(1).max(MAX_INVESTIGATION_TRACE_ESQL_LENGTH).optional(),
      counts: z
        .object({
          requests: nonNegativeInt,
          conversations: nonNegativeInt,
          tool_calls: nonNegativeInt,
          failed_tool_calls: nonNegativeInt,
        })
        .optional(),
    })
    .optional(),
});

/** A prior dismiss / known-issue decision, carried so suppression is deterministic context. */
export const priorDecisionSchema = z.object({
  finding_id: idSchema,
  kind: z.enum(FINDING_KINDS),
  subject: z.string().max(MAX_FINDING_SUBJECT_LENGTH),
  decision: z.enum(FINDING_DECISIONS),
  reason: textSchema.optional(),
  decided_at: z.string(),
});

const findingGateSchema = z.object({
  rule: z.enum(['prevalence', 'scale', 'none']),
  passed: z.boolean(),
  reason: shortTextSchema,
});

const findingDecisionRecordSchema = z.object({
  decision: z.enum(FINDING_DECISIONS),
  reason: textSchema.optional(),
  decided_at: z.string(),
  decided_by: shortTextSchema.optional(),
  investigation_id: idSchema.optional(),
});

/**
 * The finding as carried on the attachment: what the store derived plus the input, minus the
 * evidence body (that stays in the store and the client card fetches it on demand).
 */
export const attachmentFindingSchema = z.object({
  finding_id: idSchema,
  kind: z.enum(FINDING_KINDS),
  evidence_type: z.enum(['observed', 'hypothesized']),
  title: z.string().max(MAX_SHORT_TEXT_LENGTH),
  summary: z.string().max(MAX_FINDING_TEXT_LENGTH),
  subject: z.string().max(MAX_FINDING_SUBJECT_LENGTH),
  confidence: z.enum(FINDING_CONFIDENCES),
  impact: z.enum(FINDING_IMPACTS),
  ki_usefulness: z.enum(KI_USEFULNESS_VALUES),
  prevalence: findingPrevalenceSchema.optional(),
  scale: findingScaleSchema.optional(),
  ki_eligible: z.boolean(),
  gate: findingGateSchema,
  status: z.enum(['open', 'suppressed', 'decided', 'planned', 'generated']),
  suppressed_by: findingDecisionRecordSchema.optional(),
  decision: findingDecisionRecordSchema.optional(),
});

export type AttachmentFinding = z.infer<typeof attachmentFindingSchema>;

const requiredFrom: ReadonlyArray<{
  stage: InvestigationStage;
  field: 'findings' | 'decisions' | 'strategy' | 'plan';
}> = [
  { stage: 'findings_recorded', field: 'findings' },
  { stage: 'decisions_recorded', field: 'decisions' },
  { stage: 'strategy_approved', field: 'strategy' },
  { stage: 'planned', field: 'plan' },
];

/**
 * The one investigation attachment, versioned through stages. A field becomes required at the
 * stage that produces it and stays required afterwards, so a `planned` document always carries
 * findings, decisions and a strategy.
 */
export const investigationAttachmentDataSchema = z
  .object({
    investigation_id: idSchema,
    ai_index_id: aiIndexIdFieldSchema,
    stage: investigationStageSchema,
    scope: investigationScopeSnapshotSchema,
    prior_decisions: z.array(priorDecisionSchema).max(MAX_PRIOR_DECISIONS),
    access_mode: accessModeSchema.optional(),
    probes: z.array(investigationProbeSchema).max(MAX_INVESTIGATION_PROBES).optional(),
    measurements: z
      .array(investigationMeasurementSchema)
      .max(MAX_INVESTIGATION_MEASUREMENTS)
      .optional(),
    findings: z.array(attachmentFindingSchema).max(MAX_FINDINGS_PER_INVESTIGATION).optional(),
    decisions: z.array(findingDecisionInputSchema).max(MAX_FINDINGS_PER_INVESTIGATION).optional(),
    strategy: investigationStrategySchema.optional(),
    plan: investigationPlanSchema.optional(),
    run_summary: z
      .record(z.string().max(64), z.number())
      .refine((summary) => Object.keys(summary).length <= MAX_RUN_SUMMARY_ENTRIES, {
        message: `At most ${MAX_RUN_SUMMARY_ENTRIES} run summary entries`,
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    const reached = investigationStageIndex(data.stage);
    for (const { stage, field } of requiredFrom) {
      if (reached >= investigationStageIndex(stage) && data[field] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `'${field}' is required from stage '${stage}' (current stage '${data.stage}').`,
        });
      }
    }
  });

export type InvestigationAttachmentData = z.infer<typeof investigationAttachmentDataSchema>;

/** Drops the evidence body so the attachment stays compact; the store keeps the full finding. */
export const toAttachmentFinding = (finding: Finding): AttachmentFinding => ({
  finding_id: finding.finding_id,
  kind: finding.kind,
  evidence_type: finding.evidence_type,
  title: finding.title,
  summary: finding.summary,
  subject: finding.subject,
  confidence: finding.confidence,
  impact: finding.impact,
  ki_usefulness: finding.ki_usefulness,
  ...(finding.prevalence ? { prevalence: finding.prevalence } : {}),
  ...(finding.scale ? { scale: finding.scale } : {}),
  ki_eligible: finding.ki_eligible,
  gate: finding.gate,
  status: finding.status,
  ...(finding.suppressed_by ? { suppressed_by: finding.suppressed_by } : {}),
  ...(finding.decision ? { decision: finding.decision } : {}),
});

/**
 * Builds the attachment snapshot for an investigation record and its findings, used by the page
 * at hand-off (stage `scoped`) and by `record_investigation` after every write.
 */
export const buildInvestigationAttachmentData = ({
  investigation,
  findings,
  priorDecisions,
}: {
  investigation: InvestigationRecord;
  findings: Finding[];
  priorDecisions: Array<
    FindingDecisionRecord & { finding_id: string; kind: Finding['kind']; subject: string }
  >;
}): InvestigationAttachmentData => {
  const decided = findings.filter((finding) => finding.decision !== undefined);
  const reached = investigationStageIndex(investigation.stage);
  const strategy: InvestigationStrategy | undefined = investigation.strategy;
  const plan: InvestigationPlan | undefined = investigation.plan;
  return {
    investigation_id: investigation.investigation_id,
    ai_index_id: investigation.ai_index_id,
    stage: investigation.stage,
    scope: investigation.scope,
    prior_decisions: priorDecisions.slice(0, MAX_PRIOR_DECISIONS).map((prior) => ({
      finding_id: prior.finding_id,
      kind: prior.kind,
      subject: prior.subject,
      decision: prior.decision,
      ...(prior.reason ? { reason: prior.reason } : {}),
      decided_at: prior.decided_at,
    })),
    ...(investigation.access_mode ? { access_mode: investigation.access_mode } : {}),
    ...(investigation.probes ? { probes: investigation.probes } : {}),
    ...(investigation.measurements ? { measurements: investigation.measurements } : {}),
    ...(reached >= investigationStageIndex('findings_recorded')
      ? { findings: findings.map(toAttachmentFinding) }
      : {}),
    ...(reached >= investigationStageIndex('decisions_recorded')
      ? {
          decisions: decided.map((finding) => ({
            finding_id: finding.finding_id,
            decision: (finding.decision as FindingDecisionRecord).decision,
            ...(finding.decision?.reason ? { reason: finding.decision.reason } : {}),
          })),
        }
      : {}),
    ...(strategy ? { strategy } : {}),
    ...(plan ? { plan } : {}),
    ...(investigation.run_summary ? { run_summary: investigation.run_summary } : {}),
  };
};
