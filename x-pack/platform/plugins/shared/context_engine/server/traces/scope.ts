/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import datemath from '@kbn/datemath';
import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import { isResponseError } from '@kbn/es-errors';
import {
  MAX_TRACE_AGENTS,
  MAX_TRACE_SCOPE_CONVERSATIONS,
  buildAgentBuilderTracesIndexName,
} from '../../common/constants';
import type {
  ListTraceAgentsResponse,
  TraceAgentEntry,
  TraceScopePreviewResponse,
} from '../../common/http_api/investigation_scope';
import { validateEsqlSource } from '../sources/validate_esql_source';

/** Field names of the Agent Builder OTel traces used by the scope queries. */
export const TRACE_FIELDS = {
  timestamp: '@timestamp',
  agentId: 'attributes.gen_ai.agent.id',
  operationName: 'attributes.gen_ai.operation.name',
  spanKind: 'attributes.elastic.inference.span.kind',
  conversationId: 'attributes.gen_ai.conversation.id',
  statusCode: 'status.code',
} as const;

interface EsqlQueryResult {
  columns: Array<{ name: string }>;
  values: unknown[][];
}

interface TimeRange {
  from: string;
  to: string;
}

/** Resolves date math (`now-7d`) or ISO strings to ISO timestamps; throws on garbage. */
export const resolveTimeRange = ({ from, to }: TimeRange): { from: string; to: string } => {
  const fromDate = datemath.parse(from);
  const toDate = datemath.parse(to, { roundUp: true });
  if (!fromDate?.isValid() || !toDate?.isValid()) {
    throw new Error(`Invalid time range: from='${from}' to='${to}'`);
  }
  return { from: fromDate.toISOString(), to: toDate.toISOString() };
};

