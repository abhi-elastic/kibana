/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ToolType } from '@kbn/agent-builder-common';
import { ToolResultType } from '@kbn/agent-builder-common/tools/tool_result';
import { createErrorResult, getToolResultId } from '@kbn/agent-builder-server';
import type { BuiltinSkillBoundedTool } from '@kbn/agent-builder-server/skills';
import { buildAgentBuilderTracesIndexPattern } from '@kbn/agent-builder-plugin/common/traces';
import type { ElasticsearchClient } from '@kbn/core/server';
import { z } from '@kbn/zod/v4';
import dedent from 'dedent';
import {
  MAX_INVESTIGATION_TIME_RANGE_LENGTH,
  MAX_INVESTIGATION_TRACE_AGENT_ID_LENGTH,
  MAX_INVESTIGATION_TRACE_ESQL_LENGTH,
} from '@kbn/context-engine-plugin/common/constants';
import { CONTEXT_ENGINE_TRACE_CHECKS_TOOL_ID } from '../../../../../common/agent_builder_tools';
import type { TraceScopeSelector } from './queries';
import {
  DEFAULT_TRACE_CHECKS_PARAMETERS,
  runTraceChecks,
  type EsqlResult,
  type SourceDocument,
  type TraceChecksClient,
} from './run_trace_checks';

const MAX_SAMPLE_CAP = 5000;
const MAX_DETAIL_LIMIT = 60;

export const traceChecksSchema = z.object({
  agent_id: z
    .string()
    .min(1)
    .max(MAX_INVESTIGATION_TRACE_AGENT_ID_LENGTH)
    .optional()
    .describe(
      'Agent id from the investigation attachment trace scope (attributes.gen_ai.agent.id). Required unless custom_esql is given.'
    ),
  from: z
    .string()
    .min(1)
    .max(MAX_INVESTIGATION_TIME_RANGE_LENGTH)
    .optional()
    .describe('Start of the time range, ISO 8601 or date math, from the attachment trace scope.'),
  to: z
    .string()
    .min(1)
    .max(MAX_INVESTIGATION_TIME_RANGE_LENGTH)
    .optional()
    .describe('End of the time range, ISO 8601 or date math, from the attachment trace scope.'),
  custom_esql: z
    .string()
    .min(1)
    .max(MAX_INVESTIGATION_TRACE_ESQL_LENGTH)
    .optional()
    .describe(
      'Custom ES|QL scope from the attachment (FROM <traces index> | WHERE ...), used verbatim instead of agent_id + range. It must keep the standard span fields.'
    ),
  sample_cap: z
    .number()
    .int()
    .min(10)
    .max(MAX_SAMPLE_CAP)
    .optional()
    .describe(
      `Maximum requests to analyse; larger scopes are sampled at request level. Default ${DEFAULT_TRACE_CHECKS_PARAMETERS.sample_cap}. Raise it for a slower, exact run when the user asks.`
    ),
  percentile: z
    .number()
    .min(50)
    .max(99.9)
    .optional()
    .describe(
      `Percentile used in the outlier threshold. Default ${DEFAULT_TRACE_CHECKS_PARAMETERS.percentile}.`
    ),
  mad_multiplier: z
    .number()
    .min(1)
    .max(10)
    .optional()
    .describe(`k in med + k * MAD. Default ${DEFAULT_TRACE_CHECKS_PARAMETERS.mad_multiplier}.`),
  top_tools: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe(
      `How many of the agent's top tools get a tool-level baseline (T4). Default ${DEFAULT_TRACE_CHECKS_PARAMETERS.top_tools}.`
    ),
  prevalence_min_requests: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      `Prevalence floor in requests. Default ${DEFAULT_TRACE_CHECKS_PARAMETERS.prevalence_min_requests}.`
    ),
  prevalence_min_fraction: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      `Prevalence floor as a fraction of sampled requests. Default ${DEFAULT_TRACE_CHECKS_PARAMETERS.prevalence_min_fraction}.`
    ),
  prevalence_min_conversations: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      `Distinct conversations a signature needs. Default ${DEFAULT_TRACE_CHECKS_PARAMETERS.prevalence_min_conversations}.`
    ),
  detail_limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_DETAIL_LIMIT)
    .optional()
    .describe(
      `Requests in the bounded detail set (outliers, cohorts, error exemplars). Default ${DEFAULT_TRACE_CHECKS_PARAMETERS.detail_limit}.`
    ),
});

export type TraceChecksInput = z.infer<typeof traceChecksSchema>;

export const toTraceScopeSelector = (
  input: TraceChecksInput,
  tracesIndex: string
): TraceScopeSelector => {
  if (input.custom_esql) {
    return { kind: 'custom', esql: input.custom_esql };
  }
  if (!input.agent_id || !input.from || !input.to) {
    throw new Error('Provide agent_id, from and to, or a custom_esql scope.');
  }
  return {
    kind: 'agent',
    tracesIndex,
    agentId: input.agent_id,
    range: { from: input.from, to: input.to },
  };
};

const PARAMETER_KEYS = [
  'sample_cap',
  'percentile',
  'mad_multiplier',
  'top_tools',
  'prevalence_min_requests',
  'prevalence_min_fraction',
  'prevalence_min_conversations',
  'detail_limit',
] as const;

const pickParameters = (input: TraceChecksInput) =>
  Object.fromEntries(
    PARAMETER_KEYS.flatMap((key) => (input[key] === undefined ? [] : [[key, input[key]]]))
  );

export const createTraceChecksClient = (esClient: ElasticsearchClient): TraceChecksClient => ({
  esql: async (query) =>
    (await esClient.esql.query({ query, format: 'json' })) as unknown as EsqlResult,
  search: async (body) => {
    const { index, ...rest } = body as { index: string } & Record<string, unknown>;
    const response = await esClient.search<SourceDocument>({ index, ...rest });
    return response.hits.hits.flatMap((hit) => (hit._source ? [hit._source] : []));
  },
});

/**
 * Runs the whole trace check catalog (T1-T13) for the investigation's trace scope in one call so
 * the sampling, threshold and prevalence arithmetic never passes through the model.
 */
export const createTraceChecksTool = (): BuiltinSkillBoundedTool<typeof traceChecksSchema> => ({
  id: CONTEXT_ENGINE_TRACE_CHECKS_TOOL_ID,
  type: ToolType.builtin,
  description: dedent`
    Run the Context Engine trace check catalog (T1-T13) over one agent's requests in the current
    space's Agent Builder traces index: request sample, per-agent baselines, outliers with their
    comparison cohorts, bounded _source detail (tool steps, first user message, final answer when
    privacy flags allow), and prevalence per pattern signature with the KI-eligibility gate.
    Read-only. Pass the scope exactly as it appears in the investigation attachment.
  `,
  schema: traceChecksSchema,
  confirmation: { askUser: 'never' },
  handler: async (input, { esClient, spaceId, logger }) => {
    const tracesIndex = buildAgentBuilderTracesIndexPattern(spaceId);
    try {
      const selector = toTraceScopeSelector(input, tracesIndex);
      const result = await runTraceChecks({
        client: createTraceChecksClient(esClient.asCurrentUser),
        selector,
        fallbackTracesIndex: tracesIndex,
        parameters: pickParameters(input),
      });
      return {
        results: [{ tool_result_id: getToolResultId(), type: ToolResultType.other, data: result }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error running ${CONTEXT_ENGINE_TRACE_CHECKS_TOOL_ID}: ${message}`);
      return {
        results: [createErrorResult({ message: `Trace checks failed: ${message}` })],
      };
    }
  },
});
