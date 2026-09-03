/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import { kiAutomationGenerationSkill } from './ki_automation_generation/ki_automation_generation_skill';
import { kiInvestigationSkill } from './ki_investigation/ki_investigation_skill';
import { kiOpportunityPlannerSkill } from './ki_opportunity_planner/ki_opportunity_planner_skill';

export { kiAutomationGenerationSkill, kiInvestigationSkill, kiOpportunityPlannerSkill };

/** Registers the three stage skills of a guided investigation: investigate, plan, generate. */
export const registerContextEngineSkills = (agentBuilder: AgentBuilderPluginSetup): void => {
  agentBuilder.skills.register(kiInvestigationSkill);
  agentBuilder.skills.register(kiOpportunityPlannerSkill);
  agentBuilder.skills.register(kiAutomationGenerationSkill);
};
