/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { platformCoreTools } from '@kbn/agent-builder-common/tools';
import { isAllowedBuiltinSkill } from '@kbn/agent-builder-server/allow_lists';
import {
  planTargetedKiSpecSchema,
  planWorkflowSpecSchema,
} from '@kbn/context-engine-plugin/common/investigation_schemas';
import { CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID } from '../../../../common/agent_builder_tools';
import { kiOpportunityPlannerSkill } from './ki_opportunity_planner_skill';

describe('kiOpportunityPlannerSkill', () => {
  it('registers with stable id, name, and context-engine base path', () => {
    expect(kiOpportunityPlannerSkill.id).toBe('ki-opportunity-planner');
    expect(kiOpportunityPlannerSkill.name).toBe('ki-opportunity-planner');
    expect(kiOpportunityPlannerSkill.basePath).toBe('skills/platform/context-engine');
    expect(kiOpportunityPlannerSkill.excludeFromElasticCapabilities).toBe(true);
    expect(isAllowedBuiltinSkill(kiOpportunityPlannerSkill.id)).toBe(true);
  });

  it('binds the measurement tools and record_investigation, and no workflow tools', async () => {
    const toolIds = (await kiOpportunityPlannerSkill.getRegistryTools?.()) ?? [];
    expect(toolIds).toEqual([
      platformCoreTools.executeEsql,
      platformCoreTools.getIndexMapping,
      CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID,
    ]);
    expect(toolIds).not.toContain(platformCoreTools.generateWorkflow);
  });

  it('references the strategy catalog and KI shapes and mentions both in the body', () => {
    const names = (kiOpportunityPlannerSkill.referencedContent ?? []).map((ref) => ref.name);
    expect(names).toEqual(['strategy_catalog', 'ki_shapes', 'glossary']);
    for (const ref of kiOpportunityPlannerSkill.referencedContent ?? []) {
      expect(ref.content.length).toBeGreaterThan(0);
      expect(kiOpportunityPlannerSkill.content).toContain(ref.name);
    }
  });

  it('describes the strategy-to-spec mapping in the plan schema field names', () => {
    const { content } = kiOpportunityPlannerSkill;
    for (const key of Object.keys(planWorkflowSpecSchema.shape)) {
      if (key === 'workflow_id') continue;
      expect(content).toContain(`\`${key}\``);
    }
    for (const key of Object.keys(planTargetedKiSpecSchema.shape)) {
      expect(content).toContain(`\`${key}\``);
    }
  });

  it('scopes the body to planning: no YAML, no strategy revision, no unplanned findings', () => {
    const { content } = kiOpportunityPlannerSkill;
    expect(content).toContain('stage `strategy_approved`');
    expect(content).toContain('record_investigation(action: plan)');
    expect(content).toContain('never write workflow YAML');
    expect(content).toContain('never revisit the unit of context');
    expect(content).toContain('Dismissed, suppressed and below-gate findings are never planned');
    expect(content).toContain('create_ki_and_signal');
    expect(content).toContain('text_only');
    expect(content).not.toContain('generate_workflow');
    expect(content).not.toMatch(/one KI per (index|case|document)\b/i);
  });

  it('ends with the confirmation that hands over to generation', () => {
    expect(kiOpportunityPlannerSkill.content).toContain(
      'Generate the automations from this plan now?'
    );
    expect(kiOpportunityPlannerSkill.content).toContain('ki-automation-generation');
  });

  it('only instructs the agent to call tools that are actually bound', async () => {
    const boundTools = (await kiOpportunityPlannerSkill.getRegistryTools?.()) ?? [];
    const referencedToolIds = [
      ...new Set(
        [
          ...kiOpportunityPlannerSkill.content.matchAll(
            /platform\.(?:core|workflows|context_engine)\.[a-z_]+/g
          ),
        ].map((match) => match[0])
      ),
    ];
    const attachmentTypeIds = new Set(['platform.context_engine.investigation']);
    expect(
      referencedToolIds.filter(
        (toolId) => !attachmentTypeIds.has(toolId) && !boundTools.includes(toolId)
      )
    ).toEqual([]);
  });
});
