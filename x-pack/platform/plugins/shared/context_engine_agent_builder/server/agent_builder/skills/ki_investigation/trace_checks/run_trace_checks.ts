/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { FindingKind } from '@kbn/context-engine-plugin/common/http_api/findings';
import {
  argumentDigest,
  assistantOutput,
  buildPrevalence,
  computeThreshold,
  errorClass,
  firstUserMessage,
  hasPartialError,
  isEmptyRetrieval,
  isSoftFailure,
  isUnsupportedOperation,
  median,
  parseTargetIndices,
  passesPrevalenceGate,
  percentile,
  sampleBand,
  toolSignature,
  type BaselineRow,
  type BaselineThreshold,
  type Prevalence,
  type PrevalenceThresholds,
} from './analysis';
import {
  TRACE_FIELDS,
  buildDetailSearch,
  buildModelErrorsQuery,
  buildRequestBaselineQuery,
  buildRequestCountQuery,
  buildRequestSampleQuery,
  buildRequestToolProfileQuery,
  buildRequestsPerConversationQuery,
  buildSpanTimeQuery,
  buildTokenGrowthQuery,
  buildToolArgumentsSearch,
  buildToolBaselineQuery,
  buildToolErrorSignaturesQuery,
  buildToolFailuresByToolQuery,
  buildToolRepeatsQuery,
  resolveTracesIndex,
  type TraceScopeSelector,
} from './queries';
import type {
  CheckRow,
  CheckSignature,
  ConfidenceCap,
  Outlier,
  PrivacyFlags,
  RequestDetail,
  RequestProfile,
  RequestStep,
  TraceChecksParameters,
  TraceChecksResult,
} from './types';

export interface EsqlResult {
  columns: Array<{ name: string }>;
  values: unknown[][];
}

export type SourceDocument = Record<string, unknown>;

/** The two reads the checks need, injectable so the orchestration is testable against fixtures. */
export interface TraceChecksClient {
  esql: (query: string) => Promise<EsqlResult>;
  search: (body: Record<string, unknown>) => Promise<SourceDocument[]>;
}

export const DEFAULT_TRACE_CHECKS_PARAMETERS: TraceChecksParameters = {
  sample_cap: 1000,
  percentile: 95,
  mad_multiplier: 3,
  top_tools: 5,
  prevalence_min_requests: 3,
  prevalence_min_fraction: 0.05,
  prevalence_min_conversations: 2,
  detail_limit: 20,
  token_growth_factor: 3,
};

const DETAIL_SPAN_CAP = 2000;
const WIDENED_SPAN_CAP = 3000;
const T13_SPAN_CAP = 2000;
const MAX_SAMPLE_TRACE_IDS = 5;
const MAX_TASK_SHAPES = 10;
const MAX_TOUCHED_INDICES = 10;
const NANOS_PER_SECOND = 1e9;

const CHECK_NAMES: Record<CheckRow['check_id'], string> = {
  T1: 'tool_error',
  T2: 'partial_tool_error',
  T3: 'tool_heavy_request',
  T4: 'loop / discovery_loop',
  T5: 'empty_retrieval',
  T6: 'soft_failure',
  T7: 'timeout_or_latency',
  T8: 'token_runaway',
  T9: 'system_error',
  T10: 'unsupported_operation',
  T11: 'comparison_protocol_input',
  T12: 'recurring_task_shapes',
  T13: 'most_touched_indices',
};

const rowsToObjects = (result: EsqlResult): Array<Record<string, unknown>> =>
  result.values.map((row) =>
    Object.fromEntries(result.columns.map((column, index) => [column.name, row[index]]))
  );

const asNumber = (value: unknown): number => (typeof value === 'number' ? value : 0);
const asString = (value: unknown): string | undefined =>
  typeof value === 'string'
    ? value
    : Array.isArray(value) && typeof value[0] === 'string'
    ? value[0]
    : undefined;
const asStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : typeof value === 'string'
    ? [value]
    : [];

/** Reads a dotted field from `_source`, whether stored flattened (`subobjects: false`) or nested. */
export const readSourceField = (source: SourceDocument, path: string): unknown => {
  if (path in source) {
    return source[path];
  }
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current && typeof current === 'object' && segment in (current as SourceDocument)) {
      return (current as SourceDocument)[segment];
    }
    return undefined;
  }, source);
};

const sourceString = (source: SourceDocument, path: string): string | undefined =>
  asString(readSourceField(source, path));

const uniqueCount = (values: Array<string | undefined>): number =>
  new Set(values.filter((value): value is string => value !== undefined)).size;

interface SampleRow {
  trace_id: string;
  conversation_id?: string;
  duration_seconds: number;
}

interface RunState {
  parameters: TraceChecksParameters;
  thresholds: PrevalenceThresholds;
  sample: SampleRow[];
  traceIds: string[];
  conversationOf: Map<string, string | undefined>;
}

