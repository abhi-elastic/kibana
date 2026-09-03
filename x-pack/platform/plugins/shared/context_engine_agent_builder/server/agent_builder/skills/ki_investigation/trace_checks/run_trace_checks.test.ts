/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { TRACE_FIELDS, type TraceScopeSelector } from './queries';
import {
  buildRequestDetails,
  runTraceChecks,
  selectCohort,
  type EsqlResult,
  type SourceDocument,
  type TraceChecksClient,
} from './run_trace_checks';
import type { RequestDetail, RequestProfile } from './types';

const scope: TraceScopeSelector = {
  kind: 'agent',
  tracesIndex: 'traces-agent_builder.otel-default',
  agentId: 'support-agent',
  range: { from: 'now-7d', to: 'now' },
};

const toEsql = (rows: Array<Record<string, unknown>>): EsqlResult => {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return {
    columns: columns.map((name) => ({ name })),
    values: rows.map((row) => columns.map((name) => row[name] ?? null)),
  };
};

const NANOS = 1e9;
const EXECUTE_ESQL = 'platform.core.execute_esql';
const GET_MAPPING = 'platform.core.get_index_mapping';

type QueryKind =
  | 'count'
  | 'sample'
  | 'per_conversation'
  | 'tool_failures'
  | 'tool_errors'
  | 'model_errors'
  | 'request_baseline'
  | 'tool_baseline'
  | 'profiles'
  | 'tool_repeats'
  | 'span_time'
  | 'tokens';

const classify = (query: string): QueryKind => {
  if (query.includes('KEEP trace_id')) return 'sample';
  if (query.includes('errors = COUNT(CASE')) return 'tool_failures';
  if (query.includes('trace_ids = VALUES') && query.includes(TRACE_FIELDS.requestModel)) {
    return 'model_errors';
  }
  if (query.includes('trace_ids = VALUES')) return 'tool_errors';
  if (query.includes('med = MEDIAN(calls)') && query.includes(`BY ${TRACE_FIELDS.toolName}`)) {
    return 'tool_baseline';
  }
  if (query.includes('med = MEDIAN(calls)')) return 'request_baseline';
  if (query.includes('tools = VALUES')) return 'profiles';
  if (query.includes('WHERE calls >')) return 'tool_repeats';
  if (query.includes('max_span = MAX')) return 'span_time';
  if (query.includes('first_input = MIN')) return 'tokens';
  if (query.includes('p95_seconds = PERCENTILE') && query.includes(TRACE_FIELDS.conversationId)) {
    return 'per_conversation';
  }
  return 'count';
};

interface Fixture {
  count: number;
  sample: Array<Record<string, unknown>>;
  perConversation?: Array<Record<string, unknown>>;
  toolFailures?: Array<Record<string, unknown>>;
  toolErrors?: Array<Record<string, unknown>>;
  modelErrors?: Array<Record<string, unknown>>;
  requestBaseline?: Array<Record<string, unknown>>;
  toolBaseline?: Array<Record<string, unknown>>;
  profiles?: Array<Record<string, unknown>>;
  toolRepeats?: (query: string) => Array<Record<string, unknown>>;
  spanTime?: Array<Record<string, unknown>>;
  tokens?: Array<Record<string, unknown>>;
  detailSpans?: (body: Record<string, unknown>) => SourceDocument[];
}

const createClient = (fixture: Fixture) => {
  const esqlCalls: string[] = [];
  const searchCalls: Array<Record<string, unknown>> = [];
  const client: TraceChecksClient = {
    esql: async (query) => {
      esqlCalls.push(query);
      const kind = classify(query);
      switch (kind) {
        case 'count':
          return toEsql([{ n: fixture.count }]);
        case 'sample':
          return toEsql(fixture.sample);
        case 'per_conversation':
          return toEsql(fixture.perConversation ?? []);
        case 'tool_failures':
          return toEsql(fixture.toolFailures ?? []);
        case 'tool_errors':
          return toEsql(fixture.toolErrors ?? []);
        case 'model_errors':
          return toEsql(fixture.modelErrors ?? []);
        case 'request_baseline':
          return toEsql(fixture.requestBaseline ?? []);
        case 'tool_baseline':
          return toEsql(fixture.toolBaseline ?? []);
        case 'profiles':
          return toEsql(fixture.profiles ?? []);
        case 'tool_repeats':
          return toEsql(fixture.toolRepeats?.(query) ?? []);
        case 'span_time':
          return toEsql(fixture.spanTime ?? []);
        case 'tokens':
          return toEsql(fixture.tokens ?? []);
        default: {
          const exhaustive: never = kind;
          throw new Error(`unexpected query ${exhaustive}`);
        }
      }
    },
    search: async (body) => {
      searchCalls.push(body);
      return fixture.detailSpans?.(body) ?? [];
    },
  };
  return { client, esqlCalls, searchCalls };
};

