/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import { isResponseError } from '@kbn/es-errors';
import { getIndexPatternFromESQLQuery } from '@kbn/esql-utils';
import { SOURCE_PREVIEW_COUNT_CAP, SOURCE_PREVIEW_SAMPLE_SIZE } from '../../common/constants';
import type { AiIndexSource } from '../../common/http_api/ai_indices';
import type {
  EsqlSourcePreview,
  PreviewSourcesResponse,
  SourcePreview,
} from '../../common/http_api/investigation_scope';
import { validateEsqlSource } from './validate_esql_source';

interface EsqlQueryResult {
  columns: Array<{ name: string }>;
  values: unknown[][];
}

const CONNECTOR_SKIP_REASON = 'Connector sources are not investigated in this version.';

const resolveIndices = async (
  esClient: ElasticsearchClient,
  indexPattern: string
): Promise<string[]> => {
  if (indexPattern.length === 0) {
    return [];
  }
  try {
    const resolved = await esClient.indices.resolveIndex({
      name: indexPattern,
      expand_wildcards: ['open'],
    });
    return [
      ...resolved.indices.map((index) => index.name),
      ...resolved.data_streams.map((dataStream) => dataStream.name),
    ].sort();
  } catch (error) {
    if (isResponseError(error) && error.statusCode === 404) {
      return [];
    }
    throw error;
  }
};

const countDocuments = async (
  esClient: ElasticsearchClient,
  indexPattern: string
): Promise<{ count: number; capped: boolean } | undefined> => {
  if (indexPattern.length === 0) {
    return undefined;
  }
  try {
    const { count } = await esClient.count({
      index: indexPattern,
      terminate_after: SOURCE_PREVIEW_COUNT_CAP,
      ignore_unavailable: true,
      allow_no_indices: true,
    });
    // `terminate_after` is applied per shard, so hitting the cap means the total is at least this.
    return { count, capped: count >= SOURCE_PREVIEW_COUNT_CAP };
  } catch (error) {
    if (isResponseError(error)) {
      return undefined;
    }
    throw error;
  }
};

const previewEsqlSource = async (
  esClient: ElasticsearchClient,
  source: AiIndexSource
): Promise<EsqlSourcePreview> => {
  const validation = await validateEsqlSource(esClient, source.value);
  if (!validation.valid) {
    return {
      source,
      status: 'invalid',
      columns: [],
      rows: [],
      resolved_indices: [],
      count_capped: false,
      errors: validation.errors,
    };
  }

  const query = source.value.trim();
  const indexPattern = getIndexPatternFromESQLQuery(query);
  const [sample, resolvedIndices, docCount] = await Promise.all([
    esClient.esql.query({
      query: `${query} | LIMIT ${SOURCE_PREVIEW_SAMPLE_SIZE}`,
      format: 'json',
    }) as unknown as Promise<EsqlQueryResult>,
    resolveIndices(esClient, indexPattern),
    countDocuments(esClient, indexPattern),
  ]);

  return {
    source,
    status: 'ok',
    columns: sample.columns.map((column) => column.name),
    rows: sample.values,
    resolved_indices: resolvedIndices,
    ...(docCount !== undefined ? { doc_count: docCount.count } : {}),
    count_capped: docCount?.capped ?? false,
    errors: [],
  };
};

/**
 * Deterministic preview of the configured sources for the investigation scope panel: validity,
 * columns, a 5-row sample, resolved indices and a capped document count per ES|QL source. It
 * never judges usefulness; connector sources are reported as skipped.
 */
export const previewSources = async (
  esClient: ElasticsearchClient,
  sources: AiIndexSource[]
): Promise<PreviewSourcesResponse> => {
  const previews: SourcePreview[] = await Promise.all(
    sources.map(async (source) =>
      source.type === 'esql'
        ? previewEsqlSource(esClient, source)
        : { source, status: 'skipped' as const, reason: CONNECTOR_SKIP_REASON }
    )
  );

  const okPreviews = previews.filter(
    (preview): preview is EsqlSourcePreview => preview.status === 'ok'
  );
  const resolvedIndices = [...new Set(okPreviews.flatMap((preview) => preview.resolved_indices))];

  return {
    sources: previews,
    summary: {
      valid_sources: okPreviews.length,
      invalid_sources: previews.filter((preview) => preview.status === 'invalid').length,
      skipped_sources: previews.filter((preview) => preview.status === 'skipped').length,
      resolved_indices: resolvedIndices.sort(),
      doc_count: okPreviews.reduce((total, preview) => total + (preview.doc_count ?? 0), 0),
      count_capped: okPreviews.some((preview) => preview.count_capped),
    },
  };
};
