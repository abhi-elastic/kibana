/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { FindingGate, FindingInput } from './http_api/findings';

/** Defaults for the prevalence gate; both are `trace_checks` parameters and may be overridden. */
export const DEFAULT_PREVALENCE_MIN_REQUESTS = 3;
export const DEFAULT_PREVALENCE_MIN_FRACTION = 0.05;
export const DEFAULT_PREVALENCE_MIN_CONVERSATIONS = 2;

/** Defaults for the scale gate applied to hypothesized findings. */
export const DEFAULT_SCALE_MIN_UNITS = 2;
export const DEFAULT_SCALE_MIN_FRACTION = 0.2;

export interface GateThresholds {
  prevalence_min_requests?: number;
  prevalence_min_fraction?: number;
  prevalence_min_conversations?: number;
  scale_min_units?: number;
  scale_min_fraction?: number;
}

/**
 * Decides KI eligibility. Observed findings pass when the pattern recurs across requests and
 * conversations; hypothesized findings pass when the measured property is broad enough. A
 * `system_error` is routed to the owning team and never gated in.
 */
export const applyGate = (finding: FindingInput, thresholds: GateThresholds = {}): FindingGate => {
  if (finding.kind === 'system_error') {
    return {
      rule: 'none',
      passed: false,
      reason: 'System errors are reported for routing, not for a KI.',
    };
  }

  if (finding.evidence_type === 'observed') {
    const { prevalence } = finding;
    if (!prevalence) {
      return {
        rule: 'prevalence',
        passed: false,
        reason:
          'No prevalence recorded; observed findings need affected and sampled request counts.',
      };
    }
    const minRequests = Math.max(
      thresholds.prevalence_min_requests ?? DEFAULT_PREVALENCE_MIN_REQUESTS,
      Math.ceil(
        (thresholds.prevalence_min_fraction ?? DEFAULT_PREVALENCE_MIN_FRACTION) *
          prevalence.sampled_requests
      )
    );
    const minConversations =
      thresholds.prevalence_min_conversations ?? DEFAULT_PREVALENCE_MIN_CONVERSATIONS;
    const passed =
      prevalence.affected_requests >= minRequests &&
      prevalence.distinct_conversations >= minConversations;
    return {
      rule: 'prevalence',
      passed,
      reason: `${prevalence.affected_requests} of ${prevalence.sampled_requests} sampled requests in ${prevalence.distinct_conversations} conversations (floor: ${minRequests} requests, ${minConversations} conversations)`,
    };
  }

  const { scale } = finding;
  if (!scale) {
    return {
      rule: 'scale',
      passed: false,
      reason: 'No scale recorded; hypothesized findings need affected and total unit counts.',
    };
  }
  const minUnits = Math.max(
    thresholds.scale_min_units ?? DEFAULT_SCALE_MIN_UNITS,
    Math.ceil((thresholds.scale_min_fraction ?? DEFAULT_SCALE_MIN_FRACTION) * scale.total_units)
  );
  const passed = scale.affected_units >= minUnits;
  return {
    rule: 'scale',
    passed,
    reason: `affects ${scale.affected_units} of ${scale.total_units} ${scale.unit_kind} (floor: ${minUnits})`,
  };
};
