/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KiVerifier, KnowledgeIndicator } from '../types';

export const PROVENANCE_PRESENT_VERIFIER_ID = 'provenance-present';

export const PLAN_ID_ATTRIBUTE_KEY = 'plan_id';
export const FINDING_ID_ATTRIBUTE_KEY = 'finding_id';
export const SOURCE_QUERY_ATTRIBUTE_KEY = 'source_query';
export const TRACE_IDS_ATTRIBUTE_KEY = 'trace_ids';

const PLAN_TAG_PREFIX = 'plan:';
const FINDING_TAG_PREFIX = 'finding:';

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isNonEmptyStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);

const hasTagWithPrefix = (ki: KnowledgeIndicator, prefix: string): boolean =>
  Array.isArray(ki.tags) &&
  ki.tags.some(
    (tag) => typeof tag === 'string' && tag.startsWith(prefix) && tag.length > prefix.length
  );

/**
 * Whether the KI claims to come from a guided investigation plan. Only those KIs are held to the
 * provenance contract; KIs written by older or hand-made workflows are left alone.
 */
export const isPlannedKi = (ki: KnowledgeIndicator): boolean =>
  hasTagWithPrefix(ki, PLAN_TAG_PREFIX) ||
  hasTagWithPrefix(ki, FINDING_TAG_PREFIX) ||
  [
    PLAN_ID_ATTRIBUTE_KEY,
    FINDING_ID_ATTRIBUTE_KEY,
    SOURCE_QUERY_ATTRIBUTE_KEY,
    TRACE_IDS_ATTRIBUTE_KEY,
  ].some((key) => ki.attributes?.[key] !== undefined);

/**
 * Requires a planned KI to say where it came from: the plan item it implements and at least one
 * of the source query that enumerated its unit, the trace ids behind it, or the finding it answers.
 */
export const createProvenancePresentVerifier = (): KiVerifier => ({
  id: PROVENANCE_PRESENT_VERIFIER_ID,
  applies: isPlannedKi,
  async verify(ki) {
    const attributes = ki.attributes ?? {};
    const failures: string[] = [];

    const planId = attributes[PLAN_ID_ATTRIBUTE_KEY];
    if (!isNonEmptyString(planId)) {
      failures.push(
        `attributes.${PLAN_ID_ATTRIBUTE_KEY} must name the plan item the KI implements`
      );
    } else if (!hasTagWithPrefix(ki, PLAN_TAG_PREFIX)) {
      failures.push(`tags must include "${PLAN_TAG_PREFIX}${planId}"`);
    }

    const sourceQuery = attributes[SOURCE_QUERY_ATTRIBUTE_KEY];
    const traceIds = attributes[TRACE_IDS_ATTRIBUTE_KEY];
    const findingId = attributes[FINDING_ID_ATTRIBUTE_KEY];
    // One ES|QL string, or several when a targeted KI was measured with more than one query.
    const hasSourceQuery = isNonEmptyString(sourceQuery) || isNonEmptyStringArray(sourceQuery);
    const hasSource =
      hasSourceQuery || isNonEmptyStringArray(traceIds) || isNonEmptyString(findingId);
    if (!hasSource) {
      failures.push(
        `one of attributes.${SOURCE_QUERY_ATTRIBUTE_KEY} (ES|QL string or array of strings), attributes.${TRACE_IDS_ATTRIBUTE_KEY} (non-empty array) or attributes.${FINDING_ID_ATTRIBUTE_KEY} is required`
      );
    }
    if (sourceQuery !== undefined && !hasSourceQuery) {
      failures.push(
        `attributes.${SOURCE_QUERY_ATTRIBUTE_KEY} must be a non-empty ES|QL string or a non-empty array of ES|QL strings`
      );
    }
    if (traceIds !== undefined && !isNonEmptyStringArray(traceIds)) {
      failures.push(`attributes.${TRACE_IDS_ATTRIBUTE_KEY} must be a non-empty array of trace ids`);
    }
    if (isNonEmptyString(findingId) && !hasTagWithPrefix(ki, FINDING_TAG_PREFIX)) {
      failures.push(`tags must include "${FINDING_TAG_PREFIX}${findingId}"`);
    }

    return failures.length > 0 ? { passed: false, reason: failures.join('\n') } : { passed: true };
  },
});