const signatureFor = (
  state: RunState,
  {
    signature,
    kind,
    traceIds,
    countedOver,
    sampledRequests,
    confidenceCap,
    details,
  }: {
    signature: string;
    kind: FindingKind;
    traceIds: string[];
    countedOver: CheckSignature['counted_over'];
    sampledRequests: number;
    confidenceCap: ConfidenceCap;
    details?: Record<string, unknown>;
  }
): CheckSignature => {
  const unique = [...new Set(traceIds)];
  const prevalence: Prevalence = buildPrevalence(
    unique.length,
    sampledRequests,
    uniqueCount(unique.map((traceId) => state.conversationOf.get(traceId)))
  );
  return {
    signature,
    kind,
    prevalence,
    counted_over: countedOver,
    ki_eligible:
      kind === 'system_error' ? false : passesPrevalenceGate(prevalence, state.thresholds),
    confidence_cap: confidenceCap,
    sample_trace_ids: unique.slice(0, MAX_SAMPLE_TRACE_IDS),
    details: details ?? {},
  };
};

const row = (
  checkId: CheckRow['check_id'],
  status: CheckRow['status'],
  extra: Partial<Omit<CheckRow, 'check_id' | 'name' | 'status'>> = {}
): CheckRow => ({
  check_id: checkId,
  name: CHECK_NAMES[checkId],
  status,
  counts: extra.counts ?? {},
  signatures: extra.signatures ?? [],
  ...(extra.threshold ? { threshold: extra.threshold } : {}),
  ...(extra.note ? { note: extra.note } : {}),
});

const skippedRun = (
  selector: TraceScopeSelector,
  tracesIndex: string,
  parameters: TraceChecksParameters,
  reason: string,
  totalRequests: number
): TraceChecksResult => {
  const checks = (Object.keys(CHECK_NAMES) as Array<CheckRow['check_id']>).map((checkId) =>
    row(checkId, 'skipped', { note: reason })
  );
  return {
    traces_index: tracesIndex,
    scope: selector,
    parameters,
    sample: {
      total_requests: totalRequests,
      sampled_requests: 0,
      sampling_fraction: 0,
      distinct_conversations: 0,
      band: sampleBand(0),
    },
    privacy: { tool_details: false, llm_responses: false, user_prompts: false },
    baselines: { tools: [] },
    checks,
    outliers: [],
    detail: [],
    coverage: { ran: 0, fired: 0, not_fired: 0, skipped: checks.length, insufficient: 0 },
  };
};

const readBaseline = (record: Record<string, unknown>): BaselineRow => ({
  n: asNumber(record.n),
  med: asNumber(record.med),
  mad: asNumber(record.mad),
  pN: asNumber(record.pN),
  mean: asNumber(record.mean),
  sd: asNumber(record.sd),
});

const thresholdLabel = (threshold: BaselineThreshold, baseline: BaselineRow): string =>
  `calls > ${threshold.threshold.toFixed(1)} (${threshold.rule}; med ${baseline.med}, mad ${
    baseline.mad
  }, pN ${baseline.pN}, n ${baseline.n}, band ${threshold.band})`;

/**
 * Deterministic comparison cohort: up to 3 requests with the same tool signature at or below the
 * median call count, preferring the outlier's conversation; otherwise 3 requests at the median
 * count for the dominant tool.
 */
export const selectCohort = (
  outlier: Pick<Outlier, 'trace_id' | 'conversation_id' | 'signature' | 'tool'>,
  profiles: RequestProfile[],
  medianCalls: number
): { traceIds: string[]; rule: Outlier['cohort_rule'] } => {
  const others = profiles.filter((profile) => profile.trace_id !== outlier.trace_id);
  const sameSignature = others
    .filter((profile) => profile.signature === outlier.signature && profile.calls <= medianCalls)
    .sort((left, right) => {
      const leftSame = left.conversation_id === outlier.conversation_id ? 0 : 1;
      const rightSame = right.conversation_id === outlier.conversation_id ? 0 : 1;
      return leftSame - rightSame || left.calls - right.calls;
    });
  if (sameSignature.length > 0) {
    return {
      traceIds: sameSignature.slice(0, 3).map((profile) => profile.trace_id),
      rule: 'same_signature_at_or_below_median',
    };
  }
  const dominantTool = outlier.tool ?? outlier.signature.split(',')[0];
  const atMedian = others
    .filter((profile) => dominantTool !== undefined && profile.tools.includes(dominantTool))
    .sort(
      (left, right) =>
        Math.abs(left.calls - medianCalls) - Math.abs(right.calls - medianCalls) ||
        left.calls - right.calls
    );
  if (atMedian.length > 0) {
    return {
      traceIds: atMedian.slice(0, 3).map((profile) => profile.trace_id),
      rule: 'dominant_tool_at_median',
    };
  }
  return { traceIds: [], rule: 'none' };
};

const statusFrom = (value: unknown): RequestStep['status'] =>
  value === 'Error' ? 'Error' : value === 'Ok' ? 'Ok' : 'Unset';

