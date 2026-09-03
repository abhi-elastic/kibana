/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { errors } from '@elastic/elasticsearch';
import { elasticsearchServiceMock, loggingSystemMock } from '@kbn/core/server/mocks';
import type { KiVerifierContext } from '../types';
import { createIndexExistsVerifier, INDEX_EXISTS_VERIFIER_ID } from './index_exists';

const resolved = ({
  indices = [] as string[],
  aliases = [] as string[],
  dataStreams = [] as string[],
} = {}) => ({
  indices: indices.map((name) => ({ name, attributes: ['open'] })),
  aliases: aliases.map((name) => ({ name, indices: ['backing'] })),
  data_streams: dataStreams.map((name) => ({
    name,
    backing_indices: ['.ds-1'],
    timestamp_field: '@timestamp',
  })),
});

describe('index-exists verifier', () => {
  const verifier = createIndexExistsVerifier();
  let esClient: ReturnType<typeof elasticsearchServiceMock.createElasticsearchClient>;
  let context: KiVerifierContext;

  beforeEach(() => {
    esClient = elasticsearchServiceMock.createElasticsearchClient();
    context = { esClient, logger: loggingSystemMock.createLogger() };
  });

  it('has the expected id and applies only when attributes.index is set', () => {
    expect(verifier.id).toBe(INDEX_EXISTS_VERIFIER_ID);
    expect(verifier.applies({ title: 'x' })).toBe(false);
    expect(verifier.applies({ attributes: { esql: 'FROM x' } })).toBe(false);
    expect(verifier.applies({ attributes: { index: 'logs-*' } })).toBe(true);
    expect(verifier.applies({ attributes: { index: '' } })).toBe(true);
  });

  it('passes when the index resolves to an open index', async () => {
    esClient.indices.resolveIndex.mockResolvedValue(resolved({ indices: ['logs-app-000001'] }));

    await expect(verifier.verify({ attributes: { index: 'logs-app' } }, context)).resolves.toEqual({
      passed: true,
    });
    expect(esClient.indices.resolveIndex).toHaveBeenCalledWith(
      { name: 'logs-app', expand_wildcards: ['open'] },
      { signal: undefined }
    );
  });

  it('accepts aliases and data streams as targets', async () => {
    esClient.indices.resolveIndex
      .mockResolvedValueOnce(resolved({ aliases: ['cases'] }))
      .mockResolvedValueOnce(resolved({ dataStreams: ['logs-app-default'] }));

    await expect(
      verifier.verify({ attributes: { index: ['cases', 'logs-app-default'] } }, context)
    ).resolves.toEqual({ passed: true });
  });

  it('fails and names every pattern that resolves to nothing', async () => {
    esClient.indices.resolveIndex
      .mockResolvedValueOnce(resolved())
      .mockResolvedValueOnce(resolved({ indices: ['present'] }))
      .mockRejectedValueOnce(
        new errors.ResponseError({
          statusCode: 404,
          body: { error: { type: 'index_not_found_exception' } },
          warnings: [],
          headers: {},
          meta: {} as never,
        })
      );

    const outcome = await verifier.verify(
      { attributes: { index: ['gone-*', 'present', 'missing'] } },
      context
    );
    expect(outcome.passed).toBe(false);
    if (outcome.passed) return;
    expect(outcome.reason).toBe(
      'attributes.index does not resolve to any open index, alias or data stream: gone-*, missing'
    );
  });

  it('rejects an empty or malformed index attribute', async () => {
    const outcome = await verifier.verify({ attributes: { index: ['logs', ' '] } }, context);
    expect(outcome.passed).toBe(false);
    if (outcome.passed) return;
    expect(outcome.reason).toContain('attributes.index must be a non-empty index name');
    expect(esClient.indices.resolveIndex).not.toHaveBeenCalled();
  });

  it('rethrows non-404 errors so the service records them as failures', async () => {
    const cause = new errors.ResponseError({
      statusCode: 403,
      body: { error: { type: 'security_exception' } },
      warnings: [],
      headers: {},
      meta: {} as never,
    });
    esClient.indices.resolveIndex.mockRejectedValue(cause);

    await expect(verifier.verify({ attributes: { index: 'secret' } }, context)).rejects.toBe(cause);
  });
});