const requestRow = (traceId: string, conversation: string, seconds: number) => ({
  [TRACE_FIELDS.traceId]: traceId,
  [TRACE_FIELDS.conversationId]: conversation,
  [TRACE_FIELDS.duration]: seconds * NANOS,
});

const toolSpan = ({
  traceId,
  tool,
  args,
  result,
  status = 'Ok',
  message,
  seconds = 1,
}: {
  traceId: string;
  tool: string;
  args?: string;
  result?: string;
  status?: 'Ok' | 'Error';
  message?: string;
  seconds?: number;
}): SourceDocument => ({
  [TRACE_FIELDS.traceId]: traceId,
  [TRACE_FIELDS.operationName]: 'execute_tool',
  [TRACE_FIELDS.toolName]: tool,
  [TRACE_FIELDS.toolCallArguments]: args,
  [TRACE_FIELDS.toolCallResult]: result,
  [TRACE_FIELDS.statusCode]: status,
  [TRACE_FIELDS.statusMessage]: message,
  [TRACE_FIELDS.duration]: seconds * NANOS,
});

const chatSpan = ({
  traceId,
  user,
  assistant,
}: {
  traceId: string;
  user?: string;
  assistant?: string;
}): SourceDocument => ({
  [TRACE_FIELDS.traceId]: traceId,
  [TRACE_FIELDS.operationName]: 'chat',
  [TRACE_FIELDS.inputMessages]: user
    ? JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: user }] }])
    : undefined,
  [TRACE_FIELDS.outputMessages]: assistant
    ? JSON.stringify([
        { role: 'assistant', parts: [{ type: 'text', content: assistant }], finish_reason: 'stop' },
      ])
    : undefined,
});

const esqlArgs = (query: string) => JSON.stringify({ query });