/** Groups detail spans into per-request step lists plus the final assistant message. */
export const buildRequestDetails = (
  spans: SourceDocument[],
  roles: Map<string, RequestDetail['role']>,
  conversationOf: Map<string, string | undefined>
): { details: RequestDetail[]; privacy: PrivacyFlags } => {
  const privacy: PrivacyFlags = { tool_details: false, llm_responses: false, user_prompts: false };
  const byTrace = new Map<string, RequestDetail>();

  for (const span of spans) {
    const traceId = sourceString(span, TRACE_FIELDS.traceId);
    if (!traceId) {
      continue;
    }
    const detail =
      byTrace.get(traceId) ??
      ({
        trace_id: traceId,
        conversation_id:
          sourceString(span, TRACE_FIELDS.conversationId) ?? conversationOf.get(traceId),
        role: roles.get(traceId) ?? 'cohort',
        steps: [],
        soft_failure: false,
      } satisfies RequestDetail);
    byTrace.set(traceId, detail);

    const operation = sourceString(span, TRACE_FIELDS.operationName);
    if (operation === 'execute_tool') {
      const tool = sourceString(span, TRACE_FIELDS.toolName) ?? 'unknown_tool';
      const args = sourceString(span, TRACE_FIELDS.toolCallArguments);
      const result = sourceString(span, TRACE_FIELDS.toolCallResult);
      if (args !== undefined || result !== undefined) {
        privacy.tool_details = true;
      }
      const statusMessage = sourceString(span, TRACE_FIELDS.statusMessage);
      detail.steps.push({
        step: detail.steps.length + 1,
        tool,
        digest: argumentDigest(tool, args),
        status: statusFrom(readSourceField(span, TRACE_FIELDS.statusCode)),
        ...(statusMessage ? { status_message: statusMessage.slice(0, 300) } : {}),
        partial_error: hasPartialError(result),
        empty_result: isEmptyRetrieval(result),
        result_chars: result?.length ?? 0,
        duration_seconds:
          Math.round(
            (asNumber(readSourceField(span, TRACE_FIELDS.duration)) / NANOS_PER_SECOND) * 100
          ) / 100,
      });
      continue;
    }

    if (operation === 'chat') {
      const input = sourceString(span, TRACE_FIELDS.inputMessages);
      const output = sourceString(span, TRACE_FIELDS.outputMessages);
      if (input !== undefined && detail.first_user_message === undefined) {
        const userMessage = firstUserMessage(input);
        if (userMessage) {
          privacy.user_prompts = true;
          detail.first_user_message = userMessage.slice(0, 500);
        }
      }
      if (output !== undefined) {
        privacy.llm_responses = true;
        const { text, finishReason } = assistantOutput(output);
        if (text) {
          // Spans arrive oldest first, so the last assistant text wins as the final message.
          detail.final_assistant_message = text.slice(0, 500);
          detail.soft_failure = isSoftFailure(text) || finishReason === 'length';
        }
        if (finishReason) {
          detail.finish_reason = finishReason;
        }
      }
    }
  }

  return { details: [...byTrace.values()], privacy };
};

const contentSignatures = (
  state: RunState,
  details: RequestDetail[],
  countedOver: CheckSignature['counted_over']
): { partial: CheckSignature[]; empty: CheckSignature[]; soft: CheckSignature[] } => {
  const sampled = details.length;
  const partialBy = new Map<string, string[]>();
  const emptyBy = new Map<string, string[]>();
  const softBy = new Map<string, string[]>();

  for (const detail of details) {
    for (const step of detail.steps) {
      if (step.partial_error && step.status !== 'Error') {
        partialBy.set(step.tool, [...(partialBy.get(step.tool) ?? []), detail.trace_id]);
      }
      if (step.empty_result && detail.final_assistant_message !== undefined) {
        const targets = step.digest.match(/targets=([^ ]+)/)?.[1] ?? step.tool;
        emptyBy.set(targets, [...(emptyBy.get(targets) ?? []), detail.trace_id]);
      }
    }
    if (detail.soft_failure) {
      const shape = toolSignature(detail.steps.map((step) => step.tool)) || 'no_tools';
      softBy.set(shape, [...(softBy.get(shape) ?? []), detail.trace_id]);
    }
  }

  const toSignatures = (
    map: Map<string, string[]>,
    kind: FindingKind,
    prefix: string,
    confidenceCap: ConfidenceCap
  ) =>
    [...map.entries()].map(([key, traceIds]) =>
      signatureFor(state, {
        signature: `${prefix}:${key}`,
        kind,
        traceIds,
        countedOver,
        sampledRequests: sampled,
        confidenceCap,
      })
    );

  return {
    partial: toSignatures(partialBy, 'partial_tool_error', 'partial_error', 'confirmed'),
    empty: toSignatures(emptyBy, 'empty_retrieval', 'empty_retrieval', 'strong'),
    soft: toSignatures(softBy, 'soft_failure', 'soft_failure', 'strong'),
  };
};

const fired = (signatures: CheckSignature[], minRequests: number): boolean =>
  signatures.some((signature) => signature.prevalence.affected_requests >= minRequests);

/**
 * Runs the whole trace catalog for a scope in one call: request sample, baselines, outliers,
 * cohorts, bounded `_source` detail, content-derived checks and prevalence per signature.
 */
