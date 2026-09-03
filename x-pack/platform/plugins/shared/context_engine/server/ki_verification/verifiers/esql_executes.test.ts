/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { errors } from '@elastic/elasticsearch';
import { elasticsearchServiceMock, loggingSystemMock } from '@kbn/core/server/mocks';
import type { KiVerifierContext } from '../types';
import { createEsqlExecutesVerifier, ESQL_EXECUTES_VERIFIER_ID } from './esql_executes';

const responseError = (type: string, reason: string, statusCode = 400) =>
  new errors.ResponseError({
    statusCode,
    body: { error: { type, reason, root_cause: [{ type, reason }] } },
    warnings: [],
    headers: {},
    meta: {} as never,
  });

describe('esql-executes verifier', () => {
  const verifier = createEsqlExecutesVerifier();
  let esClient: ReturnType<typeof elasticsearchServiceMock.createElasticsearchClient>;
  let context: KiVerifierContext;

  beforeEach(() => {
    esClient = elasticsearchServiceMock.createElasticsearchClient();
    context = { esClient, logger: loggingSystemMock.createLogger(), executeEsql: true };
  });

  it('has the expected id', () => {
    expect(verifier.id).toBe(ESQL_EXECUTES_VERIFIER_ID);
  });

  describe('applies', () => {
    it('is off unless the run opts in with executeEsql', () => {
      const ki = { attributes: { esql: 'FROM logs' } };
      expect(verifier.applies(ki)).toBe(false);
      expect(verifier.applies(ki, { ...context, executeEsql: false })).toBe(false);
      expect(verifier.applies(ki, { ...context, executeEsql: undefined })).toBe(false);
      expect(verifier.applies(ki, context)).toBe(true);
    });

    it('is false without an esql attribute even when opted in', () => {
      expect(verifier.applies({ attributes: { index: 'logs' } }, context)).toBe(false);
    });
  });

  it('runs each query with LIMIT 0 and passes when all execute', async () => {
    esClient.esql.query.mockResolvedValue({ columns: [], values: [] } as never);

    await expect(
      verifier.verify(
        { attributes: { esql: ['FROM logs-* | LIMIT 10', 'FROM cases | STATS c = COUNT(*)'] } },
        context
      )
    ).resolves.toEqual({ passed: true });

    expect(esClient.esql.query).toHaveBeenCalledTimes(2);
    expect(esClient.esql.query).toHaveBeenCalledWith(
      { query: 'FROM logs-* | LIMIT 10 | LIMIT 0', format: 'json' },
      { signal: undefined }
    );
  });

  it('skips parameterised templates the agent fills in at ask time', async () => {
    await expect(
      verifier.verify(
        { attributes: { esql: 'FROM cases | WHERE case_number == ?case_number | LIMIT 1' } },
        context
      )
    ).resolves.toEqual({ passed: true });
    expect(esClient.esql.query).not.toHaveBeenCalled();
  });

  it('reports the Elasticsearch error type and reason per failing query', async () => {
    esClient.esql.query
      .mockResolvedValueOnce({ columns: [], values: [] } as never)
      .mockRejectedValueOnce(responseError('verification_exception', 'Unknown column [messagee]'));

    const outcome = await verifier.verify(
      { attributes: { esql: ['FROM logs | LIMIT 1', 'FROM logs | KEEP messagee'] } },
      context
    );
    expect(outcome.passed).toBe(false);
    if (outcome.passed) return;
    expect(outcome.reason).toBe(
      'ES|QL query "FROM logs | KEEP messagee" failed to execute: verification_exception: Unknown column [messagee]'
    );
  });

  it('fails a malformed esql attribute without querying', async () => {
    const outcome = await verifier.verify({ attributes: { esql: [''] } }, context);
    expect(outcome.passed).toBe(false);
    if (outcome.passed) return;
    expect(outcome.reason).toContain('attributes.esql is not a well-formed query');
    expect(esClient.esql.query).not.toHaveBeenCalled();
  });

  it('rethrows non-response errors', async () => {
    const cause = new Error('socket hang up');
    esClient.esql.query.mockRejectedValue(cause);

    await expect(verifier.verify({ attributes: { esql: 'FROM logs' } }, context)).rejects.toBe(
      cause
    );
  });
});
