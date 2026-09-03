/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import type { ElasticsearchClient, IRouter, Logger } from '@kbn/core/server';
import type { RouteSecurity } from '@kbn/core-http-server';
import {
  AI_INDEX_INTERNAL_API_VERSION,
  MAX_AI_INDEX_ID_LENGTH,
  MAX_AI_INDEX_SOURCE_VALUE_LENGTH,
  MAX_AI_INDEX_SOURCES,
  MAX_FINDINGS_PAGE_SIZE,
  MAX_INVESTIGATION_TIME_RANGE_LENGTH,
  MAX_INVESTIGATION_TRACE_AGENT_ID_LENGTH,
  MAX_INVESTIGATION_TRACE_ESQL_LENGTH,
  MAX_INVESTIGATIONS_PAGE_SIZE,
  aiIndexFindingsPath,
  aiIndexInvestigationsPath,
  aiIndexLatestInvestigationPath,
  investigationByIdPath,
} from '../../common/constants';
import { apiPrivileges } from '../../common/features';
import type {
  FindingStatus,
  GetLatestInvestigationResponse,
  InvestigationScopeSnapshot,
  ListFindingsResponse,
  ListInvestigationsResponse,
  StartInvestigationResponse,
} from '../../common/http_api/findings';
import { InvestigationNotFoundError } from '../findings/errors';
import type { FindingsServiceApi } from '../findings/service';
import { withContextEngineFeatureFlag } from './with_feature_flag';

const READ_SECURITY: RouteSecurity = {
  authz: { requiredPrivileges: [apiPrivileges.readContextEngine] },
};
const WRITE_SECURITY: RouteSecurity = {
  authz: { requiredPrivileges: [apiPrivileges.writeContextEngine] },
};

const findingStatusSchema = schema.oneOf([
  schema.literal('open'),
  schema.literal('suppressed'),
  schema.literal('decided'),
  schema.literal('planned'),
  schema.literal('generated'),
]);

const aiIndexParamsSchema = schema.object({
  aiIndexId: schema.string({ minLength: 1, maxLength: MAX_AI_INDEX_ID_LENGTH }),
});

const investigationParamsSchema = schema.object({
  investigationId: schema.string({ minLength: 1, maxLength: 64 }),
});

const listFindingsQuerySchema = schema.object({
  investigationId: schema.maybe(schema.string({ minLength: 1, maxLength: 64 })),
  status: schema.maybe(
    schema.oneOf([findingStatusSchema, schema.arrayOf(findingStatusSchema, { maxSize: 5 })])
  ),
  from: schema.number({ min: 0, defaultValue: 0 }),
  size: schema.number({ min: 1, max: MAX_FINDINGS_PAGE_SIZE, defaultValue: 50 }),
});

const listInvestigationsQuerySchema = schema.object({
  size: schema.number({ min: 1, max: MAX_INVESTIGATIONS_PAGE_SIZE, defaultValue: 10 }),
});

const scopeSnapshotSchema = schema.object({
  mode: schema.oneOf([schema.literal('sources'), schema.literal('traces'), schema.literal('both')]),
  sources: schema.arrayOf(
    schema.object({
      type: schema.oneOf([schema.literal('esql'), schema.literal('connector')]),
      value: schema.string({ minLength: 1, maxLength: MAX_AI_INDEX_SOURCE_VALUE_LENGTH }),
    }),
    { maxSize: MAX_AI_INDEX_SOURCES }
  ),
  source_summary: schema.maybe(
    schema.object({
      valid_sources: schema.number({ min: 0 }),
      resolved_indices: schema.arrayOf(schema.string({ maxLength: 512 }), { maxSize: 500 }),
      doc_count: schema.number({ min: 0 }),
      count_capped: schema.boolean(),
    })
  ),
  trace: schema.maybe(
    schema.object({
      agent_id: schema.maybe(
        schema.string({ minLength: 1, maxLength: MAX_INVESTIGATION_TRACE_AGENT_ID_LENGTH })
      ),
      from: schema.string({ minLength: 1, maxLength: MAX_INVESTIGATION_TIME_RANGE_LENGTH }),
      to: schema.string({ minLength: 1, maxLength: MAX_INVESTIGATION_TIME_RANGE_LENGTH }),
      custom_esql: schema.maybe(
        schema.string({ minLength: 1, maxLength: MAX_INVESTIGATION_TRACE_ESQL_LENGTH })
      ),
      counts: schema.maybe(
        schema.object({
          requests: schema.number({ min: 0 }),
          conversations: schema.number({ min: 0 }),
          tool_calls: schema.number({ min: 0 }),
          failed_tool_calls: schema.number({ min: 0 }),
        })
      ),
    })
  ),
});

const startInvestigationBodySchema = schema.object({
  scope: scopeSnapshotSchema,
});

