/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ToolType } from '@kbn/agent-builder-common';
import { ToolResultType } from '@kbn/agent-builder-common/tools/tool_result';
import type { BuiltinToolDefinition } from '@kbn/agent-builder-server';
import type { CoreStart, ElasticsearchClient } from '@kbn/core/server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import { z } from '@kbn/zod/v4';
import dedent from 'dedent';
import {
  MAX_FINDINGS_PER_INVESTIGATION,
  MAX_INVESTIGATION_MEASUREMENTS,
  MAX_INVESTIGATION_PROBES,
} from '@kbn/context-engine-plugin/common/constants';
import {
  accessModeSchema,
  findingDecisionInputSchema,
  findingInputSchema,
  investigationMeasurementSchema,
  investigationPlanSchema,
  investigationProbeSchema,
  investigationStrategySchema,
} from '@kbn/context-engine-plugin/common/investigation_schemas';
import type { FindingsServiceApi } from '@kbn/context-engine-plugin/server/findings/service';
import { CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID } from '../../../../common/agent_builder_tools';
import {
  getRecordInvestigationErrorMessage,
  recordInvestigationHandler,
  type RecordInvestigationParams,
} from './handler';

const MAX_INVESTIGATION_ID_LENGTH = 128;
const MAX_RUN_SUMMARY_ENTRIES = 20;

const investigationIdSchema = z
  .string()
  .min(1)
  .max(MAX_INVESTIGATION_ID_LENGTH)
  .optional()
  .describe(
    'Investigation id. Defaults to the investigation attachment in this conversation; only pass it when several are attached.'
  );

const REQUIRED_PAYLOAD: Record<
  RecordInvestigationParams['action'],
  'findings' | 'decisions' | 'strategy' | 'plan'
> = {
  findings: 'findings',
  decisions: 'decisions',
  strategy: 'strategy',
  plan: 'plan',
};

// Tool schemas must be a plain object, so the action payloads are optional fields checked in a refinement.
const recordInvestigationSchema = z
  .object({
    action: z
      .enum(['findings', 'decisions', 'strategy', 'plan'])
      .describe('Which stage to record. Each action reads the payload field of the same name.'),
    investigationId: investigationIdSchema,
    findings: z
      .array(findingInputSchema)
      .max(MAX_FINDINGS_PER_INVESTIGATION)
      .optional()
      .describe(
        'action "findings": every finding from the catalog checks that fired (observed) or the measured properties that passed the scale gate on a confirmed probe (hypothesized). An empty array is a valid result. Observed findings carry prevalence; hypothesized ones carry scale. `subject` is the pattern the KI would address and must be stable across runs (it is part of the fingerprint).'
      ),
    access_mode: accessModeSchema
      .optional()
      .describe(
        'action "findings": the user\'s answer to the access-mode question: queries, text_only or unknown.'
      ),
    probes: z
      .array(investigationProbeSchema)
      .max(MAX_INVESTIGATION_PROBES)
      .optional()
      .describe('action "findings": the probes the user confirmed (at most 5), with answer paths.'),
    measurements: z
      .array(investigationMeasurementSchema)
      .max(MAX_INVESTIGATION_MEASUREMENTS)
      .optional()
      .describe(
        'action "findings": measured facts that feed the strategy and are never up for dismissal: the six data properties per index, per-probe answer paths, T12 task shapes and T13 touched indices.'
      ),
    run_summary: z
      .record(z.string().max(64), z.number())
      .refine((summary) => Object.keys(summary).length <= MAX_RUN_SUMMARY_ENTRIES, {
        message: `At most ${MAX_RUN_SUMMARY_ENTRIES} entries`,
      })
      .optional()
      .describe(
        'action "findings": coverage numbers for the closing statement, e.g. { checks_run, requests, sampled_from, probes, indices, eligible, rare, not_fired, skipped }.'
      ),
    decisions: z
      .array(findingDecisionInputSchema)
      .min(1)
      .max(MAX_FINDINGS_PER_INVESTIGATION)
      .optional()
      .describe(
        'action "decisions": the user\'s answers, one per finding: dismiss, known_issue, create_ki or create_ki_and_signal (observed findings only), with the free-text reason when given.'
      ),
    strategy: investigationStrategySchema
      .optional()
      .describe(
        'action "strategy": the context strategy the user approved (or edited): shape, families with unit key and unit count, targeted KIs, cost estimate and the rationale citing the measurements or accepted findings.'
      ),
    plan: investigationPlanSchema
      .optional()
      .describe(
        'action "plan": workflow specs per approved family (unit key, foreach shape, freshness cursor, readiness) and targeted KI specs per create_ki decision.'
      ),
  })
  .superRefine((value, ctx) => {
    const required = REQUIRED_PAYLOAD[value.action];
    if (value[required] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [required],
        message: `action "${value.action}" requires the "${required}" field.`,
      });
    }
  });

