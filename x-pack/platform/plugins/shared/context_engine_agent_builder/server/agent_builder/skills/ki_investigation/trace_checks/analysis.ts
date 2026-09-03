/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  DEFAULT_PREVALENCE_MIN_CONVERSATIONS,
  DEFAULT_PREVALENCE_MIN_FRACTION,
  DEFAULT_PREVALENCE_MIN_REQUESTS,
} from '@kbn/context-engine-plugin/common/findings_gates';

/** Below 10 requests nothing is planned; between 10 and 29 only the MAD rule applies. */
export const MIN_REQUESTS_FOR_MAD_RULE = 10;
export const MIN_REQUESTS_FOR_PERCENTILES = 30;

export type SampleBand = 'insufficient' | 'limited' | 'full';

export const sampleBand = (requests: number): SampleBand => {
  if (requests < MIN_REQUESTS_FOR_MAD_RULE) {
    return 'insufficient';
  }
  return requests < MIN_REQUESTS_FOR_PERCENTILES ? 'limited' : 'full';
};

export interface BaselineRow {
  n: number;
  med: number;
  mad: number;
  pN: number;
  mean: number;
  sd: number;
}

export interface BaselineThreshold {
  /** The gate actually applied. */
  threshold: number;
  /** Which rule produced the threshold, so the user sees why a request was flagged. */
  rule: 'percentile' | 'mad' | 'median_plus_2';
  /** `mean + 2 * sd`, reported for reference and never used as the gate. */
  mean_plus_2sd: number;
  band: SampleBand;
}

/**
 * `max(pN, med + k * mad, med + 2)`. The `med + 2` term guards the degenerate case where MAD is 0
 * because almost every request calls the tool once; the percentile term only counts once the
 * sample is large enough for it to mean anything.
 */
export const computeThreshold = (
  baseline: BaselineRow,
  { madMultiplier }: { madMultiplier: number }
): BaselineThreshold => {
  const band = sampleBand(baseline.n);
  const madRule = baseline.med + madMultiplier * baseline.mad;
  const medianRule = baseline.med + 2;
  const candidates: Array<{ rule: BaselineThreshold['rule']; value: number }> = [
    { rule: 'mad', value: madRule },
    { rule: 'median_plus_2', value: medianRule },
  ];
  if (band === 'full') {
    candidates.unshift({ rule: 'percentile', value: baseline.pN });
  }
  const winner = candidates.reduce((best, candidate) =>
    candidate.value > best.value ? candidate : best
  );
  return {
    threshold: winner.value,
    rule: winner.rule,
    mean_plus_2sd: baseline.mean + 2 * baseline.sd,
    band,
  };
};

export interface PrevalenceThresholds {
  minRequests: number;
  minFraction: number;
  minConversations: number;
}

export const DEFAULT_PREVALENCE_THRESHOLDS: PrevalenceThresholds = {
  minRequests: DEFAULT_PREVALENCE_MIN_REQUESTS,
  minFraction: DEFAULT_PREVALENCE_MIN_FRACTION,
  minConversations: DEFAULT_PREVALENCE_MIN_CONVERSATIONS,
};

export interface Prevalence {
  affected_requests: number;
  sampled_requests: number;
  affected_fraction: number;
  distinct_conversations: number;
}

export const buildPrevalence = (
  affectedRequests: number,
  sampledRequests: number,
  distinctConversations: number
): Prevalence => ({
  affected_requests: affectedRequests,
  sampled_requests: sampledRequests,
  affected_fraction:
    sampledRequests === 0 ? 0 : Math.round((affectedRequests / sampledRequests) * 10000) / 10000,
  distinct_conversations: distinctConversations,
});

/** Same rule as the findings store's prevalence gate, applied early so every row carries it. */
export const passesPrevalenceGate = (
  prevalence: Prevalence,
  thresholds: PrevalenceThresholds = DEFAULT_PREVALENCE_THRESHOLDS
): boolean => {
  const floor = Math.max(
    thresholds.minRequests,
    Math.ceil(thresholds.minFraction * prevalence.sampled_requests)
  );
  return (
    prevalence.affected_requests >= floor &&
    prevalence.distinct_conversations >= thresholds.minConversations
  );
};

/**
 * Collapses an error message to a class so `field_1 not found` and `field_2 not found` share a
 * signature: numbers, quoted values and ids are replaced by placeholders.
 */
export const errorClass = (message: string | null | undefined): string => {
  if (!message) {
    return 'unknown_error';
  }
  return message
    .replace(/\[[^\]]*\]/g, '[*]')
    .replace(/"[^"]*"/g, '"*"')
    .replace(/'[^']*'/g, "'*'")
    .replace(/\b[0-9a-f]{8,}\b/gi, '*')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
};

const UNSUPPORTED_OPERATION_PATTERNS: ReadonlyArray<RegExp> = [
  /unsupported/i,
  /unknown function/i,
  /not aggregatable/i,
  /cannot be used (for|in) (grouping|aggregation)/i,
  /join .*not (supported|allowed)/i,
  /unknown (column|index|field)/i,
  /verification_exception/i,
  /parsing_exception/i,
  /field \[[^\]]+\] of type \[[^\]]+\] is not supported/i,
];

/** T10: known ES|QL / tool limitations that a constraint KI can carry. */
export const isUnsupportedOperation = (message: string | null | undefined): boolean =>
  typeof message === 'string' &&
  UNSUPPORTED_OPERATION_PATTERNS.some((pattern) => pattern.test(message));

