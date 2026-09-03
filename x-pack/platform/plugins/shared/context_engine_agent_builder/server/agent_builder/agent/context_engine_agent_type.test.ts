/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { isAllowedAgentType } from '@kbn/agent-builder-server/allow_lists';
import type { AgentBuilderPluginStart } from '@kbn/agent-builder-server';
import { CONTEXT_ENGINE_AGENT_ID } from '../../../common/agent_builder_agents';
import {
  KI_AUTOMATION_GENERATION_SKILL_ID,
  KI_INVESTIGATION_SKILL_ID,
  KI_OPPORTUNITY_PLANNER_SKILL_ID,
} from '../../../common/agent_builder_skills';
import {
  CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID,
  CONTEXT_ENGINE_SAVE_AUTOMATION_TOOL_ID,
} from '../../../common/agent_builder_tools';
import { contextEngineAgentType, ensureContextEngineAgent } from './context_engine_agent_type';

describe('contextEngineAgentType', () => {
  it('is allow-listed and keeps Elastic capabilities off', () => {
    expect(isAllowedAgentType(contextEngineAgentType.id)).toBe(true);
    expect(contextEngineAgentType.baseConfiguration.enable_elastic_capabilities).toBe(false);
  });

  it('lists the three Context Engine skills and the write tools explicitly', () => {
    const { skill_ids: skillIds, tools } = contextEngineAgentType.baseConfiguration;
    expect(skillIds).toEqual(
      expect.arrayContaining([
        KI_INVESTIGATION_SKILL_ID,
        KI_OPPORTUNITY_PLANNER_SKILL_ID,
        KI_AUTOMATION_GENERATION_SKILL_ID,
      ])
    );
    const toolIds = tools.flatMap((selection) => selection.tool_ids);
    expect(toolIds).toEqual(
      expect.arrayContaining([
        CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID,
        CONTEXT_ENGINE_SAVE_AUTOMATION_TOOL_ID,
        'platform.core.execute_esql',
        'platform.core.get_index_mapping',
      ])
    );
    expect(toolIds).not.toContain('platform.core.list_indices');
  });

  it('carries the stage router in its base instructions', () => {
    const { instructions } = contextEngineAgentType.baseConfiguration;
    for (const stage of [
      'scoped',
      'findings_recorded',
      'decisions_recorded',
      'strategy_approved',
      'planned',
      'generated',
    ]) {
      expect(instructions).toContain(`\`${stage}\``);
    }
    expect(instructions.split('\n').length).toBeLessThan(60);
  });
});

describe('ensureContextEngineAgent', () => {
  it('ensures the per-space agent of the Context Engine type with an empty own configuration', async () => {
    const ensure = jest.fn().mockResolvedValue(undefined);
    const agentBuilder = { agents: { ensure } } as unknown as AgentBuilderPluginStart;

    await ensureContextEngineAgent({ agentBuilder, spaceId: 'sales' });

    expect(ensure).toHaveBeenCalledWith({
      spaceId: 'sales',
      agent: expect.objectContaining({
        id: CONTEXT_ENGINE_AGENT_ID,
        type: contextEngineAgentType.id,
        configuration: { tools: [], skill_ids: [], connector_ids: [] },
      }),
    });
  });
});
