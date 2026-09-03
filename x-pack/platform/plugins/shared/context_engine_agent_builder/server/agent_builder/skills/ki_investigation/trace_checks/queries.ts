/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** Agent Builder OTel trace fields the checks rely on. */
export const TRACE_FIELDS = {
  timestamp: '@timestamp',
  traceId: 'trace_id',
  spanId: 'span_id',
  duration: 'duration',
  agentId: 'attributes.gen_ai.agent.id',
  operationName: 'attributes.gen_ai.operation.name',
  spanKind: 'attributes.elastic.inference.span.kind',
  conversationId: 'attributes.gen_ai.conversation.id',
  toolName: 'attributes.gen_ai.tool.name',
  toolCallArguments: 'attributes.gen_ai.tool.call.arguments',
  toolCallResult: 'attributes.gen_ai.tool.call.result',
  requestModel: 'attributes.gen_ai.request.model',
  inputTokens: 'attributes.gen_ai.usage.input_tokens',
  inputMessages: 'attributes.gen_ai.input.messages',
  outputMessages: 'attributes.gen_ai.output.messages',
  statusCode: 'status.code',
  statusMessage: 'status.message',
} as const;

export interface TimeRange {
  from: string;
  to: string;
}

/**
 * How the request set is selected: by agent id (plus range) or by a custom ES|QL scope that
 * already yields spans and keeps the standard span fields.
 */
export type TraceScopeSelector =
  | { kind: 'agent'; tracesIndex: string; agentId: string; range: TimeRange }
  | { kind: 'custom'; esql: string };