export const runTraceChecks = async ({
  client,
  selector,
  fallbackTracesIndex,
  parameters: overrides = {},
}: {
  client: TraceChecksClient;
  selector: TraceScopeSelector;
  fallbackTracesIndex: string;
  parameters?: Partial<TraceChecksParameters>;
}): Promise<TraceChecksResult> => {
  const parameters: TraceChecksParameters = { ...DEFAULT_TRACE_CHECKS_PARAMETERS, ...overrides };
  const tracesIndex = resolveTracesIndex(selector, fallbackTracesIndex);

  const countRows = rowsToObjects(await client.esql(buildRequestCountQuery(selector)));
  const totalRequests = asNumber(countRows[0]?.n);
  if (totalRequests === 0) {
    return skippedRun(selector, tracesIndex, parameters, 'empty cohort: no requests in scope', 0);
  }

  const sampleRows = rowsToObjects(
    await client.esql(
      buildRequestSampleQuery(selector, { totalRequests, cap: parameters.sample_cap })
    )
  );
  const sample: SampleRow[] = sampleRows.flatMap((record) => {
    const traceId = asString(record[TRACE_FIELDS.traceId]);
    return traceId
      ? [
          {
            trace_id: traceId,
            conversation_id: asString(record[TRACE_FIELDS.conversationId]),
            duration_seconds: asNumber(record[TRACE_FIELDS.duration]) / NANOS_PER_SECOND,
          },
        ]
      : [];
  });
  if (sample.length === 0) {
    return skippedRun(
      selector,
      tracesIndex,
      parameters,
      'empty cohort: sample returned no trace ids',
      totalRequests
    );
  }

  const state: RunState = {
    parameters,
    thresholds: {
      minRequests: parameters.prevalence_min_requests,
      minFraction: parameters.prevalence_min_fraction,
      minConversations: parameters.prevalence_min_conversations,
    },
    sample,
    traceIds: sample.map((entry) => entry.trace_id),
    conversationOf: new Map(sample.map((entry) => [entry.trace_id, entry.conversation_id])),
  };
  const sampledRequests = sample.length;
  const band = sampleBand(sampledRequests);
  const { traceIds } = state;

  const [
    perConversationRows,
    toolFailureRows,
    toolErrorRows,
    modelErrorRows,
    requestBaselineRows,
    toolBaselineRows,
    profileRows,
    spanTimeRows,
    tokenRows,
  ] = await Promise.all([
    client.esql(buildRequestsPerConversationQuery(tracesIndex, traceIds)).then(rowsToObjects),
    client.esql(buildToolFailuresByToolQuery(tracesIndex, traceIds)).then(rowsToObjects),
    client.esql(buildToolErrorSignaturesQuery(tracesIndex, traceIds)).then(rowsToObjects),
    client.esql(buildModelErrorsQuery(tracesIndex, traceIds)).then(rowsToObjects),
    client
      .esql(buildRequestBaselineQuery(tracesIndex, traceIds, parameters.percentile))
      .then(rowsToObjects),
    client
      .esql(
        buildToolBaselineQuery(tracesIndex, traceIds, {
          percentile: parameters.percentile,
          topTools: parameters.top_tools,
        })
      )
      .then(rowsToObjects),
    client
      .esql(buildRequestToolProfileQuery(tracesIndex, traceIds, parameters.sample_cap))
      .then(rowsToObjects),
    client
      .esql(buildSpanTimeQuery(tracesIndex, traceIds, parameters.sample_cap))
      .then(rowsToObjects),
    client
      .esql(buildTokenGrowthQuery(tracesIndex, traceIds, parameters.sample_cap))
      .then(rowsToObjects),
  ]);

  const checks: CheckRow[] = [];

  // T1 / T10: explicit tool errors by (tool, error class); T10 takes the unsupported subset.
  const errorGroups = new Map<
    string,
    {
      tool: string;
      errorClass: string;
      messages: Set<string>;
      traceIds: string[];
      spans: number;
      unsupported: boolean;
    }
  >();
  for (const record of toolErrorRows) {
    const tool = asString(record[TRACE_FIELDS.toolName]) ?? 'unknown_tool';
    const message = asString(record[TRACE_FIELDS.statusMessage]);
    const klass = errorClass(message);
    const key = `${tool}|${klass}`;
    const group = errorGroups.get(key) ?? {
      tool,
      errorClass: klass,
      messages: new Set<string>(),
      traceIds: [],
      spans: 0,
      unsupported: false,
    };
    if (message) {
      group.messages.add(message.slice(0, 300));
    }
    group.traceIds.push(...asStrings(record.trace_ids));
    group.spans += asNumber(record.spans);
    group.unsupported = group.unsupported || isUnsupportedOperation(message);
    errorGroups.set(key, group);
  }
  const toolErrorSignatures: CheckSignature[] = [];
  const unsupportedSignatures: CheckSignature[] = [];
  for (const group of errorGroups.values()) {
    const requests = new Set(group.traceIds).size;
    if (requests < 2 && group.spans < 3) {
      continue;
    }
    const signature = signatureFor(state, {
      signature: `${group.tool}|${group.errorClass}`,
      kind: group.unsupported ? 'unsupported_operation' : 'tool_error',
      traceIds: group.traceIds,
      countedOver: 'sample',
      sampledRequests,
      confidenceCap: 'confirmed',
      details: { tool: group.tool, spans: group.spans, messages: [...group.messages].slice(0, 3) },
    });
    (group.unsupported ? unsupportedSignatures : toolErrorSignatures).push(signature);
  }
  const toolTotals = toolFailureRows.map((record) => ({
    tool: asString(record[TRACE_FIELDS.toolName]) ?? 'unknown_tool',
    calls: asNumber(record.calls),
    errors: asNumber(record.errors),
    p95_seconds: asNumber(record.p95_seconds),
  }));
  checks.push(
    row('T1', toolErrorSignatures.length > 0 ? 'fired' : 'not_fired', {
      threshold: 'same tool and error class in 2+ requests, or 3+ error spans',
      counts: {
        tool_calls: toolTotals.reduce((sum, tool) => sum + tool.calls, 0),
        tool_errors: toolTotals.reduce((sum, tool) => sum + tool.errors, 0),
        error_signatures: errorGroups.size,
      },
      signatures: toolErrorSignatures,
      note: `tools by errors: ${toolTotals
        .slice(0, 5)
        .map((tool) => `${tool.tool} ${tool.errors}/${tool.calls}`)
        .join('; ')}`,
    })
  );
  checks.push(
    row('T10', unsupportedSignatures.length > 0 ? 'fired' : 'not_fired', {
      threshold: 'T1 signature whose message matches a known ES|QL / tool limitation',
      counts: { signatures: unsupportedSignatures.length },
      signatures: unsupportedSignatures,
    })
  );

  // T9: model errors, reported for routing.
  const modelSignatures = modelErrorRows.map((record) => {
    const model = asString(record[TRACE_FIELDS.requestModel]) ?? 'unknown_model';
    const message = asString(record[TRACE_FIELDS.statusMessage]);
    return signatureFor(state, {
      signature: `model:${model}|${errorClass(message)}`,
      kind: 'system_error',
      traceIds: asStrings(record.trace_ids),
      countedOver: 'sample',
      sampledRequests,
      confidenceCap: 'confirmed',
      details: { model, spans: asNumber(record.spans), message: message?.slice(0, 300) },
    });
  });
  checks.push(
    row('T9', modelSignatures.length > 0 ? 'fired' : 'not_fired', {
      threshold: 'any chat span with status.code Error',
      counts: { signatures: modelSignatures.length },
      signatures: modelSignatures,
      note: 'system errors are never KI-eligible; surfaced for routing',
    })
  );

  // Baselines, outliers and cohorts (T3, T4).
  const profiles: RequestProfile[] = profileRows.flatMap((record) => {
    const traceId = asString(record[TRACE_FIELDS.traceId]);
    if (!traceId) {
      return [];
    }
    const tools = asStrings(record.tools);
    return [
      {
        trace_id: traceId,
        conversation_id: asString(record.conversation_id) ?? state.conversationOf.get(traceId),
        calls: asNumber(record.calls),
        tools,
        signature: toolSignature(tools),
      },
    ];
  });
  const outliers: Outlier[] = [];
  const requestBaseline = requestBaselineRows[0] ? readBaseline(requestBaselineRows[0]) : undefined;
  let requestThreshold: BaselineThreshold | undefined;
  if (!requestBaseline || requestBaseline.n === 0) {
    checks.push(row('T3', 'skipped', { note: 'no tool calls in the sampled requests' }));
  } else if (band === 'insufficient') {
    checks.push(
      row('T3', 'insufficient', {
        counts: { requests_with_tools: requestBaseline.n },
        note: `insufficient requests: ${requestBaseline.n} with tool calls, ${sampledRequests} sampled (minimum 10)`,
      })
    );
  } else {
    const threshold = computeThreshold(requestBaseline, {
      madMultiplier: parameters.mad_multiplier,
    });
    requestThreshold = threshold;
    const heavy = profiles.filter((profile) => profile.calls > threshold.threshold);
    for (const profile of heavy) {
      const cohort = selectCohort(profile, profiles, requestBaseline.med);
      outliers.push({
        check_id: 'T3',
        trace_id: profile.trace_id,
        conversation_id: profile.conversation_id,
        calls: profile.calls,
        signature: profile.signature,
        threshold,
        baseline: requestBaseline,
        cohort_trace_ids: cohort.traceIds,
        cohort_rule: cohort.rule,
      });
    }
    const bySignature = new Map<string, string[]>();
    heavy.forEach((profile) =>
      bySignature.set(profile.signature, [
        ...(bySignature.get(profile.signature) ?? []),
        profile.trace_id,
      ])
    );
    checks.push(
      row('T3', heavy.length > 0 ? 'fired' : 'not_fired', {
        threshold: thresholdLabel(threshold, requestBaseline),
        counts: { outlier_requests: heavy.length, requests_with_tools: requestBaseline.n },
        signatures: [...bySignature.entries()].map(([signature, ids]) =>
          signatureFor(state, {
            signature: `tool_heavy:${signature}`,
            kind: 'loop',
            traceIds: ids,
            countedOver: 'sample',
            sampledRequests,
            confidenceCap: 'suggestive',
            details: { mean_plus_2sd: threshold.mean_plus_2sd },
          })
        ),
        note: 'a heavy request is not a finding until the comparison protocol (T11) classifies it',
      })
    );
  }

  const toolBaselines: TraceChecksResult['baselines']['tools'] = [];
  const t4Signatures: CheckSignature[] = [];
  if (band === 'insufficient' || toolBaselineRows.length === 0) {
    checks.push(
      row('T4', band === 'insufficient' ? 'insufficient' : 'skipped', {
        note:
          band === 'insufficient'
            ? `insufficient requests: ${sampledRequests} sampled (minimum 10)`
            : 'no tool calls in the sampled requests',
      })
    );
  } else {
    for (const record of toolBaselineRows) {
      const tool = asString(record[TRACE_FIELDS.toolName]);
      if (!tool) {
        continue;
      }
      const baseline = readBaseline(record);
      const threshold = computeThreshold(baseline, { madMultiplier: parameters.mad_multiplier });
      toolBaselines.push({ tool, total: asNumber(record.total), ...baseline, ...threshold });
      const repeats = rowsToObjects(
        await client.esql(
          buildToolRepeatsQuery(tracesIndex, traceIds, {
            toolName: tool,
            threshold: threshold.threshold,
          })
        )
      );
      const repeatIds: string[] = [];
      for (const repeat of repeats) {
        const traceId = asString(repeat[TRACE_FIELDS.traceId]);
        if (!traceId) {
          continue;
        }
        repeatIds.push(traceId);
        const profile = profiles.find((entry) => entry.trace_id === traceId);
        const outlier = {
          trace_id: traceId,
          conversation_id: asString(repeat.conversation_id) ?? state.conversationOf.get(traceId),
          signature: profile?.signature ?? tool,
          tool,
        };
        const cohort = selectCohort(outlier, profiles, baseline.med);
        outliers.push({
          check_id: 'T4',
          ...outlier,
          calls: asNumber(repeat.calls),
          threshold,
          baseline,
          cohort_trace_ids: cohort.traceIds,
          cohort_rule: cohort.rule,
        });
      }
      if (repeatIds.length > 0) {
        t4Signatures.push(
          signatureFor(state, {
            signature: `repeat:${tool}`,
            kind: 'loop',
            traceIds: repeatIds,
            countedOver: 'sample',
            sampledRequests,
            confidenceCap: band === 'limited' ? 'suggestive' : 'strong',
            details: { tool, threshold: thresholdLabel(threshold, baseline) },
          })
        );
      }
    }
    checks.push(
      row('T4', t4Signatures.length > 0 ? 'fired' : 'not_fired', {
        threshold: `per tool: calls > max(pN, med + ${parameters.mad_multiplier} * mad, med + 2) and calls >= 2`,
        counts: {
          tools_profiled: toolBaselines.length,
          outlier_requests: outliers.filter((o) => o.check_id === 'T4').length,
        },
        signatures: t4Signatures,
        note: 'T11 decides discovery_loop / recovery_loop / multi_step_task / multi_turn_followup per signature',
      })
    );
  }

  // T7: one span over half the request.
  const requestDuration = new Map(sample.map((entry) => [entry.trace_id, entry.duration_seconds]));
  const dominant = new Map<string, { op: string; seconds: number }>();
  for (const record of spanTimeRows) {
    const traceId = asString(record[TRACE_FIELDS.traceId]);
    const op = asString(record[TRACE_FIELDS.operationName]);
    if (!traceId || !op) {
      continue;
    }
    const seconds = asNumber(record.max_span) / NANOS_PER_SECOND;
    const current = dominant.get(traceId);
    if (!current || seconds > current.seconds) {
      dominant.set(traceId, { op, seconds });
    }
  }
  const latencyBy = new Map<string, string[]>();
  for (const [traceId, { op, seconds }] of dominant) {
    const total = requestDuration.get(traceId) ?? 0;
    if (total > 0 && seconds > 0.5 * total) {
      const key = op === 'chat' ? 'model_dominated' : 'tool_dominated';
      latencyBy.set(key, [...(latencyBy.get(key) ?? []), traceId]);
    }
  }
  const durations = sample.map((entry) => entry.duration_seconds);
  const latencySignatures = [...latencyBy.entries()].map(([key, ids]) =>
    signatureFor(state, {
      signature: `latency:${key}`,
      kind: 'timeout_or_latency',
      traceIds: ids,
      countedOver: 'sample',
      sampledRequests,
      confidenceCap: 'suggestive',
      details: { p95_request_seconds: Math.round(percentile(durations, 95) * 100) / 100 },
    })
  );
  checks.push(
    row('T7', latencySignatures.length > 0 ? 'fired' : 'not_fired', {
      threshold: 'one chat or tool span longer than 50% of the request',
      counts: {
        requests_measured: dominant.size,
        p95_request_seconds: Math.round(percentile(durations, 95) * 100) / 100,
      },
      signatures: latencySignatures,
      note: 'model-dominated latency defaults to ki_usefulness unlikely',
    })
  );

  // T8: token growth within a request or a request above the p99 total.
  const totals = tokenRows.map((record) => asNumber(record.total_input));
  const p99 = band === 'full' ? percentile(totals, 99) : Number.POSITIVE_INFINITY;
  const runaway: string[] = [];
  for (const record of tokenRows) {
    const traceId = asString(record[TRACE_FIELDS.traceId]);
    if (!traceId) {
      continue;
    }
    const first = asNumber(record.first_input);
    const last = asNumber(record.last_input);
    const grew =
      asNumber(record.chats) >= 3 && first > 0 && last / first > parameters.token_growth_factor;
    if (grew || (Number.isFinite(p99) && asNumber(record.total_input) > p99)) {
      runaway.push(traceId);
    }
  }
  const tokenSignatures =
    runaway.length > 0
      ? [
          signatureFor(state, {
            signature: 'token_runaway',
            kind: 'token_runaway',
            traceIds: runaway,
            countedOver: 'sample',
            sampledRequests,
            confidenceCap: 'suggestive',
            details: {
              growth_factor: parameters.token_growth_factor,
              p99_total_input: Number.isFinite(p99) ? p99 : null,
            },
          }),
        ]
      : [];
  checks.push(
    row(
      'T8',
      tokenRows.length === 0 ? 'skipped' : tokenSignatures.length > 0 ? 'fired' : 'not_fired',
      {
        threshold: `input tokens grow ${parameters.token_growth_factor}x across 3+ chat spans, or total above the cohort p99`,
        counts: { requests_with_chat: tokenRows.length },
        signatures: tokenSignatures,
        ...(tokenRows.length === 0 ? { note: 'no chat spans with token usage' } : {}),
      }
    )
  );

  // Detail set: outliers, their cohorts and error exemplars, bounded.
  const roles = new Map<string, RequestDetail['role']>();
  const addRole = (traceId: string, role: RequestDetail['role']) => {
    if (roles.size < parameters.detail_limit && !roles.has(traceId)) {
      roles.set(traceId, role);
    }
  };
  outliers.forEach((outlier) => addRole(outlier.trace_id, 'outlier'));
  [...toolErrorSignatures, ...unsupportedSignatures].forEach((signature) =>
    signature.sample_trace_ids.slice(0, 3).forEach((traceId) => addRole(traceId, 'error'))
  );
  outliers.forEach((outlier) =>
    outlier.cohort_trace_ids.forEach((traceId) => addRole(traceId, 'cohort'))
  );
  if (roles.size === 0) {
    // Nothing flagged: still read a few requests so T2, T5, T6 and privacy flags have evidence.
    traceIds
      .slice(0, Math.min(5, parameters.detail_limit))
      .forEach((traceId) => addRole(traceId, 'cohort'));
  }

  const detailSpans = await client.search(
    buildDetailSearch(tracesIndex, [...roles.keys()], { size: DETAIL_SPAN_CAP })
  );
  let { details, privacy } = buildRequestDetails(detailSpans, roles, state.conversationOf);
  let content = contentSignatures(state, details, 'detail_set');

  // Widen: any content signature already seen in 2+ requests is recounted over the whole sample.
  const needsWidening =
    details.length < sampledRequests &&
    [...content.partial, ...content.empty, ...content.soft].some(
      (signature) => signature.prevalence.affected_requests >= 2
    );
  if (needsWidening) {
    const widenedSpans = await client.search(
      buildDetailSearch(tracesIndex, traceIds, { size: WIDENED_SPAN_CAP })
    );
    const widened = buildRequestDetails(widenedSpans, roles, state.conversationOf);
    content = contentSignatures(state, widened.details, 'sample');
    privacy = {
      tool_details: privacy.tool_details || widened.privacy.tool_details,
      llm_responses: privacy.llm_responses || widened.privacy.llm_responses,
      user_prompts: privacy.user_prompts || widened.privacy.user_prompts,
    };
    // Keep the bounded detail set for the protocol; only the counts came from the wider read.
    details = details.map(
      (detail) => widened.details.find((w) => w.trace_id === detail.trace_id) ?? detail
    );
  }

  checks.push(
    row(
      'T2',
      !privacy.tool_details ? 'skipped' : fired(content.partial, 2) ? 'fired' : 'not_fired',
      {
        threshold: 'result carries {"type":"error"} while the span is Ok, in 2+ requests',
        counts: { signatures: content.partial.length },
        signatures: content.partial,
        ...(!privacy.tool_details
          ? { note: 'skipped: includeToolDetails is off, tool results are not in the traces' }
          : {}),
      }
    )
  );
  checks.push(
    row('T5', !privacy.tool_details ? 'skipped' : fired(content.empty, 1) ? 'fired' : 'not_fired', {
      threshold: 'zero-row retrieval followed by a final answer in the same request',
      counts: { signatures: content.empty.length },
      signatures: content.empty,
      ...(!privacy.tool_details ? { note: 'skipped: includeToolDetails is off' } : {}),
    })
  );
  checks.push(
    row('T6', !privacy.llm_responses ? 'skipped' : fired(content.soft, 1) ? 'fired' : 'not_fired', {
      threshold:
        'final assistant message admits non-completion (phrase list or finish_reason length)',
      counts: { signatures: content.soft.length },
      signatures: content.soft,
      ...(!privacy.llm_responses
        ? { note: 'skipped: includeLlmResponses is off, final messages are not in the traces' }
        : { note: 'Strong only when 2+ requests show it and a similar request succeeded' }),
    })
  );

  // T11: the protocol input is the detail set plus per-conversation request counts.
  const perConversation = perConversationRows.map((record) => ({
    conversation_id: asString(record[TRACE_FIELDS.conversationId]),
    requests: asNumber(record.n),
    p95_seconds: asNumber(record.p95_seconds),
  }));
  checks.push(
    row('T11', 'provided', {
      counts: {
        outliers: outliers.length,
        detail_requests: details.length,
        conversations_with_multiple_requests: perConversation.filter((entry) => entry.requests > 1)
          .length,
      },
      note: 'classify per signature using `detail` and `outliers`: discovery_loop, recovery_loop, multi_step_task, multi_turn_followup, unclear',
    })
  );

  // T12: recurring task shapes from the per-request profiles.
  const shapes = new Map<string, { requests: number; calls: number[]; trace_ids: string[] }>();
  for (const profile of profiles) {
    const shape = shapes.get(profile.signature) ?? { requests: 0, calls: [], trace_ids: [] };
    shape.requests += 1;
    shape.calls.push(profile.calls);
    shape.trace_ids.push(profile.trace_id);
    shapes.set(profile.signature, shape);
  }
  const firstMessageOf = new Map(
    details
      .filter((d) => d.first_user_message)
      .map((d) => [d.trace_id, d.first_user_message as string])
  );
  const taskShapes = [...shapes.entries()]
    .sort((left, right) => right[1].requests - left[1].requests)
    .slice(0, MAX_TASK_SHAPES)
    .map(([signature, shape]) => ({
      signature,
      requests: shape.requests,
      share: Math.round((shape.requests / sampledRequests) * 1000) / 1000,
      med_calls: median(shape.calls),
      example_user_message: shape.trace_ids.map((id) => firstMessageOf.get(id)).find(Boolean),
      sample_trace_ids: shape.trace_ids.slice(0, MAX_SAMPLE_TRACE_IDS),
    }));
  checks.push(
    row('T12', 'provided', {
      counts: { shapes: shapes.size, requests_with_tools: profiles.length },
      note: JSON.stringify(taskShapes),
    })
  );

  // T13: most touched indices from tool arguments, counted by request.
  const argumentSpans = await client.search(
    buildToolArgumentsSearch(tracesIndex, traceIds, { size: T13_SPAN_CAP })
  );
  const indicesByTrace = new Map<string, Set<string>>();
  let argumentSpansWithContent = 0;
  for (const span of argumentSpans) {
    const traceId = sourceString(span, TRACE_FIELDS.traceId);
    const args = sourceString(span, TRACE_FIELDS.toolCallArguments);
    if (!traceId || args === undefined) {
      continue;
    }
    argumentSpansWithContent += 1;
    const targets = parseTargetIndices(args);
    if (targets.length === 0) {
      continue;
    }
    const set = indicesByTrace.get(traceId) ?? new Set<string>();
    targets.forEach((target) => set.add(target));
    indicesByTrace.set(traceId, set);
  }
  const requestsByIndex = new Map<string, number>();
  for (const set of indicesByTrace.values()) {
    for (const index of set) {
      requestsByIndex.set(index, (requestsByIndex.get(index) ?? 0) + 1);
    }
  }
  const touched = [...requestsByIndex.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_TOUCHED_INDICES)
    .map(([index, requests]) => ({
      index,
      requests,
      share: Math.round((requests / sampledRequests) * 1000) / 1000,
    }));
  checks.push(
    row('T13', argumentSpansWithContent === 0 ? 'skipped' : 'provided', {
      counts: { indices: requestsByIndex.size, requests_with_targets: indicesByTrace.size },
      note:
        argumentSpansWithContent === 0
          ? 'skipped: includeToolDetails is off, tool arguments are not in the traces'
          : JSON.stringify(touched),
    })
  );

  const ordered = (Object.keys(CHECK_NAMES) as Array<CheckRow['check_id']>).map(
    (checkId) => checks.find((check) => check.check_id === checkId) as CheckRow
  );
  const count = (status: CheckRow['status']) =>
    ordered.filter((check) => check.status === status).length;

  return {
    traces_index: tracesIndex,
    scope: selector,
    parameters,
    sample: {
      total_requests: totalRequests,
      sampled_requests: sampledRequests,
      sampling_fraction: Math.round((sampledRequests / totalRequests) * 10000) / 10000,
      distinct_conversations: uniqueCount(sample.map((entry) => entry.conversation_id)),
      band,
    },
    privacy,
    baselines: {
      ...(requestBaseline && requestThreshold
        ? { request: { ...requestBaseline, ...requestThreshold } }
        : {}),
      tools: toolBaselines,
    },
    checks: ordered,
    outliers,
    detail: details,
    coverage: {
      ran: ordered.length - count('skipped'),
      fired: count('fired'),
      not_fired: count('not_fired'),
      skipped: count('skipped'),
      insufficient: count('insufficient'),
    },
  };
};