const escapeEsqlString = (value: string): string => value.replace(/(["\\])/g, '\\$1');

const timeRangeClause = ({ from, to }: TimeRange): string =>
  `${TRACE_FIELDS.timestamp} >= "${from}" AND ${TRACE_FIELDS.timestamp} <= "${to}"`;

const requestSpanClause = `${TRACE_FIELDS.operationName} == "invoke_agent" AND ${TRACE_FIELDS.spanKind} == "CHAIN"`;

/** ES|QL fallback listing agents by request count when `_terms_enum` is unavailable. */
export const buildAgentListEsql = (tracesIndex: string, range: TimeRange): string =>
  [
    `FROM ${tracesIndex}`,
    `| WHERE ${timeRangeClause(range)} AND ${requestSpanClause}`,
    `| STATS requests = COUNT(*) BY ${TRACE_FIELDS.agentId}`,
    `| SORT requests DESC`,
    `| LIMIT ${MAX_TRACE_AGENTS}`,
  ].join('\n');

/** Step 1 of the scope preview: request count and conversation ids for one agent. */
export const buildRequestCountEsql = (
  tracesIndex: string,
  agentId: string,
  range: TimeRange
): string =>
  [
    `FROM ${tracesIndex}`,
    `| WHERE ${timeRangeClause(range)} AND ${requestSpanClause} AND ${
      TRACE_FIELDS.agentId
    } == "${escapeEsqlString(agentId)}"`,
    `| STATS requests = COUNT(*), conversations = VALUES(${TRACE_FIELDS.conversationId})`,
  ].join('\n');

/** Step 2 of the scope preview: tool calls and failures across the agent's conversations. */
export const buildToolCountEsql = (
  tracesIndex: string,
  conversationIds: string[],
  range: TimeRange
): string =>
  [
    `FROM ${tracesIndex}`,
    `| WHERE ${timeRangeClause(range)} AND ${TRACE_FIELDS.operationName} == "execute_tool" AND ${
      TRACE_FIELDS.conversationId
    } IN (${conversationIds.map((id) => `"${escapeEsqlString(id)}"`).join(', ')})`,
    `| STATS tool_calls = COUNT(*), failed_tool_calls = COUNT(CASE(${TRACE_FIELDS.statusCode} == "Error", 1, NULL))`,
  ].join('\n');

/** Counts for a custom ES|QL trace scope; the query must keep the standard span fields. */
export const buildCustomScopeCountEsql = (customEsql: string): string =>
  [
    customEsql.trim(),
    `| STATS requests = COUNT(CASE(${requestSpanClause}, 1, NULL)), conversations = COUNT_DISTINCT(${TRACE_FIELDS.conversationId}), tool_calls = COUNT(CASE(${TRACE_FIELDS.operationName} == "execute_tool", 1, NULL)), failed_tool_calls = COUNT(CASE(${TRACE_FIELDS.operationName} == "execute_tool" AND ${TRACE_FIELDS.statusCode} == "Error", 1, NULL))`,
  ].join('\n');

const runEsql = async (esClient: ElasticsearchClient, query: string): Promise<EsqlQueryResult> =>
  (await esClient.esql.query({ query, format: 'json' })) as unknown as EsqlQueryResult;

const readNumber = (result: EsqlQueryResult, column: string): number => {
  const index = result.columns.findIndex((entry) => entry.name === column);
  const value = index >= 0 ? result.values[0]?.[index] : undefined;
  return typeof value === 'number' ? value : 0;
};

const readStrings = (result: EsqlQueryResult, column: string): string[] => {
  const index = result.columns.findIndex((entry) => entry.name === column);
  const value = index >= 0 ? result.values[0]?.[index] : undefined;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return typeof value === 'string' ? [value] : [];
};

/**
 * Lists the agent ids observed in the space's traces for a time range. `_terms_enum` walks the
 * term dictionary (cost scales with distinct ids, not spans); the ES|QL aggregation is only a
 * fallback for indices where the field is not enumerable.
 */
export const listTraceAgents = async ({
  esClient,
  spaceId,
  range,
  logger,
}: {
  esClient: ElasticsearchClient;
  spaceId: string;
  range: TimeRange;
  logger: Logger;
}): Promise<ListTraceAgentsResponse> => {
  const tracesIndex = buildAgentBuilderTracesIndexName(spaceId);
  const resolved = resolveTimeRange(range);

  try {
    const { terms } = await esClient.termsEnum({
      index: tracesIndex,
      field: TRACE_FIELDS.agentId,
      size: MAX_TRACE_AGENTS,
      index_filter: {
        range: { [TRACE_FIELDS.timestamp]: { gte: resolved.from, lte: resolved.to } },
      },
    });
    return {
      agents: terms.map((agentId): TraceAgentEntry => ({ agent_id: agentId })),
      method: 'terms_enum',
      traces_index: tracesIndex,
    };
  } catch (error) {
    if (isResponseError(error) && error.statusCode === 404) {
      return { agents: [], method: 'terms_enum', traces_index: tracesIndex };
    }
    logger.debug(
      `terms_enum on ${tracesIndex} failed, falling back to ES|QL: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  try {
    const result = await runEsql(esClient, buildAgentListEsql(tracesIndex, resolved));
    const agentIndex = result.columns.findIndex((column) => column.name === TRACE_FIELDS.agentId);
    const requestsIndex = result.columns.findIndex((column) => column.name === 'requests');
    const agents = result.values.flatMap((row): TraceAgentEntry[] => {
      const agentId = row[agentIndex];
      const requests = row[requestsIndex];
      return typeof agentId === 'string'
        ? [{ agent_id: agentId, ...(typeof requests === 'number' ? { requests } : {}) }]
        : [];
    });
    return { agents, method: 'esql', traces_index: tracesIndex };
  } catch (error) {
    if (isResponseError(error) && error.statusCode === 404) {
      return { agents: [], method: 'esql', traces_index: tracesIndex };
    }
    throw error;
  }
};

const emptyPreview = (tracesIndex: string): TraceScopePreviewResponse => ({
  traces_index: tracesIndex,
  requests: 0,
  conversations: 0,
  tool_calls: 0,
  failed_tool_calls: 0,
});

/**
 * Bounded counts for the trace scope panel. `agent.id` only exists on `invoke_agent` spans, so
 * the agent path is two queries: requests plus conversation ids, then tool spans in those
 * conversations. A custom ES|QL scope is validated with `| LIMIT 0` and counted with one `STATS`.
 */
export const previewTraceScope = async ({
  esClient,
  spaceId,
  range,
  agentId,
  esql,
}: {
  esClient: ElasticsearchClient;
  spaceId: string;
  range: TimeRange;
  agentId?: string;
  esql?: string;
}): Promise<TraceScopePreviewResponse> => {
  const tracesIndex = buildAgentBuilderTracesIndexName(spaceId);

  if (esql !== undefined && esql.trim().length > 0) {
    const validation = await validateEsqlSource(esClient, esql);
    if (!validation.valid) {
      return { ...emptyPreview(tracesIndex), errors: validation.errors };
    }
    try {
      const result = await runEsql(esClient, buildCustomScopeCountEsql(esql));
      return {
        traces_index: tracesIndex,
        requests: readNumber(result, 'requests'),
        conversations: readNumber(result, 'conversations'),
        tool_calls: readNumber(result, 'tool_calls'),
        failed_tool_calls: readNumber(result, 'failed_tool_calls'),
      };
    } catch (error) {
      if (isResponseError(error)) {
        return {
          ...emptyPreview(tracesIndex),
          errors: [
            {
              type: 'execution_error',
              message: `The custom scope must keep the standard span fields (${TRACE_FIELDS.operationName}, ${TRACE_FIELDS.spanKind}, ${TRACE_FIELDS.conversationId}, ${TRACE_FIELDS.statusCode}): ${error.message}`,
            },
          ],
        };
      }
      throw error;
    }
  }

  if (agentId === undefined) {
    return emptyPreview(tracesIndex);
  }

  const resolved = resolveTimeRange(range);
  let requestResult: EsqlQueryResult;
  try {
    requestResult = await runEsql(esClient, buildRequestCountEsql(tracesIndex, agentId, resolved));
  } catch (error) {
    if (isResponseError(error) && error.statusCode === 404) {
      return emptyPreview(tracesIndex);
    }
    throw error;
  }

  const requests = readNumber(requestResult, 'requests');
  const conversationIds = readStrings(requestResult, 'conversations').slice(
    0,
    MAX_TRACE_SCOPE_CONVERSATIONS
  );
  if (requests === 0 || conversationIds.length === 0) {
    return { ...emptyPreview(tracesIndex), requests, conversations: conversationIds.length };
  }

  const toolResult = await runEsql(
    esClient,
    buildToolCountEsql(tracesIndex, conversationIds, resolved)
  );
  return {
    traces_index: tracesIndex,
    requests,
    conversations: conversationIds.length,
    tool_calls: readNumber(toolResult, 'tool_calls'),
    failed_tool_calls: readNumber(toolResult, 'failed_tool_calls'),
  };
};
