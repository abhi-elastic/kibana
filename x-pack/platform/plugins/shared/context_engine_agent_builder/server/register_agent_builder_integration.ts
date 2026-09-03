/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, Logger } from '@kbn/core/server';
import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import { apiPrivileges } from '@kbn/context-engine-plugin/common/features';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import { registerContextEngineAgentType } from './agent_builder/agent/context_engine_agent_type';
import { registerContextEngineSkills } from './agent_builder/skills';
import { registerAgentBuilderTools } from './agent_builder/tools';
import { registerAttachmentTypes } from './attachment_types';
import { registerEnsureAgentRoute } from './routes/ensure_agent';
import type {
  ContextEngineAgentBuilderPluginStart,
  ContextEngineAgentBuilderStartDependencies,
} from './types';

type WorkflowsManagementApi = WorkflowsServerPluginSetup['management'];

export const registerContextEngineAgentBuilderIntegration = ({
  coreSetup,
  logger,
  agentBuilder,
  workflowsManagement,
}: {
  coreSetup: CoreSetup<
    ContextEngineAgentBuilderStartDependencies,
    ContextEngineAgentBuilderPluginStart
  >;
  logger: Logger;
  agentBuilder: AgentBuilderPluginSetup;
  workflowsManagement: WorkflowsManagementApi;
}): void => {
  registerAttachmentTypes(agentBuilder);
  registerContextEngineAgentType(agentBuilder);
  registerContextEngineSkills(agentBuilder);

  registerEnsureAgentRoute({
    router: coreSetup.http.createRouter(),
    logger,
    getAgentBuilder: async () => {
      const [, startDeps] = await coreSetup.getStartServices();
      return startDeps.agentBuilder;
    },
    getSpaces: async () => {
      const [, startDeps] = await coreSetup.getStartServices();
      return startDeps.spaces;
    },
  });

  agentBuilder.agents.registerAiIndexResolver(async ({ ids, request }) => {
    const [, startDeps] = await coreSetup.getStartServices();
    const { contextEngine, security } = startDeps;

    // list() reads through the internal user, bypassing CE's API-layer authz, so re-apply CE's
    // read privilege for the requesting user. One space-aware check covers every id, matching
    // CE's own list route: the registry has no per-index scoping.
    const checkPrivileges = security.authz.checkPrivilegesDynamicallyWithRequest(request);
    const { hasAllRequested } = await checkPrivileges({
      kibana: [security.authz.actions.api.get(apiPrivileges.readContextEngine)],
    });
    if (!hasAllRequested) {
      return [];
    }

    const aiIndexService = contextEngine.getAiIndexService();
    const requestedIds = new Set(ids);
    const aiIndices = await aiIndexService.list();
    return aiIndices
      .filter((aiIndex) => requestedIds.has(aiIndex.id))
      .map((aiIndex) => ({
        id: aiIndex.id,
        esqlTarget: aiIndex.dest.value,
        description: aiIndex.description,
      }));
  });

  registerAgentBuilderTools({
    agentBuilder,
    getCoreStart: async () => {
      const [coreStart] = await coreSetup.getStartServices();
      return coreStart;
    },
    getSecurityStart: async () => {
      const [, startDeps] = await coreSetup.getStartServices();
      return startDeps.security;
    },
    getWorkflowsManagement: () => workflowsManagement,
    getAiIndexService: async () => {
      const [, startDeps] = await coreSetup.getStartServices();
      return startDeps.contextEngine.getAiIndexService();
    },
    getFindingsService: async (esClient) => {
      const [, startDeps] = await coreSetup.getStartServices();
      return startDeps.contextEngine.getFindingsService(esClient);
    },
  });
};
