/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { FindingInput } from '../../common/http_api/findings';
import { applyGate } from './gates';

const observed = (overrides: Partial<FindingInput> = {}): FindingInput => ({
  kind: 'tool_error',
  evidence_type: 'observed',
  title: 'execute_esql fails on unknown field',
  summary: 'Verification exceptions on the same field name.',
  subject: 'execute_esql:verification_exception:host.name',
  confidence: 'confirmed',
  impact: 'high',
  ki_usefulness: 'likely',
  prevalence: {
    affected_requests: 12,
    sampled_requests: 100,
    affected_fraction: 0.12,
    distinct_conversations: 6,
  },
  evidence: { counts: { calls: 40, errors: 12 } },
  ...overrides,
});

const hypothesized = (overrides: Partial<FindingInput> = {}): FindingInput => ({
  kind: 'discovery_risk',
  evidence_type: 'hypothesized',
  title: 'Field names overlap across indices',
  summary: 'Twelve indices share the same field names with different meanings.',
  subject: 'logs-*:field_overlap',
  confidence: 'strong',
  impact: 'medium',
  ki_usefulness: 'likely',
  scale: { affected_units: 12, total_units: 40, unit_kind: 'indices' },
  evidence: { measured_property: 'field_overlap' },
  ...overrides,
});

describe('applyGate', () => {
  describe('prevalence gate (observed findings)', () => {
    it('passes when the pattern recurs across requests and conversations', () => {
      const gate = applyGate(observed());
      expect(gate).toMatchObject({ rule: 'prevalence', passed: true });
      expect(gate.reason).toContain('12 of 100 sampled requests in 6 conversations');
    });

    it('uses max(3, 5% of sampled) as the request floor', () => {
      // 5% of 100 = 5 > 3, so 4 affected requests is below the floor.
      expect(
        applyGate(
          observed({
            prevalence: {
              affected_requests: 4,
              sampled_requests: 100,
              affected_fraction: 0.04,
              distinct_conversations: 3,
            },
          })
        ).passed
      ).toBe(false);
      // 5% of 20 = 1 < 3, so 3 affected requests is exactly at the floor.
      expect(
        applyGate(
          observed({
            prevalence: {
              affected_requests: 3,
              sampled_requests: 20,
              affected_fraction: 0.15,
              distinct_conversations: 2,
            },
          })
        ).passed
      ).toBe(true);
    });

    it('fails when everything happened in a single conversation', () => {
      const gate = applyGate(
        observed({
          prevalence: {
            affected_requests: 10,
            sampled_requests: 50,
            affected_fraction: 0.2,
            distinct_conversations: 1,
          },
        })
      );
      expect(gate.passed).toBe(false);
    });

    it('fails with an explanation when no prevalence was recorded', () => {
      const gate = applyGate(observed({ prevalence: undefined }));
      expect(gate).toMatchObject({ rule: 'prevalence', passed: false });
      expect(gate.reason).toContain('No prevalence recorded');
    });

    it('honours overridden floors', () => {
      const gate = applyGate(observed(), {
        prevalence_min_requests: 20,
        prevalence_min_conversations: 2,
      });
      expect(gate.passed).toBe(false);
      expect(gate.reason).toContain('floor: 20 requests');
    });
  });

  describe('scale gate (hypothesized findings)', () => {
    it('passes when the property affects at least max(2, 20%) of the units', () => {
      const gate = applyGate(hypothesized());
      expect(gate).toMatchObject({ rule: 'scale', passed: true });
      expect(gate.reason).toBe('affects 12 of 40 indices (floor: 8)');
    });

    it('fails for a single affected index', () => {
      expect(
        applyGate(
          hypothesized({ scale: { affected_units: 1, total_units: 40, unit_kind: 'indices' } })
        ).passed
      ).toBe(false);
    });

    it('uses 2 of at most 5 probes as the floor', () => {
      expect(
        applyGate(
          hypothesized({ scale: { affected_units: 2, total_units: 5, unit_kind: 'probes' } })
        ).passed
      ).toBe(true);
      expect(
        applyGate(
          hypothesized({ scale: { affected_units: 1, total_units: 5, unit_kind: 'probes' } })
        ).passed
      ).toBe(false);
    });

    it('fails with an explanation when no scale was recorded', () => {
      const gate = applyGate(hypothesized({ scale: undefined }));
      expect(gate).toMatchObject({ rule: 'scale', passed: false });
      expect(gate.reason).toContain('No scale recorded');
    });
  });

  it('never gates in a system_error, whatever its prevalence', () => {
    const gate = applyGate(observed({ kind: 'system_error' }));
    expect(gate).toMatchObject({ rule: 'none', passed: false });
  });
});