export const escapeEsqlString = (value: string): string => value.replace(/(["\\])/g, '\\$1');

const quoted = (value: string): string => `"${escapeEsqlString(value)}"`;

const inList = (values: string[]): string => values.map(quoted).join(', ');

const timeRangeClause = ({ from, to }: TimeRange): string =>
  `${TRACE_FIELDS.timestamp} >= "${from}" AND ${TRACE_FIELDS.timestamp} <= "${to}"`;

/** One user request = one `invoke_agent` CHAIN span. Internal CHAIN spans have a null operation. */
export const REQUEST_SPAN_CLAUSE = `${TRACE_FIELDS.operationName} == "invoke_agent" AND ${TRACE_FIELDS.spanKind} == "CHAIN"`;

const TOOL_SPAN_CLAUSE = `${TRACE_FIELDS.operationName} == "execute_tool"`;
const CHAT_SPAN_CLAUSE = `${TRACE_FIELDS.operationName} == "chat"`;

/** `FROM ... | WHERE <scope>` prefix every request-selection query starts with. */
const scopeSource = (selector: TraceScopeSelector): string => {
  if (selector.kind === 'custom') {
    return selector.esql.trim();
  }
  return [
    `FROM ${selector.tracesIndex}`,
    `| WHERE ${timeRangeClause(selector.range)} AND ${TRACE_FIELDS.agentId} == ${quoted(
      selector.agentId
    )}`,
  ].join('\n');
};

/** Step 1a: how many requests the scope holds, before any sampling. */
export const buildRequestCountQuery = (selector: TraceScopeSelector): string =>
  [scopeSource(selector), `| WHERE ${REQUEST_SPAN_CLAUSE}`, `| STATS n = COUNT(*)`].join('\n');

/**
 * Step 1b: the request sample. Every request when the scope fits under the cap, otherwise a
 * request-level `SAMPLE` slightly over the cap and truncated, so per-request counts stay intact.
 */
export const buildRequestSampleQuery = (
  selector: TraceScopeSelector,
  { totalRequests, cap }: { totalRequests: number; cap: number }
): string => {
  const lines = [scopeSource(selector), `| WHERE ${REQUEST_SPAN_CLAUSE}`];
  if (totalRequests > cap) {
    // Over-sample by 10% so the LIMIT below rarely falls short of the cap.
    const probability = Math.min(1, (cap / totalRequests) * 1.1);
    lines.push(`| SAMPLE ${probability.toFixed(6)}`);
  }
  lines.push(
    `| KEEP ${TRACE_FIELDS.traceId}, ${TRACE_FIELDS.conversationId}, ${TRACE_FIELDS.duration}`,
    `| LIMIT ${cap}`
  );
  return lines.join('\n');
};

/** Every later query is scoped to the sampled requests, never to the whole range. */
const sampledSource = (tracesIndex: string, traceIds: string[]): string =>
  [`FROM ${tracesIndex}`, `| WHERE ${TRACE_FIELDS.traceId} IN (${inList(traceIds)})`].join('\n');

/** Custom scopes carry their own index; the sample keeps the trace ids we then filter on. */
export const resolveTracesIndex = (selector: TraceScopeSelector, fallback: string): string =>
  selector.kind === 'agent' ? selector.tracesIndex : fallback;

/** Requests per conversation with a duration p95, for the multi-turn read of outliers. */
export const buildRequestsPerConversationQuery = (tracesIndex: string, traceIds: string[]) =>
  [
    sampledSource(tracesIndex, traceIds),
    `| WHERE ${REQUEST_SPAN_CLAUSE}`,
    `| STATS n = COUNT(*), p95_seconds = PERCENTILE(${TRACE_FIELDS.duration}, 95) / 1e9 BY ${TRACE_FIELDS.conversationId}`,
    `| SORT n DESC`,
    `| LIMIT 1000`,
  ].join('\n');

/** Tool failures by tool (T1 and the tool-level view). */
export const buildToolFailuresByToolQuery = (tracesIndex: string, traceIds: string[]) =>
  [
    sampledSource(tracesIndex, traceIds),
    `| WHERE ${TOOL_SPAN_CLAUSE}`,
    `| STATS calls = COUNT(*), errors = COUNT(CASE(${TRACE_FIELDS.statusCode} == "Error", 1, NULL)), p95_seconds = PERCENTILE(${TRACE_FIELDS.duration}, 95) / 1e9 BY ${TRACE_FIELDS.toolName}`,
    `| SORT errors DESC, calls DESC`,
    `| LIMIT 100`,
  ].join('\n');

/** Explicit tool errors grouped by (tool, message) so a signature can be classified in code. */
export const buildToolErrorSignaturesQuery = (tracesIndex: string, traceIds: string[]) =>
  [
    sampledSource(tracesIndex, traceIds),
    `| WHERE ${TOOL_SPAN_CLAUSE} AND ${TRACE_FIELDS.statusCode} == "Error"`,
    `| STATS spans = COUNT(*), requests = COUNT_DISTINCT(${TRACE_FIELDS.traceId}), conversations = COUNT_DISTINCT(${TRACE_FIELDS.conversationId}), trace_ids = VALUES(${TRACE_FIELDS.traceId}) BY ${TRACE_FIELDS.toolName}, ${TRACE_FIELDS.statusMessage}`,
    `| SORT requests DESC, spans DESC`,
    `| LIMIT 200`,
  ].join('\n');

/** Model (chat span) errors: connector, SSL, rate limit (T9). */
export const buildModelErrorsQuery = (tracesIndex: string, traceIds: string[]) =>
  [
    sampledSource(tracesIndex, traceIds),
    `| WHERE ${CHAT_SPAN_CLAUSE} AND ${TRACE_FIELDS.statusCode} == "Error"`,
    `| STATS spans = COUNT(*), requests = COUNT_DISTINCT(${TRACE_FIELDS.traceId}), conversations = COUNT_DISTINCT(${TRACE_FIELDS.conversationId}), trace_ids = VALUES(${TRACE_FIELDS.traceId}) BY ${TRACE_FIELDS.requestModel}, ${TRACE_FIELDS.statusMessage}`,
    `| SORT requests DESC`,
    `| LIMIT 100`,
  ].join('\n');

/** Request-level baseline of tool calls per request (nested STATS). */
export const buildRequestBaselineQuery = (
  tracesIndex: string,
  traceIds: string[],
  percentile: number
) =>
  [
    sampledSource(tracesIndex, traceIds),
    `| WHERE ${TOOL_SPAN_CLAUSE}`,
    `| STATS calls = COUNT(*) BY ${TRACE_FIELDS.traceId}`,
    `| STATS n = COUNT(*), med = MEDIAN(calls), mad = MEDIAN_ABSOLUTE_DEVIATION(calls), p90 = PERCENTILE(calls, 90), pN = PERCENTILE(calls, ${percentile}), mean = AVG(calls), sd = STD_DEV(calls)`,
  ].join('\n');

/** Tool-level baseline restricted to the agent's top tools by total calls. */
export const buildToolBaselineQuery = (
  tracesIndex: string,
  traceIds: string[],
  { percentile, topTools }: { percentile: number; topTools: number }
) =>
  [
    sampledSource(tracesIndex, traceIds),
    `| WHERE ${TOOL_SPAN_CLAUSE}`,
    `| STATS calls = COUNT(*) BY ${TRACE_FIELDS.traceId}, ${TRACE_FIELDS.toolName}`,
    `| STATS n = COUNT(*), total = SUM(calls), med = MEDIAN(calls), mad = MEDIAN_ABSOLUTE_DEVIATION(calls), pN = PERCENTILE(calls, ${percentile}), mean = AVG(calls), sd = STD_DEV(calls) BY ${TRACE_FIELDS.toolName}`,
    `| SORT total DESC`,
    `| LIMIT ${topTools}`,
  ].join('\n');

/**
 * Per-request tool profile: call count, tool set and conversation. Feeds T3 (outliers above the
 * request threshold, filtered in code), the cohort selection and the T12 task shapes.
 */
export const buildRequestToolProfileQuery = (
  tracesIndex: string,
  traceIds: string[],
  cap: number
) =>
  [
    sampledSource(tracesIndex, traceIds),
    `| WHERE ${TOOL_SPAN_CLAUSE}`,
    `| STATS calls = COUNT(*), tools = VALUES(${TRACE_FIELDS.toolName}), conversation_id = VALUES(${TRACE_FIELDS.conversationId}) BY ${TRACE_FIELDS.traceId}`,
    `| SORT calls DESC`,
    `| LIMIT ${cap}`,
  ].join('\n');

/** Per-tool repeats above the tool threshold (T4), one query per baseline tool. */
export const buildToolRepeatsQuery = (
  tracesIndex: string,
  traceIds: string[],
  { toolName, threshold }: { toolName: string; threshold: number }
) =>
  [
    sampledSource(tracesIndex, traceIds),
    `| WHERE ${TOOL_SPAN_CLAUSE} AND ${TRACE_FIELDS.toolName} == ${quoted(toolName)}`,
    `| STATS calls = COUNT(*), conversation_id = VALUES(${TRACE_FIELDS.conversationId}) BY ${TRACE_FIELDS.traceId}`,
    `| WHERE calls > ${threshold} AND calls >= 2`,
    `| SORT calls DESC`,
    `| LIMIT 20`,
  ].join('\n');

/** Longest span per request by operation, against the request duration (T7). */
export const buildSpanTimeQuery = (tracesIndex: string, traceIds: string[], cap: number) =>
  [
    sampledSource(tracesIndex, traceIds),
    `| WHERE ${TRACE_FIELDS.operationName} IN ("chat", "execute_tool")`,
    `| STATS total = SUM(${TRACE_FIELDS.duration}), max_span = MAX(${TRACE_FIELDS.duration}) BY ${TRACE_FIELDS.traceId}, ${TRACE_FIELDS.operationName}`,
    `| LIMIT ${cap * 2}`,
  ].join('\n');

/** Input-token growth inside a request and total per request (T8). */
export const buildTokenGrowthQuery = (tracesIndex: string, traceIds: string[], cap: number) =>
  [
    sampledSource(tracesIndex, traceIds),
    `| WHERE ${CHAT_SPAN_CLAUSE}`,
    `| STATS chats = COUNT(*), first_input = MIN(TO_LONG(${TRACE_FIELDS.inputTokens})), last_input = MAX(TO_LONG(${TRACE_FIELDS.inputTokens})), total_input = SUM(TO_LONG(${TRACE_FIELDS.inputTokens})) BY ${TRACE_FIELDS.traceId}`,
    `| SORT total_input DESC`,
    `| LIMIT ${cap}`,
  ].join('\n');

/**
 * `_search` body for the bounded detail set: tool spans and chat spans of the given requests, read
 * from `_source` because arguments, results and messages exceed `ignore_above` and are null in
 * ES|QL. Oldest first so the step list is in execution order.
 */
export const buildDetailSearch = (
  tracesIndex: string,
  traceIds: string[],
  { size }: { size: number }
) => ({
  index: tracesIndex,
  size,
  sort: [{ [TRACE_FIELDS.timestamp]: 'asc' as const }],
  _source: [
    TRACE_FIELDS.timestamp,
    TRACE_FIELDS.traceId,
    TRACE_FIELDS.spanId,
    TRACE_FIELDS.duration,
    TRACE_FIELDS.operationName,
    TRACE_FIELDS.spanKind,
    TRACE_FIELDS.conversationId,
    TRACE_FIELDS.toolName,
    TRACE_FIELDS.toolCallArguments,
    TRACE_FIELDS.toolCallResult,
    TRACE_FIELDS.inputMessages,
    TRACE_FIELDS.outputMessages,
    TRACE_FIELDS.statusCode,
    TRACE_FIELDS.statusMessage,
  ],
  query: {
    bool: {
      filter: [
        { terms: { [TRACE_FIELDS.traceId]: traceIds } },
        { terms: { [TRACE_FIELDS.operationName]: ['execute_tool', 'chat'] } },
      ],
    },
  },
});

/** `_search` body for T13: tool arguments of the sampled requests, most recent first. */
export const buildToolArgumentsSearch = (
  tracesIndex: string,
  traceIds: string[],
  { size }: { size: number }
) => ({
  index: tracesIndex,
  size,
  sort: [{ [TRACE_FIELDS.timestamp]: 'desc' as const }],
  _source: [TRACE_FIELDS.traceId, TRACE_FIELDS.toolName, TRACE_FIELDS.toolCallArguments],
  query: {
    bool: {
      filter: [
        { terms: { [TRACE_FIELDS.traceId]: traceIds } },
        { term: { [TRACE_FIELDS.operationName]: 'execute_tool' } },
      ],
    },
  },
});
