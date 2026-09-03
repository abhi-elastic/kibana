/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  BulkResponse,
  SearchRequest,
  SearchResponse,
} from '@elastic/elasticsearch/lib/api/types';
import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import type { StorageSchema } from '@kbn/storage-adapter';
import { BulkOperationError, types } from '@kbn/storage-adapter';
import type { Finding, InvestigationRecord } from '../../common/http_api/findings';
import { FINDINGS_INDEX } from '../../common/http_api/findings';

export const FINDINGS_INDEX_TEMPLATE = `${FINDINGS_INDEX}-index-template`;

export type FindingsDocument = Finding | InvestigationRecord;

const decisionProperties = {
  properties: {
    decision: types.keyword({}),
    reason: types.text({}),
    decided_at: types.date({}),
    decided_by: types.keyword({}),
    investigation_id: types.keyword({}),
  },
};

/**
 * Mapping for the global findings index. Every field the UI filters or sorts on is indexed; the
 * agent-authored bodies (`evidence`, `measurements`, `strategy`, `plan`, `scope`) are kept in
 * `_source` only, for the same reason improvements keep `payload` unindexed: they are free-form,
 * often several kilobytes, and nothing queries inside them.
 */
export const findingsSchema = {
  properties: {
    doc_type: types.keyword({}),
    '@timestamp': types.date({}),
    ai_index_id: types.keyword({}),
    investigation_id: types.keyword({}),
    // finding
    finding_id: types.keyword({}),
    kind: types.keyword({}),
    evidence_type: types.keyword({}),
    title: types.text({}),
    summary: types.text({}),
    subject: types.keyword({}),
    confidence: types.keyword({}),
    impact: types.keyword({}),
    ki_usefulness: types.keyword({}),
    prevalence: types.object({
      properties: {
        affected_requests: types.long({}),
        sampled_requests: types.long({}),
        affected_fraction: types.double({}),
        distinct_conversations: types.long({}),
        counted_over: types.keyword({}),
      },
    }),
    scale: types.object({
      properties: {
        affected_units: types.long({}),
        total_units: types.long({}),
        unit_kind: types.keyword({}),
      },
    }),
    evidence: types.object({ enabled: false }),
    first_seen_at: types.date({}),
    last_seen_at: types.date({}),
    seen_count: types.long({}),
    ki_eligible: types.boolean({}),
    gate: types.object({
      properties: {
        rule: types.keyword({}),
        passed: types.boolean({}),
        reason: types.text({}),
      },
    }),
    status: types.keyword({}),
    suppressed_by: types.object(decisionProperties),
    decision: types.object(decisionProperties),
    outcome: types.object({
      properties: {
        ki_ids: types.keyword({}),
        workflow_ids: types.keyword({}),
        signal_ki_id: types.keyword({}),
        updated_at: types.date({}),
      },
    }),
    // investigation
    stage: types.keyword({}),
    started_at: types.date({}),
    updated_at: types.date({}),
    started_by: types.keyword({}),
    scope: types.object({ enabled: false }),
    access_mode: types.keyword({}),
    probes: types.object({ enabled: false }),
    measurements: types.object({ enabled: false }),
    finding_ids: types.keyword({}),
    strategy: types.object({ enabled: false }),
    plan: types.object({ enabled: false }),
    run_summary: types.object({ enabled: false }),
  },
} satisfies StorageSchema;

/**
 * Installs the index template as Kibana at start; the index itself is created by the first user
 * write, so no grant on the internal user is needed (same split as the improvements store).
 */
export const installFindingsIndexTemplate = async ({
  esClient,
  logger,
}: {
  esClient: ElasticsearchClient;
  logger: Logger;
}): Promise<void> => {
  await esClient.indices.putIndexTemplate({
    name: FINDINGS_INDEX_TEMPLATE,
    index_patterns: [FINDINGS_INDEX],
    template: {
      mappings: { dynamic: 'strict', ...findingsSchema },
    },
  });
  logger.debug(`Installed index template '${FINDINGS_INDEX_TEMPLATE}'`);
};

export interface FindingsBulkOperation {
  index: { _id: string; document: FindingsDocument };
}

export interface FindingsClient {
  search<T extends FindingsDocument = FindingsDocument>(
    request: Omit<SearchRequest, 'index'>
  ): Promise<SearchResponse<T>>;
  bulk(request: {
    operations: FindingsBulkOperation[];
    refresh?: 'wait_for' | boolean;
  }): Promise<BulkResponse>;
}

/** Binds the findings index to a request-scoped client so Elasticsearch authorizes the caller. */
export const createFindingsClient = (esClient: ElasticsearchClient): FindingsClient => ({
  search: <T extends FindingsDocument = FindingsDocument>(request: Omit<SearchRequest, 'index'>) =>
    esClient.search<T>({
      index: FINDINGS_INDEX,
      ignore_unavailable: true,
      ...request,
    }),

  bulk: async ({ operations, refresh }) => {
    const response = await esClient.bulk({
      index: FINDINGS_INDEX,
      refresh,
      operations: operations.flatMap(({ index: { _id, document } }) => [
        { index: { _id } },
        document,
      ]),
    });

    if (response.errors) {
      throw new BulkOperationError(
        `Bulk operation on '${FINDINGS_INDEX}' failed: ${JSON.stringify(
          response.items.filter((item) => Object.values(item).some((action) => action?.error))
        )}`,
        response
      );
    }

    return response;
  },
});
