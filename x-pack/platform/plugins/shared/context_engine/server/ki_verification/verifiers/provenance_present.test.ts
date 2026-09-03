/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { elasticsearchServiceMock, loggingSystemMock } from '@kbn/core/server/mocks';
import type { KiVerifierContext, KnowledgeIndicator } from '../types';
import {
  createProvenancePresentVerifier,
  isPlannedKi,
  PROVENANCE_PRESENT_VERIFIER_ID,
} from './provenance_present';

describe('provenance-present verifier', () => {
  const verifier = createProvenancePresentVerifier();
  const context: KiVerifierContext = {
    esClient: elasticsearchServiceMock.createElasticsearchClient(),
    logger: loggingSystemMock.createLogger(),
  };
  const verify = (ki: KnowledgeIndicator) => verifier.verify(ki, context);

  it('has the expected id', () => {
    expect(verifier.id).toBe(PROVENANCE_PRESENT_VERIFIER_ID);
  });

  describe('applies', () => {
    it('leaves KIs without any plan or finding marker alone', () => {
      expect(verifier.applies({ type: 'index_metadata', title: 'logs' })).toBe(false);
      expect(verifier.applies({ tags: ['logs', 'plan'], attributes: { esql: 'FROM x' } })).toBe(
        false
      );
    });

    it('applies when a plan or finding tag or provenance attribute is present', () => {
      expect(isPlannedKi({ tags: ['plan:wf-1'] })).toBe(true);
      expect(isPlannedKi({ tags: ['finding:f-1'] })).toBe(true);
      expect(isPlannedKi({ attributes: { plan_id: 'wf-1' } })).toBe(true);
      expect(isPlannedKi({ attributes: { source_query: 'FROM cases' } })).toBe(true);
      expect(isPlannedKi({ attributes: { trace_ids: ['t-1'] } })).toBe(true);
    });
  });

  it('passes a family KI with plan id, tag and source query', async () => {
    await expect(
      verify({
        tags: ['plan:wf-fam-1'],
        attributes: { plan_id: 'wf-fam-1', source_query: 'FROM cases | STATS BY case_id' },
      })
    ).resolves.toEqual({ passed: true });
  });

  it('passes a targeted KI whose source_query is an array of the queries that measured it', async () => {
    await expect(
      verify({
        tags: ['plan:ki-f-1', 'finding:f-1'],
        attributes: {
          plan_id: 'ki-f-1',
          finding_id: 'f-1',
          source_query: ['FROM a | STATS c = COUNT()', 'FROM b | STATS c = COUNT()'],
        },
      })
    ).resolves.toEqual({ passed: true });
  });

  it('fails on an empty or non-string source_query array', async () => {
    const empty = await verify({
      tags: ['plan:wf-1'],
      attributes: { plan_id: 'wf-1', source_query: [] },
    });
    expect(empty.passed).toBe(false);
    const mixed = await verify({
      tags: ['plan:wf-1'],
      attributes: { plan_id: 'wf-1', source_query: ['FROM a', '  '] as unknown as string[] },
    });
    expect(mixed.passed).toBe(false);
    if (mixed.passed) return;
    expect(mixed.reason).toContain('non-empty array of ES|QL strings');
  });

  it('passes a targeted KI with plan id, finding id, tags and trace ids', async () => {
    await expect(
      verify({
        tags: ['plan:ki-f-1', 'finding:f-1'],
        attributes: { plan_id: 'ki-f-1', finding_id: 'f-1', trace_ids: ['t-1', 't-2'] },
      })
    ).resolves.toEqual({ passed: true });
  });

  it('fails when the plan id is missing', async () => {
    const outcome = await verify({ tags: ['plan:wf-1'], attributes: { source_query: 'FROM x' } });
    expect(outcome.passed).toBe(false);
    if (outcome.passed) return;
    expect(outcome.reason).toContain('attributes.plan_id must name the plan item');
  });

  it('fails when the plan tag does not accompany the plan id', async () => {
    const outcome = await verify({ attributes: { plan_id: 'wf-1', source_query: 'FROM x' } });
    expect(outcome.passed).toBe(false);
    if (outcome.passed) return;
    expect(outcome.reason).toContain('tags must include "plan:wf-1"');
  });

  it('fails when no source, trace ids or finding is given', async () => {
    const outcome = await verify({ tags: ['plan:wf-1'], attributes: { plan_id: 'wf-1' } });
    expect(outcome.passed).toBe(false);
    if (outcome.passed) return;
    expect(outcome.reason).toContain('one of attributes.source_query');
  });

  it('fails on malformed source_query and trace_ids', async () => {
    const outcome = await verify({
      tags: ['plan:wf-1'],
      attributes: { plan_id: 'wf-1', source_query: '   ', trace_ids: [] },
    });
    expect(outcome.passed).toBe(false);
    if (outcome.passed) return;
    expect(outcome.reason).toContain('attributes.source_query must be a non-empty ES|QL string');
    expect(outcome.reason).toContain('attributes.trace_ids must be a non-empty array');
  });

  it('requires the finding tag when a finding id is given', async () => {
    const outcome = await verify({
      tags: ['plan:ki-1'],
      attributes: { plan_id: 'ki-1', finding_id: 'f-1' },
    });
    expect(outcome.passed).toBe(false);
    if (outcome.passed) return;
    expect(outcome.reason).toBe('tags must include "finding:f-1"');
  });
});