type RecordInvestigationInput = z.infer<typeof recordInvestigationSchema>;

/** Narrows the flat tool input to the per-action shape the handler works with. */
export const toRecordInvestigationParams = (
  input: RecordInvestigationInput
): RecordInvestigationParams => {
  const { investigationId } = input;
  switch (input.action) {
    case 'findings':
      return {
        action: 'findings',
        investigationId,
        findings: input.findings ?? [],
        access_mode: input.access_mode,
        probes: input.probes,
        measurements: input.measurements,
        run_summary: input.run_summary,
      };
    case 'decisions':
      return { action: 'decisions', investigationId, decisions: input.decisions ?? [] };
    case 'strategy':
      if (!input.strategy) {
        throw new Error('action "strategy" requires the "strategy" field.');
      }
      return { action: 'strategy', investigationId, strategy: input.strategy };
    case 'plan':
      if (!input.plan) {
        throw new Error('action "plan" requires the "plan" field.');
      }
      return { action: 'plan', investigationId, plan: input.plan };
    default: {
      const exhaustive: never = input.action;
      throw new Error(`Unknown action: ${exhaustive}`);
    }
  }
};

export const createRecordInvestigationTool = ({
  getCoreStart,
  getSecurityStart,
  getFindingsService,
}: {
  getCoreStart: () => Promise<CoreStart>;
  getSecurityStart: () => Promise<SecurityPluginStart | undefined>;
  getFindingsService: (esClient: ElasticsearchClient) => Promise<FindingsServiceApi>;
}): BuiltinToolDefinition<typeof recordInvestigationSchema> => ({
  id: CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID,
  type: ToolType.builtin,
  tags: ['context_engine'],
  // Upsert write: persists to the findings store and versions the investigation attachment.
  annotations: {
    title: 'Record investigation stage',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  description: dedent`
    Record one stage of a Context Engine guided investigation and advance the investigation attachment.
    - action "findings": after the catalog checks and measurements. Computes finding ids, marks findings
      that match a prior dismiss / known-issue decision as suppressed (returned with the prior reason),
      applies the prevalence gate (observed) or the scale gate (hypothesized) to set ki_eligible, and
      moves the attachment to findings_recorded. Call it even with zero findings.
    - action "decisions": after the user answered the decision question. Moves to decisions_recorded.
    - action "strategy": after the user approved the context strategy. Moves to strategy_approved.
    - action "plan": after the planner produced workflow and targeted-KI specs. Moves to planned.
    Each action requires the previous stage. The user has just answered the question that produced the
    input, so no confirmation is asked.
  `,
  schema: recordInvestigationSchema,
  confirmation: { askUser: 'never' },
  handler: async (params, { request, spaceId, esClient, attachments, logger }) => {
    try {
      const result = await recordInvestigationHandler({
        params: toRecordInvestigationParams(params),
        request,
        spaceId,
        esClient: esClient.asCurrentUser,
        attachments,
        logger,
        getCoreStart,
        getSecurityStart,
        getFindingsService,
      });
      return { results: [{ type: ToolResultType.other, data: result }] };
    } catch (error) {
      const message = getRecordInvestigationErrorMessage(error);
      logger.error(`Error running ${CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID}: ${message}`, {
        error,
      });
      return {
        results: [
          {
            type: ToolResultType.error,
            data: { message: `Failed to record investigation ${params.action}: ${message}` },
          },
        ],
      };
    }
  },
});
