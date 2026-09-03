/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { errors } from '@elastic/elasticsearch';
import type { DiagnosticResult } from '@elastic/elasticsearch';
import { elasticsearchServiceMock } from '@kbn/core/server/mocks';
import { InvalidEsqlSourceError } from '../ai_indices/errors';
import { assertValidEsqlSources, validateEsqlSource } from './validate_esql_source';

const createEsError = (statusCode: number, type: string, reason: string) =>
  new errors.ResponseError({
    statusCode,
    body: { error: { type, reason, root_cause: [{ type, reason }] } },
    warnings: null,
    headers: {},
    meta: {} as DiagnosticResult['meta'],
  } as DiagnosticResult);

describe('validateEsqlSource', () => {
  let esClient: ReturnType<typeof elasticsearchServiceMock.createElasticsearchClient>;

  beforeEach(() => {
    esClient = elasticsearchServiceMock.createElasticsearchClient();
  });

  it('rejects an empty query without touching Elasticsearch', async () => {
    await expect(validateEsqlSource(esClient, '   ')).resolves.toEqual({
      valid: false,
      errors: [{ type: 'static', message: 'ES|QL query must not be empty' }],
    });
    expect(esClient.esql.query).not.toHaveBeenCalled();
  });

  it('reports parser errors with positions and skips execution', async () => {
    const result = await validateEsqlSource(esClient, 'FROM logs | WHERE');

    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error('expected an invalid result');
    }
    expect(result.errors[0]).toEqual(
      expect.objectContaining({
        type: 'static',
        position: expect.objectContaining({ min: expect.any(Number) }),
      })
    );
    expect(esClient.esql.query).not.toHaveBeenCalled();
  });

  it('executes the query with LIMIT 0 and passes when Elasticsearch accepts it', async () => {
    esClient.esql.query.mockResolvedValue({ columns: [], values: [] } as never);

    await expect(validateEsqlSource(esClient, ' FROM logs-* | LIMIT 10 ')).resolves.toEqual({
      valid: true,
    });
    expect(esClient.esql.query).toHaveBeenCalledWith({
      query: 'FROM logs-* | LIMIT 10 | LIMIT 0',
      format: 'json',
    });
  });

  it('surfaces verification exceptions (unknown index or field) from execution', async () => {
    esClient.esql.query.mockRejectedValue(
      createEsError(400, 'verification_exception', 'Unknown index [nope]')
    );

    await expect(validateEsqlSource(esClient, 'FROM nope')).resolves.toEqual({
      valid: false,
      errors: [{ type: 'verification_exception', message: 'Unknown index [nope]' }],
    });
  });

  it('surfaces security exceptions from execution', async () => {
    esClient.esql.query.mockRejectedValue(
      createEsError(403, 'security_exception', 'action [indices:data/read/esql] is unauthorized')
    );

    const result = await validateEsqlSource(esClient, 'FROM secret');
    expect(result).toMatchObject({ valid: false, errors: [{ type: 'security_exception' }] });
  });

  it('rethrows non-Elasticsearch failures', async () => {
    esClient.esql.query.mockRejectedValue(new Error('socket hang up'));

    await expect(validateEsqlSource(esClient, 'FROM logs')).rejects.toThrow('socket hang up');
  });
});

describe('assertValidEsqlSources', () => {
  let esClient: ReturnType<typeof elasticsearchServiceMock.createElasticsearchClient>;

  beforeEach(() => {
    esClient = elasticsearchServiceMock.createElasticsearchClient();
    esClient.esql.query.mockResolvedValue({ columns: [], values: [] } as never);
  });

  it('ignores connector sources and blank ES|QL placeholders', async () => {
    await expect(
      assertValidEsqlSources(esClient, [
        { type: 'connector', value: 'connector-1' },
        { type: 'esql', value: '' },
      ])
    ).resolves.toBeUndefined();
    expect(esClient.esql.query).not.toHaveBeenCalled();
  });

  it('throws InvalidEsqlSourceError naming the failing source', async () => {
    esClient.esql.query.mockRejectedValue(
      createEsError(400, 'verification_exception', 'Unknown index [nope]')
    );

    await expect(
      assertValidEsqlSources(esClient, [{ type: 'esql', value: 'FROM nope' }])
    ).rejects.toThrow(InvalidEsqlSourceError);
    await expect(
      assertValidEsqlSources(esClient, [{ type: 'esql', value: 'FROM nope' }])
    ).rejects.toThrow(/"FROM nope" is invalid: Unknown index \[nope\]/);
  });
});
