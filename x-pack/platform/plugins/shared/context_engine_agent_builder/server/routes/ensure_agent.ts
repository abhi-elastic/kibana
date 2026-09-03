/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { IRouter, KibanaRequest, Logger } from '@kbn/core/server';
import type { AgentBuilderPluginStart } from '@kbn/agent-builder-server';
import { apiPrivileges } from '@kbn/context-engine-plugin/common/features';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import {
  CONTEXT_ENGINE_AGENT_API_VERSION,
  CONTEXT_ENGINE_AGENT_ENSURE_PATH,
  CONTEXT_ENGINE_AGENT_ID,
  type EnsureContextEngineAgentResponse,
} from '../../common/agent_builder_agents';
import { ensureContextEngineAgent } from '../agent_builder/agent/context_engine_agent_type';

const DEFAULT_SPACE_ID = 'default';

export interface EnsureAgentRouteDependencies {
  router: IRouter;
  logger: Logger;
  getAgentBuilder: () => Promise<AgentBuilderPluginStart>;
  getSpaces: () => Promise<SpacesPluginStart | undefined>;
}

const resolveSpaceId = (spaces: SpacesPluginStart | undefined, request: KibanaRequest): string =>
  spaces?.spacesService.getSpaceId(request) ?? DEFAULT_SPACE_ID;

/**
 * Lazily installs the Context Engine agent in the caller's space. Called by the Overview page
 * before `openChat({ agentId })`; create-if-absent, so a user's edits to the agent are kept.
 */
export const registerEnsureAgentRoute = ({
  router,
  logger,
  getAgentBuilder,
  getSpaces,
}: EnsureAgentRouteDependencies): void => {
  router.versioned
    .post({
      path: CONTEXT_ENGINE_AGENT_ENSURE_PATH,
      access: 'internal',
      security: { authz: { requiredPrivileges: [apiPrivileges.writeContextEngine] } },
      summary: 'Ensure the Context Engine agent exists in this space',
    })
    .addVersion(
      { version: CONTEXT_ENGINE_AGENT_API_VERSION, validate: false },
      async (_ctx, request, response) => {
        const [agentBuilder, spaces] = await Promise.all([getAgentBuilder(), getSpaces()]);
        const spaceId = resolveSpaceId(spaces, request);
        await ensureContextEngineAgent({ agentBuilder, spaceId });
        logger.debug(
          `Ensured Context Engine agent '${CONTEXT_ENGINE_AGENT_ID}' in space '${spaceId}'`
        );
        const body: EnsureContextEngineAgentResponse = {
          agent_id: CONTEXT_ENGINE_AGENT_ID,
          space_id: spaceId,
        };
        return response.ok({ body });
      }
    );
};