/** Twelve requests, two per conversation; the fixture exercises every check id. */
const twelveRequests = (): Fixture => {
  const sample = Array.from({ length: 12 }, (_, index) =>
    requestRow(`r${index + 1}`, `c${Math.floor(index / 2) + 1}`, index === 7 ? 10 : 2)
  );
  const unknownColumn = 'verification_exception: Unknown column [foo]';
  const spansByTrace: Record<string, SourceDocument[]> = {
    r1: [
      chatSpan({ traceId: 'r1', user: 'Which hosts failed yesterday?' }),
      toolSpan({
        traceId: 'r1',
        tool: EXECUTE_ESQL,
        args: esqlArgs('FROM logs-app | WHERE foo == 1'),
        status: 'Error',
        message: unknownColumn,
      }),
      chatSpan({ traceId: 'r1', assistant: 'I was unable to find failing hosts.' }),
    ],
    r2: [
      chatSpan({ traceId: 'r2', user: 'Which services failed?' }),
      toolSpan({
        traceId: 'r2',
        tool: EXECUTE_ESQL,
        args: esqlArgs('FROM logs-app | WHERE foo == 2'),
        status: 'Error',
        message: unknownColumn,
      }),
      chatSpan({ traceId: 'r2', assistant: "I couldn't find that information." }),
    ],
    r3: [
      toolSpan({
        traceId: 'r3',
        tool: EXECUTE_ESQL,
        args: esqlArgs('FROM logs-app | WHERE foo == 3'),
        status: 'Error',
        message: unknownColumn,
      }),
      chatSpan({ traceId: 'r3', assistant: 'Here is the answer.' }),
    ],
    r6: [
      chatSpan({ traceId: 'r6', user: 'Show me errors for host a' }),
      toolSpan({ traceId: 'r6', tool: GET_MAPPING, args: JSON.stringify({ index: 'logs-app' }) }),
      ...[1, 2, 3, 4, 5].map((step) =>
        toolSpan({
          traceId: 'r6',
          tool: EXECUTE_ESQL,
          args: esqlArgs(`FROM logs-app | WHERE host.name == "a${step}"`),
          result:
            step === 2
              ? '[{"type":"error","message":"partial"},{"type":"esql_results","values":[[1]]}]'
              : '{"type":"esql_results","values":[[1]]}',
        })
      ),
      toolSpan({
        traceId: 'r6',
        tool: EXECUTE_ESQL,
        args: esqlArgs('FROM logs-app | WHERE host.name == "a6"'),
        result: '{"type":"esql_results","values":[]}',
      }),
      chatSpan({ traceId: 'r6', assistant: 'Host a had 3 errors.' }),
    ],
    r7: [
      chatSpan({ traceId: 'r7', user: 'Show me errors for host b' }),
      toolSpan({ traceId: 'r7', tool: GET_MAPPING, args: JSON.stringify({ index: 'logs-app' }) }),
      toolSpan({
        traceId: 'r7',
        tool: EXECUTE_ESQL,
        args: esqlArgs('FROM logs-app | WHERE host.name == "b"'),
        result: '{"type":"esql_results","values":[[2]]}',
      }),
      chatSpan({ traceId: 'r7', assistant: 'Host b had 2 errors.' }),
    ],
  };
  const otherRequests = ['r4', 'r5', 'r8', 'r9', 'r10', 'r11', 'r12'];
  for (const traceId of otherRequests) {
    spansByTrace[traceId] = [
      toolSpan({
        traceId,
        tool: EXECUTE_ESQL,
        args: esqlArgs('FROM metrics-host | STATS c = COUNT()'),
        result: '{"type":"esql_results","values":[[9]]}',
      }),
      chatSpan({ traceId, assistant: 'Done.' }),
    ];
  }

  return {
    count: 12,
    sample,
    perConversation: Array.from({ length: 6 }, (_, index) => ({
      [TRACE_FIELDS.conversationId]: `c${index + 1}`,
      n: 2,
      p95_seconds: 2,
    })),
    toolFailures: [
      { [TRACE_FIELDS.toolName]: EXECUTE_ESQL, calls: 20, errors: 3, p95_seconds: 1.5 },
      { [TRACE_FIELDS.toolName]: GET_MAPPING, calls: 2, errors: 0, p95_seconds: 0.2 },
    ],
    toolErrors: [
      {
        [TRACE_FIELDS.toolName]: EXECUTE_ESQL,
        [TRACE_FIELDS.statusMessage]: unknownColumn,
        spans: 3,
        requests: 3,
        conversations: 2,
        trace_ids: ['r1', 'r2', 'r3'],
      },
    ],
    modelErrors: [
      {
        [TRACE_FIELDS.requestModel]: 'gpt-x',
        [TRACE_FIELDS.statusMessage]: 'connector error: SSL',
        spans: 1,
        requests: 1,
        conversations: 1,
        trace_ids: 'r5',
      },
    ],
    requestBaseline: [{ n: 12, med: 2, mad: 0, pN: 6, mean: 2.5, sd: 1.5 }],
    toolBaseline: [
      {
        [TRACE_FIELDS.toolName]: EXECUTE_ESQL,
        n: 12,
        total: 20,
        med: 1,
        mad: 0,
        pN: 5,
        mean: 1.6,
        sd: 1.4,
      },
    ],
    profiles: [
      {
        [TRACE_FIELDS.traceId]: 'r6',
        calls: 7,
        tools: [EXECUTE_ESQL, GET_MAPPING],
        conversation_id: 'c3',
      },
      {
        [TRACE_FIELDS.traceId]: 'r7',
        calls: 2,
        tools: [GET_MAPPING, EXECUTE_ESQL],
        conversation_id: 'c4',
      },
      ...['r1', 'r2', 'r3', 'r4', 'r5', 'r8', 'r9', 'r10', 'r11', 'r12'].map((traceId, index) => ({
        [TRACE_FIELDS.traceId]: traceId,
        calls: 1,
        tools: EXECUTE_ESQL,
        conversation_id: `c${Math.floor(index / 2) + 1}`,
      })),
    ],
    toolRepeats: (query) =>
      query.includes(EXECUTE_ESQL)
        ? [{ [TRACE_FIELDS.traceId]: 'r6', calls: 6, conversation_id: 'c3' }]
        : [],
    spanTime: [
      {
        [TRACE_FIELDS.traceId]: 'r8',
        [TRACE_FIELDS.operationName]: 'chat',
        total: 8 * NANOS,
        max_span: 8 * NANOS,
      },
      {
        [TRACE_FIELDS.traceId]: 'r8',
        [TRACE_FIELDS.operationName]: 'execute_tool',
        total: 1 * NANOS,
        max_span: 1 * NANOS,
      },
      {
        [TRACE_FIELDS.traceId]: 'r6',
        [TRACE_FIELDS.operationName]: 'execute_tool',
        total: 0.8 * NANOS,
        max_span: 0.3 * NANOS,
      },
    ],
    tokens: [
      {
        [TRACE_FIELDS.traceId]: 'r9',
        chats: 4,
        first_input: 1000,
        last_input: 5000,
        total_input: 12000,
      },
      {
        [TRACE_FIELDS.traceId]: 'r6',
        chats: 8,
        first_input: 1000,
        last_input: 2500,
        total_input: 14000,
      },
      {
        [TRACE_FIELDS.traceId]: 'r1',
        chats: 2,
        first_input: 900,
        last_input: 1100,
        total_input: 2000,
      },
    ],
    detailSpans: (body) => {
      const filter = (body.query as { bool: { filter: Array<Record<string, unknown>> } }).bool
        .filter;
      const ids = (filter[0] as { terms: { trace_id: string[] } }).terms.trace_id;
      return ids.flatMap((traceId) => spansByTrace[traceId] ?? []);
    },
  };
};

