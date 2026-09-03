/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { elasticsearchServiceMock, loggingSystemMock } from '@kbn/core/server/mocks';
import { MAX_KI_TITLE_LENGTH } from '../../../common/step_types/ki';
import type { KiVerifierContext, KnowledgeIndicator } from '../types';
import { createSchemaShapeVerifier, SCHEMA_SHAPE_VERIFIER_ID } from './schema_shape';

const validKi: KnowledgeIndicator = {
  type: 'case_summary',
  title: 'Case 02115676',
  description: 'Resolved SSO outage',
  content: 'Root cause: expired signing key.',
  tags: ['plan:wf-fam-1'],
  attributes: {
    plan_id: 'wf-fam-1',
    confidence: 0.9,
    expires_at: '2026-10-01T00:00:00Z',
    evidence: ['status=resolved (1/1)'],
  },
};

describe('schema-shape verifier', () => {
  const verifier = createSchemaShapeVerifier();
  const context: KiVerifierContext = {
    esClient: elasticsearchServiceMock.createElasticsearchClient(),
    logger: loggingSystemMock.createLogger(),
  };

  const verify = (ki: KnowledgeIndicator) => verifier.verify(ki, context);

  it('has the expected id and applies to every KI', () => {
    expect(verifier.id).toBe(SCHEMA_SHAPE_VERIFIER_ID);
    expect(verifier.applies({})).toBe(true);
    expect(verifier.applies(validKi)).toBe(true);
  });

  it('passes a well-formed KI', async () => {
    await expect(verify(validKi)).resolves.toEqual({ passed: true });
  });

  it('requires type and title', async () => {
    const outcome = await verify({ content: 'x' });
    expect(outcome.passed).toBe(false);
    if (outcome.passed) return;
    expect(outcome.reason).toContain('type is required');
    expect(outcome.reason).toContain('title is required');
  });

  it('rejects empty and over-long strings', async () => {
    const outcome = await verify({
      ...validKi,
      type: '   ',
      title: 'x'.repeat(MAX_KI_TITLE_LENGTH + 1),
    });
    expect(outcome.passed).toBe(false);
    if (outcome.passed) return;
    expect(outcome.reason).toContain('type must not be empty');
    expect(outcome.reason).toContain(`title exceeds ${MAX_KI_TITLE_LENGTH} characters`);
  });

  it('rejects malformed tags', async () => {
    const outcome = await verify({ ...validKi, tags: ['ok', '', 42 as unknown as string] });
    expect(outcome.passed).toBe(false);
    if (outcome.passed) return;
    expect(outcome.reason).toContain('tags must contain only non-empty strings');
  });

  it('rejects nested objects inside attributes', async () => {
    const outcome = await verify({
      ...validKi,
      attributes: { ...validKi.attributes, provenance: { plan: 'wf-1' } },
    });
    expect(outcome.passed).toBe(false);
    if (outcome.passed) return;
    expect(outcome.reason).toContain(
      'attributes.provenance must be a string, number, boolean or array of strings'
    );
  });

  it('validates confidence and expires_at', async () => {
    const outcome = await verify({
      ...validKi,
      attributes: { confidence: 1.5, expires_at: 'next month' },
    });
    expect(outcome.passed).toBe(false);
    if (outcome.passed) return;
    expect(outcome.reason).toContain('attributes.confidence must be a number between 0 and 1');
    expect(outcome.reason).toContain('attributes.expires_at must be an ISO-8601 date string');
  });

  it('accepts a numeric string confidence, as flattened attributes store keywords', async () => {
    await expect(verify({ ...validKi, attributes: { confidence: '0.75' } })).resolves.toEqual({
      passed: true,
    });
  });

  it('rejects a caller-supplied @timestamp', async () => {
    const outcome = await verify({ ...validKi, '@timestamp': '2026-01-01' } as KnowledgeIndicator);
    expect(outcome.passed).toBe(false);
    if (outcome.passed) return;
    expect(outcome.reason).toContain('@timestamp must not be set');
  });

  describe('type-specific attributes', () => {
    it('requires content and finding_id on targeted KI types', async () => {
      const outcome = await verify({ type: 'workaround', title: 'Use CATEGORIZE' });
      expect(outcome.passed).toBe(false);
      if (outcome.passed) return;
      expect(outcome.reason).toContain('a "workaround" KI must carry its answer in content');
      expect(outcome.reason).toContain('attributes.finding_id');
    });

    it('passes a targeted KI with content and finding_id', async () => {
      await expect(
        verify({
          type: 'constraint',
          title: 'message is text',
          content: 'STATS BY message fails; use CATEGORIZE(message).',
          attributes: { finding_id: 'f-1' },
        })
      ).resolves.toEqual({ passed: true });
    });

    it('requires attributes.esql on detection KIs', async () => {
      const outcome = await verify({ type: 'detection', title: 'Failed login burst' });
      expect(outcome.passed).toBe(false);
      if (outcome.passed) return;
      expect(outcome.reason).toContain('a "detection" KI must carry its query in attributes.esql');
    });
  });
});