/**
 * Read side of the findings store for the Overview page, plus the one write the page performs:
 * starting a run so the attachment carries a real `investigation_id` and the prior decisions.
 * Everything else is written by the `record_investigation` tool inside the conversation.
 */
export const registerFindingsRoutes = ({
  router,
  logger,
  getFindingsService,
}: {
  router: IRouter;
  logger: Logger;
  getFindingsService: (esClient: ElasticsearchClient) => FindingsServiceApi;
}) => {
  router.versioned
    .post({
      path: aiIndexInvestigationsPath,
      security: WRITE_SECURITY,
      access: 'internal',
      summary: 'Start a guided investigation',
      description:
        'Records a new investigation at stage `scoped` and returns the prior dismiss / known-issue decisions for the AI index.',
    })
    .addVersion(
      {
        version: AI_INDEX_INTERNAL_API_VERSION,
        validate: {
          request: { params: aiIndexParamsSchema, body: startInvestigationBodySchema },
        },
      },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const core = await ctx.core;
        const service = getFindingsService(core.elasticsearch.client.asCurrentUser);
        const { aiIndexId } = request.params;
        const startedBy = core.security.authc.getCurrentUser()?.username;
        const [investigation, priorDecisions] = await Promise.all([
          service.startInvestigation({
            aiIndexId,
            scope: request.body.scope as InvestigationScopeSnapshot,
            startedBy,
          }),
          service.priorDecisions(aiIndexId),
        ]);
        logger.debug(
          `Started investigation '${investigation.investigation_id}' for AI index '${aiIndexId}'`
        );
        const body: StartInvestigationResponse = { investigation, prior_decisions: priorDecisions };
        return response.ok({ body });
      })
    );

  router.versioned
    .get({
      path: aiIndexInvestigationsPath,
      security: READ_SECURITY,
      access: 'internal',
      summary: 'List investigations for an AI index',
    })
    .addVersion(
      {
        version: AI_INDEX_INTERNAL_API_VERSION,
        validate: {
          request: { params: aiIndexParamsSchema, query: listInvestigationsQuerySchema },
        },
      },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const service = getFindingsService((await ctx.core).elasticsearch.client.asCurrentUser);
        const body: ListInvestigationsResponse = await service.listInvestigations(
          request.params.aiIndexId,
          { size: request.query.size }
        );
        return response.ok({ body });
      })
    );

  router.versioned
    .get({
      path: aiIndexLatestInvestigationPath,
      security: READ_SECURITY,
      access: 'internal',
      summary: 'Latest investigation and its findings',
      description:
        'What the Overview page shows after a reload instead of chat events: the newest run and the findings it recorded.',
    })
    .addVersion(
      {
        version: AI_INDEX_INTERNAL_API_VERSION,
        validate: { request: { params: aiIndexParamsSchema } },
      },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const service = getFindingsService((await ctx.core).elasticsearch.client.asCurrentUser);
        const investigation = await service.latestInvestigation(request.params.aiIndexId);
        const findings = investigation
          ? (
              await service.listFindings({
                aiIndexId: request.params.aiIndexId,
                investigationId: investigation.investigation_id,
                size: MAX_FINDINGS_PAGE_SIZE,
              })
            ).items
          : [];
        const body: GetLatestInvestigationResponse = { investigation, findings };
        return response.ok({ body });
      })
    );

  router.versioned
    .get({
      path: investigationByIdPath,
      security: READ_SECURITY,
      access: 'internal',
      summary: 'Get an investigation',
    })
    .addVersion(
      {
        version: AI_INDEX_INTERNAL_API_VERSION,
        validate: { request: { params: investigationParamsSchema } },
      },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const service = getFindingsService((await ctx.core).elasticsearch.client.asCurrentUser);
        const investigation = await service.getInvestigation(request.params.investigationId);
        if (!investigation) {
          return response.notFound({
            body: {
              message: new InvestigationNotFoundError(request.params.investigationId).message,
            },
          });
        }
        return response.ok({ body: investigation });
      })
    );

  router.versioned
    .get({
      path: aiIndexFindingsPath,
      security: READ_SECURITY,
      access: 'internal',
      summary: 'List findings for an AI index',
    })
    .addVersion(
      {
        version: AI_INDEX_INTERNAL_API_VERSION,
        validate: { request: { params: aiIndexParamsSchema, query: listFindingsQuerySchema } },
      },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const service = getFindingsService((await ctx.core).elasticsearch.client.asCurrentUser);
        const { investigationId, status, from, size } = request.query;
        const statuses: FindingStatus[] | undefined =
          status === undefined ? undefined : Array.isArray(status) ? status : [status];
        const body: ListFindingsResponse = await service.listFindings({
          aiIndexId: request.params.aiIndexId,
          investigationId,
          status: statuses,
          from,
          size,
        });
        return response.ok({ body });
      })
    );
};