describe('runTraceChecks', () => {
  it('reports every check id in catalog order with sample, privacy and coverage', async () => {
    const { client } = createClient(twelveRequests());
    const result = await runTraceChecks({ client, selector: scope, fallbackTracesIndex: 'x' });

    expect(result.checks.map((check) => check.check_id)).toEqual([
      'T1',
      'T2',
      'T3',
      'T4',
      'T5',
      'T6',
      'T7',
      'T8',
      'T9',
      'T10',
      'T11',
      'T12',
      'T13',
    ]);
    expect(result.sample).toEqual({
      total_requests: 12,
      sampled_requests: 12,
      sampling_fraction: 1,
      distinct_conversations: 6,
      band: 'limited',
    });
    expect(result.privacy).toEqual({ tool_details: true, llm_responses: true, user_prompts: true });
    expect(result.coverage.ran + result.coverage.skipped).toBe(13);
    expect(result.traces_index).toBe(scope.tracesIndex);
  });

  it('classifies explicit tool errors as unsupported operations with prevalence over the sample', async () => {
    const { client } = createClient(twelveRequests());
    const result = await runTraceChecks({ client, selector: scope, fallbackTracesIndex: 'x' });

    const t10 = result.checks.find((check) => check.check_id === 'T10');
    expect(t10?.status).toBe('fired');
    expect(t10?.signatures).toHaveLength(1);
    expect(t10?.signatures[0]).toMatchObject({
      kind: 'unsupported_operation',
      confidence_cap: 'confirmed',
      counted_over: 'sample',
      ki_eligible: true,
      prevalence: {
        affected_requests: 3,
        sampled_requests: 12,
        affected_fraction: 0.25,
        distinct_conversations: 2,
      },
      sample_trace_ids: ['r1', 'r2', 'r3'],
    });
    expect(t10?.signatures[0].signature).toContain('platform.core.execute_esql|');

    const t1 = result.checks.find((check) => check.check_id === 'T1');
    expect(t1?.status).toBe('not_fired');
    expect(t1?.counts).toMatchObject({ tool_calls: 22, tool_errors: 3 });
  });

  it('reports model errors as system errors that are never KI-eligible', async () => {
    const { client } = createClient(twelveRequests());
    const result = await runTraceChecks({ client, selector: scope, fallbackTracesIndex: 'x' });

    const t9 = result.checks.find((check) => check.check_id === 'T9');
    expect(t9?.status).toBe('fired');
    expect(t9?.signatures[0]).toMatchObject({
      kind: 'system_error',
      ki_eligible: false,
      signature: expect.stringContaining('model:gpt-x|'),
      sample_trace_ids: ['r5'],
    });
  });

  it('computes request and tool baselines with the MAD-is-zero fallback and picks cohorts', async () => {
    const { client } = createClient(twelveRequests());
    const result = await runTraceChecks({ client, selector: scope, fallbackTracesIndex: 'x' });

    expect(result.baselines.request).toMatchObject({
      n: 12,
      med: 2,
      mad: 0,
      threshold: 4,
      rule: 'median_plus_2',
      band: 'limited',
    });
    const t3 = result.checks.find((check) => check.check_id === 'T3');
    expect(t3?.status).toBe('fired');
    expect(t3?.threshold).toContain('calls > 4.0 (median_plus_2');
    expect(t3?.counts).toMatchObject({ outlier_requests: 1 });

    const heavy = result.outliers.find((outlier) => outlier.check_id === 'T3');
    expect(heavy).toMatchObject({
      trace_id: 'r6',
      calls: 7,
      signature: `${EXECUTE_ESQL},${GET_MAPPING}`,
      cohort_trace_ids: ['r7'],
      cohort_rule: 'same_signature_at_or_below_median',
    });

    expect(result.baselines.tools).toEqual([
      expect.objectContaining({ tool: EXECUTE_ESQL, threshold: 3, rule: 'median_plus_2' }),
    ]);
    const t4 = result.checks.find((check) => check.check_id === 'T4');
    expect(t4?.status).toBe('fired');
    expect(t4?.signatures[0]).toMatchObject({
      signature: `repeat:${EXECUTE_ESQL}`,
      kind: 'loop',
      confidence_cap: 'suggestive',
      ki_eligible: false,
      prevalence: { affected_requests: 1, distinct_conversations: 1 },
    });
    expect(result.outliers.filter((outlier) => outlier.check_id === 'T4')).toEqual([
      expect.objectContaining({ trace_id: 'r6', tool: EXECUTE_ESQL, calls: 6 }),
    ]);
  });

  it('fires latency and token checks from the span-time and token rows', async () => {
    const { client } = createClient(twelveRequests());
    const result = await runTraceChecks({ client, selector: scope, fallbackTracesIndex: 'x' });

    const t7 = result.checks.find((check) => check.check_id === 'T7');
    expect(t7?.status).toBe('fired');
    expect(t7?.signatures).toEqual([
      expect.objectContaining({
        signature: 'latency:model_dominated',
        kind: 'timeout_or_latency',
        sample_trace_ids: ['r8'],
      }),
    ]);

    const t8 = result.checks.find((check) => check.check_id === 'T8');
    expect(t8?.status).toBe('fired');
    // r9 grows 5x across 4 chats; r6 only 2.5x; the p99 rule is off in the limited band.
    expect(t8?.signatures[0].sample_trace_ids).toEqual(['r9']);
  });

  it('builds the bounded detail set, extracts partial errors and empty retrievals, and widens content signatures', async () => {
    const { client, searchCalls } = createClient(twelveRequests());
    const result = await runTraceChecks({ client, selector: scope, fallbackTracesIndex: 'x' });

    // Outlier + three error exemplars + one cohort request.
    const detailIds = result.detail.map((detail) => detail.trace_id).sort();
    expect(detailIds).toEqual(['r1', 'r2', 'r3', 'r6', 'r7']);
    const outlier = result.detail.find((detail) => detail.trace_id === 'r6') as RequestDetail;
    expect(outlier.role).toBe('outlier');
    expect(outlier.steps).toHaveLength(7);
    expect(outlier.steps[0]).toMatchObject({
      step: 1,
      tool: GET_MAPPING,
      digest: `${GET_MAPPING} targets=logs-app`,
    });
    expect(outlier.steps[2]).toMatchObject({ partial_error: true, status: 'Ok' });
    expect(outlier.steps[6]).toMatchObject({ empty_result: true });
    expect(outlier.first_user_message).toBe('Show me errors for host a');
    expect(outlier.final_assistant_message).toBe('Host a had 3 errors.');
    expect(result.detail.find((detail) => detail.trace_id === 'r7')?.role).toBe('cohort');
    expect(result.detail.find((detail) => detail.trace_id === 'r1')).toMatchObject({
      role: 'error',
      soft_failure: true,
    });

    // The soft-failure signature appeared in 2 requests, so the content counts were widened.
    expect(searchCalls).toHaveLength(3);
    const widenedIds = (
      searchCalls[1].query as { bool: { filter: Array<{ terms: { trace_id: string[] } }> } }
    ).bool.filter[0].terms.trace_id;
    expect(widenedIds).toHaveLength(12);

    const t6 = result.checks.find((check) => check.check_id === 'T6');
    expect(t6?.status).toBe('fired');
    expect(t6?.signatures[0]).toMatchObject({
      kind: 'soft_failure',
      signature: `soft_failure:${EXECUTE_ESQL}`,
      counted_over: 'sample',
      prevalence: { affected_requests: 2, sampled_requests: 12, distinct_conversations: 1 },
      ki_eligible: false,
    });

    const t2 = result.checks.find((check) => check.check_id === 'T2');
    expect(t2?.status).toBe('not_fired');
    expect(t2?.signatures[0]).toMatchObject({
      kind: 'partial_tool_error',
      prevalence: { affected_requests: 1 },
    });

    const t5 = result.checks.find((check) => check.check_id === 'T5');
    expect(t5?.status).toBe('fired');
    expect(t5?.signatures[0]).toMatchObject({
      kind: 'empty_retrieval',
      signature: 'empty_retrieval:logs-app',
      sample_trace_ids: ['r6'],
    });
  });

  it('provides the protocol input, task shapes and touched indices as positive signals', async () => {
    const { client } = createClient(twelveRequests());
    const result = await runTraceChecks({ client, selector: scope, fallbackTracesIndex: 'x' });

    const t11 = result.checks.find((check) => check.check_id === 'T11');
    expect(t11?.status).toBe('provided');
    expect(t11?.counts).toMatchObject({ outliers: 2, detail_requests: 5 });

    const t12 = result.checks.find((check) => check.check_id === 'T12');
    expect(t12?.status).toBe('provided');
    const shapes = JSON.parse(t12?.note ?? '[]');
    expect(shapes[0]).toMatchObject({ signature: EXECUTE_ESQL, requests: 10, med_calls: 1 });
    expect(shapes[1]).toMatchObject({
      signature: `${EXECUTE_ESQL},${GET_MAPPING}`,
      requests: 2,
      example_user_message: 'Show me errors for host a',
    });

    const t13 = result.checks.find((check) => check.check_id === 'T13');
    expect(t13?.status).toBe('provided');
    const touched = JSON.parse(t13?.note ?? '[]');
    expect(touched).toEqual([
      { index: 'metrics-host', requests: 7, share: 0.583 },
      { index: 'logs-app', requests: 5, share: 0.417 },
    ]);
  });

  it('samples above the cap, scopes later queries by the sampled ids and labels the fraction', async () => {
    const fixture = twelveRequests();
    fixture.count = 3000;
    const { client, esqlCalls } = createClient(fixture);
    const result = await runTraceChecks({
      client,
      selector: scope,
      fallbackTracesIndex: 'x',
      parameters: { sample_cap: 10 },
    });

    expect(esqlCalls[1]).toContain('| SAMPLE 0.003667');
    expect(esqlCalls[1]).toContain('| LIMIT 10');
    expect(result.sample.total_requests).toBe(3000);
    expect(result.sample.sampled_requests).toBe(12);
    expect(result.sample.sampling_fraction).toBe(0.004);
    expect(result.parameters.sample_cap).toBe(10);
    for (const query of esqlCalls.slice(2)) {
      expect(query).toContain('WHERE trace_id IN ("r1", "r2", "r3"');
    }
  });

  it('honours prevalence and threshold overrides', async () => {
    const { client } = createClient(twelveRequests());
    const result = await runTraceChecks({
      client,
      selector: scope,
      fallbackTracesIndex: 'x',
      parameters: {
        prevalence_min_requests: 1,
        prevalence_min_conversations: 1,
        mad_multiplier: 1,
      },
    });
    const t4 = result.checks.find((check) => check.check_id === 'T4');
    expect(t4?.signatures[0].ki_eligible).toBe(true);
    expect(t4?.threshold).toContain('med + 1 * mad');
  });

  it('marks outlier checks insufficient under 10 requests', async () => {
    const fixture = twelveRequests();
    fixture.count = 5;
    fixture.sample = fixture.sample.slice(0, 5);
    fixture.requestBaseline = [{ n: 5, med: 1, mad: 0, pN: 1, mean: 1, sd: 0 }];
    const { client } = createClient(fixture);
    const result = await runTraceChecks({ client, selector: scope, fallbackTracesIndex: 'x' });

    expect(result.sample.band).toBe('insufficient');
    expect(result.checks.find((check) => check.check_id === 'T3')?.status).toBe('insufficient');
    expect(result.checks.find((check) => check.check_id === 'T4')?.status).toBe('insufficient');
    expect(result.baselines.request).toBeUndefined();
    expect(result.coverage.insufficient).toBe(2);
  });

  it('skips content checks when the privacy flags left no content in the traces', async () => {
    const fixture = twelveRequests();
    fixture.detailSpans = (body) => {
      const filter = (body.query as { bool: { filter: Array<Record<string, unknown>> } }).bool
        .filter;
      const ids = (filter[0] as { terms: { trace_id: string[] } }).terms.trace_id;
      return ids.map((traceId) => toolSpan({ traceId, tool: EXECUTE_ESQL }));
    };
    const { client } = createClient(fixture);
    const result = await runTraceChecks({ client, selector: scope, fallbackTracesIndex: 'x' });

    expect(result.privacy).toEqual({
      tool_details: false,
      llm_responses: false,
      user_prompts: false,
    });
    for (const checkId of ['T2', 'T5', 'T6', 'T13'] as const) {
      const check = result.checks.find((entry) => entry.check_id === checkId);
      expect(check?.status).toBe('skipped');
      expect(check?.note).toContain('skipped');
    }
  });

  it('returns an all-skipped run for an empty cohort', async () => {
    const { client, esqlCalls } = createClient({ count: 0, sample: [] });
    const result = await runTraceChecks({ client, selector: scope, fallbackTracesIndex: 'x' });

    expect(esqlCalls).toHaveLength(1);
    expect(result.checks).toHaveLength(13);
    expect(result.checks.every((check) => check.status === 'skipped')).toBe(true);
    expect(result.coverage).toEqual({
      ran: 0,
      fired: 0,
      not_fired: 0,
      skipped: 13,
      insufficient: 0,
    });
  });
});

