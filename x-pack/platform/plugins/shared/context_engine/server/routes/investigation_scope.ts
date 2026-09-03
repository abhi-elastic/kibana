/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import type { IRouter, KibanaRequest, Logger } from '@kbn/core/server';
import type { RouteSecurity } from '@kbn/core-http-server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import {
  AI_INDEX_INTERNAL_API_VERSION,
  MAX_AI_INDEX_SOURCE_VALUE_LENGTH,
  MAX_AI_INDEX_SOURCES,
  MAX_INVESTIGATION_TIME_RANGE_LENGTH,
  MAX_INVESTIGATION_TRACE_AGENT_ID_LENGTH,
  MAX_INVESTIGATION_TRACE_ESQL_LENGTH,
  sourcesPreviewPath,
  sourcesValidatePath,
  traceAgentsPath,
  traceScopePreviewPath,
} from '../../common/constants';
import { apiPrivileges } from '../../common/features';
import type {
  ListTraceAgentsResponse,
  PreviewSourcesResponse,
  TraceScopePreviewResponse,
  ValidateEsqlSourceResponse,
} from '../../common/http_api/investigation_scope';
import { validateInvestigationTimeBoundary } from '../../common/validation';
import { previewSources } from '../sources/preview_sources';
import { validateEsqlSource } from '../sources/validate_esql_source';
import { listTraceAgents, previewTraceScope } from '../traces/scope';
import { withContextEngineFeatureFlag } from './with_feature_flag';

const READ_SECURITY: RouteSecurity = {
  authz: { requiredPrivileges: [apiPrivileges.readContextEngine] },
};

const DEFAULT_SPACE_ID = 'default';

const resolveSpaceId = (spaces: SpacesPluginStart | undefined, request: KibanaRequest): string =>
  spaces?.spacesService.getSpaceId(request) ?? DEFAULT_SPACE_ID;

const esqlSchema = schema.string({
  minLength: 1,
  maxLength: MAX_AI_INDEX_SOURCE_VALUE_LENGTH,
  meta: { description: 'An ES|QL query.' },
});

const validateSourceBodySchema = schema.object({ esql: esqlSchema });

const previewSourcesBodySchema = schema.object({
  sources: schema.arrayOf(
    schema.oneOf([
      schema.object({ type: schema.literal('esql'), value: esqlSchema }),
      schema.object({
        type: schema.literal('connector'),
        value: schema.string({ minLength: 1, maxLength: MAX_AI_INDEX_SOURCE_VALUE_LENGTH }),
      }),
    ]),
    { maxSize: MAX_AI_INDEX_SOURCES }
  ),
});

const timeBoundarySchema = schema.string({
  maxLength: MAX_INVESTIGATION_TIME_RANGE_LENGTH,
  validate: validateInvestigationTimeBoundary,
});

const traceAgentsQuerySchema = schema.object({
  from: timeBoundarySchema,
  to: timeBoundarySchema,
});

const traceScopePreviewQuerySchema = schema.object(
  {
    from: timeBoundarySchema,
    to: timeBoundarySchema,
    agentId: schema.maybe(
      schema.string({ minLength: 1, maxLength: MAX_INVESTIGATION_TRACE_AGENT_ID_LENGTH })
    ),
    esql: schema.maybe(
      schema.string({ minLength: 1, maxLength: MAX_INVESTIGATION_TRACE_ESQL_LENGTH })
    ),
  },
  {
    validate: ({ agentId, esql }) =>
      agentId === undefined && esql === undefined ? 'agentId or esql is required' : undefined,
  }
);

/**
 * Deterministic helpers behind the investigation scope panel. All reads run as the current user:
 * the sources are user indices and the traces index is per space.
 */
export const registerInvestigationScopeRoutes = ({
  router,
  logger,
  getSpaces,
}: {
  router: IRouter;
  logger: Logger;
  getSpaces: () => Promise<SpacesPluginStart | undefined>;
}) => {
  router.versioned
    .post({
      path: sourcesValidatePath,
      security: READ_SECURITY,
      access: 'internal',
      summary: 'Validate an ES|QL source',
      description:
        'Runs the static ES|QL parser and a `| LIMIT 0` execution as the current user, returning every problem found.',
    })
    .addVersion(
      {
        version: AI_INDEX_INTERNAL_API_VERSION,
        validate: { request: { body: validateSourceBodySchema } },
      },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const esClient = (await ctx.core).elasticsearch.client.asCurrentUser;
        const body: ValidateEsqlSourceResponse = await validateEsqlSource(
          esClient,
          request.body.esql
        );
        return response.ok({ body });
      })
    );

  router.versioned
    .post({
      path: sourcesPreviewPath,
      security: READ_SECURITY,
      access: 'internal',
      summary: 'Preview AI index sources',
      description:
        'Validates each ES|QL source and returns its columns, a 5-row sample, resolved indices and a capped document count.',
    })
    .addVersion(
      {
        version: AI_INDEX_INTERNAL_API_VERSION,
        validate: { request: { body: previewSourcesBodySchema } },
      },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const esClient = (await ctx.core).elasticsearch.client.asCurrentUser;
        const body: PreviewSourcesResponse = await previewSources(esClient, request.body.sources);
        return response.ok({ body });
      })
    );

  router.versioned
    .get({
      path: traceAgentsPath,
      security: READ_SECURITY,
      access: 'internal',
      summary: 'List agents observed in traces',
      description:
        "Lists the raw agent ids found in the current space's Agent Builder traces for a time range.",
    })
    .addVersion(
      {
        version: AI_INDEX_INTERNAL_API_VERSION,
        validate: { request: { query: traceAgentsQuerySchema } },
      },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const esClient = (await ctx.core).elasticsearch.client.asCurrentUser;
        const spaceId = resolveSpaceId(await getSpaces(), request);
        const body: ListTraceAgentsResponse = await listTraceAgents({
          esClient,
          spaceId,
          range: request.query,
          logger,
        });
        return response.ok({ body });
      })
    );

  router.versioned
    .get({
      path: traceScopePreviewPath,
      security: READ_SECURITY,
      access: 'internal',
      summary: 'Preview a trace scope',
      description:
        'Counts requests, conversations, tool calls and failed tool calls for an agent (or a custom ES|QL scope) in a time range.',
    })
    .addVersion(
      {
        version: AI_INDEX_INTERNAL_API_VERSION,
        validate: { request: { query: traceScopePreviewQuerySchema } },
      },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const esClient = (await ctx.core).elasticsearch.client.asCurrentUser;
        const spaceId = resolveSpaceId(await getSpaces(), request);
        const { from, to, agentId, esql } = request.query;
        const body: TraceScopePreviewResponse = await previewTraceScope({
          esClient,
          spaceId,
          range: { from, to },
          agentId,
          esql,
        });
        return response.ok({ body });
      })
    );
};
