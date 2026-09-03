/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { AgentAccessControlMode } from '@kbn/agent-builder-common';
import { attachmentTools, platformCoreTools } from '@kbn/agent-builder-common/tools';
import { internalNamespaces } from '@kbn/agent-builder-common/base/namespaces';
import type { AgentBuilderPluginSetup, AgentBuilderPluginStart } from '@kbn/agent-builder-server';
import type { AgentTypeDefinition } from '@kbn/agent-builder-server/agents';
import {
  CONTEXT_ENGINE_AGENT_ID,
  CONTEXT_ENGINE_AGENT_TYPE_ID,
} from '../../../common/agent_builder_agents';
import {
  KI_AUTOMATION_GENERATION_SKILL_ID,
  KI_INVESTIGATION_SKILL_ID,
  KI_OPPORTUNITY_PLANNER_SKILL_ID,
} from '../../../common/agent_builder_skills';
import {
  CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID,
  CONTEXT_ENGINE_SAVE_AUTOMATION_TOOL_ID,
} from '../../../common/agent_builder_tools';
import instructions from './context_engine_agent_instructions.md.text';

const AGENT_BUILDER_TRACES_SKILL_ID = 'agent-builder-traces';

export const CONTEXT_ENGINE_AGENT_NAME = 'Context Engine agent';

const CONTEXT_ENGINE_AGENT_DESCRIPTION =
  'Investigates one AI index from its sources and agent traces, records findings for the user to decide on, agrees a context strategy, plans Knowledge Indicators, and generates the automations that produce them.';

/**
 * Code-owned base configuration every Context Engine agent inherits at read time: the shared
 * contract and stage router in `instructions`, an explicit tool list (no Elastic capabilities,
 * so `list_indices` and the generic search tools stay out of tool selection) and the three
 * Context Engine skills plus the traces skill for ad hoc trace questions.
 */
export const contextEngineAgentType = {
  id: CONTEXT_ENGINE_AGENT_TYPE_ID,
  name: CONTEXT_ENGINE_AGENT_NAME,
  description: CONTEXT_ENGINE_AGENT_DESCRIPTION,
  avatar_icon: 'indexMapping',
  baseConfiguration: {
    instructions,
    enable_elastic_capabilities: false,
    connector_ids: [],
    skill_ids: [
      KI_INVESTIGATION_SKILL_ID,
      KI_OPPORTUNITY_PLANNER_SKILL_ID,
      KI_AUTOMATION_GENERATION_SKILL_ID,
      AGENT_BUILDER_TRACES_SKILL_ID,
    ],
    tools: [
      {
        tool_ids: [
          platformCoreTools.executeEsql,
          platformCoreTools.getIndexMapping,
          platformCoreTools.getDocumentById,
          platformCoreTools.generateEsql,
          platformCoreTools.generateWorkflow,
          platformCoreTools.executeWorkflow,
          platformCoreTools.getWorkflowExecutionStatus,
          `${internalNamespaces.workflows}.validate_workflow`,
          `${internalNamespaces.workflows}.get_workflow`,
          `${internalNamespaces.workflows}.get_step_definitions`,
          `${internalNamespaces.workflows}.get_examples`,
          `${internalNamespaces.workflows}.get_connectors`,
          CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID,
          CONTEXT_ENGINE_SAVE_AUTOMATION_TOOL_ID,
          attachmentTools.read,
          attachmentTools.diff,
        ],
      },
    ],
  },
} as const satisfies AgentTypeDefinition;

export const registerContextEngineAgentType = (agentBuilder: AgentBuilderPluginSetup): void => {
  agentBuilder.agents.registerType(contextEngineAgentType);
};

/**
 * Create-if-absent install of the per-space Context Engine agent. Idempotent: an existing agent,
 * including one the user edited, is left untouched. The agent's own configuration is empty so
 * everything comes from the type's base configuration and ships with upgrades.
 */
export const ensureContextEngineAgent = async ({
  agentBuilder,
  spaceId,
}: {
  agentBuilder: AgentBuilderPluginStart;
  spaceId: string;
}): Promise<void> => {
  await agentBuilder.agents.ensure({
    spaceId,
    agent: {
      id: CONTEXT_ENGINE_AGENT_ID,
      type: CONTEXT_ENGINE_AGENT_TYPE_ID,
      name: CONTEXT_ENGINE_AGENT_NAME,
      description: CONTEXT_ENGINE_AGENT_DESCRIPTION,
      labels: ['context-engine', 'knowledge-indicators', 'investigation'],
      avatar_symbol: 'CE',
      access_control: { access_mode: AgentAccessControlMode.Public },
      configuration: {
        tools: [],
        skill_ids: [],
        connector_ids: [],
      },
    },
  });
};