const SOFT_FAILURE_PHRASES: ReadonlyArray<RegExp> = [
  /\bi (was|am) (unable|not able) to\b/i,
  /\bi (could|can)('| no|no)?t (find|locate|retrieve|access|determine|complete)\b/i,
  /\bcouldn't (find|locate|retrieve|access|determine|complete)\b/i,
  /\bno (data|results|documents|records) (were |was )?(found|returned|available)\b/i,
  /\bunable to (find|locate|retrieve|access|determine|complete|answer)\b/i,
  /\bnot (enough|sufficient) (information|data|context)\b/i,
  /\bplease (provide|specify|clarify)\b/i,
  /\bdoes not (appear to )?exist\b/i,
  /\bi don't have (access|enough)\b/i,
];

/** T6: the final assistant message admits non-completion. */
export const isSoftFailure = (finalMessage: string | null | undefined): boolean =>
  typeof finalMessage === 'string' &&
  SOFT_FAILURE_PHRASES.some((pattern) => pattern.test(finalMessage));

/** T2: a tool span reported `Ok` while its result carries error entries. */
export const hasPartialError = (toolCallResult: string | null | undefined): boolean =>
  typeof toolCallResult === 'string' && /"type"\s*:\s*"error"/.test(toolCallResult);

/**
 * T5: an `execute_esql`-style result with zero rows. The result JSON shape varies by tool, so
 * both `values: []` (ES|QL) and `rows: []` / `hits: []` (search tools) count.
 */
export const isEmptyRetrieval = (toolCallResult: string | null | undefined): boolean => {
  if (typeof toolCallResult !== 'string') {
    return false;
  }
  if (/"type"\s*:\s*"error"/.test(toolCallResult)) {
    return false;
  }
  return (
    /"values"\s*:\s*\[\s*\]/.test(toolCallResult) ||
    /"rows"\s*:\s*\[\s*\]/.test(toolCallResult) ||
    /"hits"\s*:\s*\[\s*\]/.test(toolCallResult) ||
    /"total"\s*:\s*0\b/.test(toolCallResult)
  );
};

const FROM_TARGET = /\bFROM\s+([^\s|,]+(?:\s*,\s*[^\s|,]+)*)/i;

/**
 * T13: the indices a tool call targeted, parsed from its arguments: `FROM <target>` inside an
 * ES|QL `query`, or an `index` argument. Returns each comma-separated target once.
 */
export const parseTargetIndices = (toolCallArguments: string | null | undefined): string[] => {
  if (typeof toolCallArguments !== 'string' || toolCallArguments.length === 0) {
    return [];
  }
  const targets = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCallArguments);
  } catch {
    parsed = undefined;
  }

  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const match = FROM_TARGET.exec(value);
      if (match) {
        match[1]
          .split(',')
          .map((target) => target.trim().replace(/^"|"$/g, ''))
          .filter((target) => target.length > 0 && !target.toUpperCase().startsWith('METADATA'))
          .forEach((target) => targets.add(target));
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if ((key === 'index' || key === 'indices' || key === 'index_pattern') && entry) {
          (Array.isArray(entry) ? entry : [entry])
            .filter((target): target is string => typeof target === 'string')
            .forEach((target) => target.split(',').forEach((part) => targets.add(part.trim())));
        } else {
          visit(entry);
        }
      }
    }
  };

  visit(parsed ?? toolCallArguments);
  return [...targets].filter((target) => target.length > 0);
};

/** Compact, quotable description of a tool call: tool, targets, and the filter fields it used. */
export const argumentDigest = (
  toolName: string,
  toolCallArguments: string | null | undefined
): string => {
  const targets = parseTargetIndices(toolCallArguments);
  const filterFields = new Set<string>();
  if (typeof toolCallArguments === 'string') {
    for (const match of toolCallArguments.matchAll(/WHERE\s+([A-Za-z_][\w.]*)/gi)) {
      filterFields.add(match[1]);
    }
  }
  const parts = [toolName];
  if (targets.length > 0) {
    parts.push(`targets=${targets.join(',')}`);
  }
  if (filterFields.size > 0) {
    parts.push(`filters=${[...filterFields].slice(0, 5).join(',')}`);
  }
  return parts.join(' ');
};

interface MessagePart {
  type?: string;
  content?: unknown;
  text?: unknown;
}

interface Message {
  role?: string;
  parts?: MessagePart[];
  finish_reason?: string;
}

const parseMessages = (raw: string | null | undefined): Message[] => {
  if (typeof raw !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Message[]) : [];
  } catch {
    return [];
  }
};

const messageText = (message: Message): string =>
  (message.parts ?? [])
    .map((part) => {
      if (typeof part.content === 'string') {
        return part.content;
      }
      return typeof part.text === 'string' ? part.text : '';
    })
    .filter((text) => text.length > 0)
    .join('\n');

/** First user message text from an `input.messages` attribute, when the privacy flag allowed it. */
export const firstUserMessage = (inputMessages: string | null | undefined): string | undefined => {
  const user = parseMessages(inputMessages).find((message) => message.role === 'user');
  const text = user ? messageText(user) : '';
  return text.length > 0 ? text : undefined;
};

/** Assistant text and finish reason from an `output.messages` attribute. */
export const assistantOutput = (
  outputMessages: string | null | undefined
): { text: string | undefined; finishReason: string | undefined } => {
  const messages = parseMessages(outputMessages);
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant');
  const text = assistant ? messageText(assistant) : '';
  return {
    text: text.length > 0 ? text : undefined,
    finishReason: assistant?.finish_reason ?? messages.find((m) => m.finish_reason)?.finish_reason,
  };
};

/** Sorted, comma-joined tool set: the per-request task signature used by T12 and the cohort. */
export const toolSignature = (tools: string[]): string =>
  [...new Set(tools)].sort((left, right) => left.localeCompare(right)).join(',');

export const percentile = (values: number[], p: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
};

export const median = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};
