/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import type { CoreStart, ElasticsearchClient } from '@kbn/core/server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import type { AiIndexService } from '@kbn/context-engine-plugin/server/ai_indices/service';
import type { FindingsServiceApi } from '@kbn/context-engine-plugin/server/findings/service';
import { createRecordInvestigationTool } from './record_investigation/tool';
import { createSaveAutomationTool } from './save_automation/tool';

type WorkflowsManagementApi = WorkflowsServerPluginSetup['management'];

export interface AgentBuilderToolDependencies {
  getAiIndexService: () => Promise<AiIndexService>;
  getFindingsService: (esClient: ElasticsearchClient) => Promise<FindingsServiceApi>;
  getCoreStart: () => Promise<CoreStart>;
  getSecurityStart: () => Promise<SecurityPluginStart | undefined>;
  getWorkflowsManagement: () => WorkflowsManagementApi;
}

export const registerAgentBuilderTools = ({
  agentBuilder,
  getAiIndexService,
  getFindingsService,
  getCoreStart,
  getSecurityStart,
  getWorkflowsManagement,
}: AgentBuilderToolDependencies & { agentBuilder: AgentBuilderPluginSetup }): void => {
  agentBuilder.tools.register(
    createSaveAutomationTool({
      getAiIndexService,
      getFindingsService,
      getCoreStart,
      getSecurityStart,
      getWorkflowsManagement,
    })
  );
  agentBuilder.tools.register(
    createRecordInvestigationTool({ getCoreStart, getSecurityStart, getFindingsService })
  );
};