describe('selectCohort', () => {
  const profiles: RequestProfile[] = [
    { trace_id: 'o', conversation_id: 'c1', calls: 9, tools: ['a', 'b'], signature: 'a,b' },
    { trace_id: 'p1', conversation_id: 'c2', calls: 2, tools: ['a', 'b'], signature: 'a,b' },
    { trace_id: 'p2', conversation_id: 'c1', calls: 3, tools: ['a', 'b'], signature: 'a,b' },
    { trace_id: 'p3', conversation_id: 'c3', calls: 5, tools: ['a', 'b'], signature: 'a,b' },
    { trace_id: 'q1', conversation_id: 'c4', calls: 3, tools: ['a'], signature: 'a' },
    { trace_id: 'q2', conversation_id: 'c5', calls: 1, tools: ['a'], signature: 'a' },
  ];

  it('prefers same-signature requests at or below the median, same conversation first', () => {
    expect(
      selectCohort({ trace_id: 'o', conversation_id: 'c1', signature: 'a,b' }, profiles, 3)
    ).toEqual({ traceIds: ['p2', 'p1'], rule: 'same_signature_at_or_below_median' });
  });

  it('falls back to the dominant tool at the median count', () => {
    expect(
      selectCohort(
        { trace_id: 'o', conversation_id: 'c1', signature: 'a,z', tool: 'a' },
        profiles,
        3
      )
    ).toEqual({ traceIds: ['p2', 'q1', 'p1'], rule: 'dominant_tool_at_median' });
  });

  it('returns an empty cohort when nothing matches', () => {
    expect(selectCohort({ trace_id: 'o', signature: 'zzz' }, profiles, 3)).toEqual({
      traceIds: [],
      rule: 'none',
    });
  });
});

describe('buildRequestDetails', () => {
  it('reads nested _source documents as well as flattened ones', () => {
    const nested: SourceDocument = {
      trace_id: 't1',
      attributes: {
        gen_ai: {
          operation: { name: 'execute_tool' },
          tool: { name: 'search', call: { arguments: '{"index":"docs"}', result: '{"hits":[]}' } },
        },
      },
      status: { code: 'Ok' },
      duration: 2.5 * NANOS,
    };
    const { details, privacy } = buildRequestDetails(
      [nested],
      new Map([['t1', 'error']]),
      new Map()
    );
    expect(details[0]).toMatchObject({ trace_id: 't1', role: 'error' });
    expect(details[0].steps[0]).toMatchObject({
      tool: 'search',
      digest: 'search targets=docs',
      empty_result: true,
      duration_seconds: 2.5,
    });
    expect(privacy.tool_details).toBe(true);
  });
});
