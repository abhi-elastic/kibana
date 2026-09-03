/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { platformCoreTools } from '@kbn/agent-builder-common/tools';
import { defineSkillType } from '@kbn/agent-builder-server/skills/type_definition';
import { KI_OPPORTUNITY_PLANNER_SKILL_ID } from '../../../../common/agent_builder_skills';
import { CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID } from '../../../../common/agent_builder_tools';
import { CONTEXT_ENGINE_SKILLS_BASE_PATH } from '../ki_investigation/ki_investigation_skill';
import glossary from '../references/glossary.md.text';
import kiShapes from '../references/ki_shapes.md.text';
import strategyCatalog from '../references/strategy_catalog.md.text';
import content from './ki_opportunity_planner_skill.md.text';

/**
 * Planning stage of a guided Context Engine run: the approved strategy becomes workflow specs per
 * family and authored targeted KI specs per accepted finding, recorded as the investigation plan.
 */
export const kiOpportunityPlannerSkill = defineSkillType({
  id: KI_OPPORTUNITY_PLANNER_SKILL_ID,
  name: KI_OPPORTUNITY_PLANNER_SKILL_ID,
  basePath: CONTEXT_ENGINE_SKILLS_BASE_PATH,
  excludeFromElasticCapabilities: true,
  description:
    'Plan Knowledge Indicators from an approved Context Engine strategy: one workflow spec per ' +
    'approved family (source query, unit key, foreach shape, extraction, freshness cursor, ' +
    'readiness, corpus filter, measured unit count) and one authored targeted KI spec per ' +
    'finding the user chose to create a KI for. Use when a platform.context_engine.investigation ' +
    'attachment is at stage strategy_approved. Does not write workflow YAML or revisit the strategy.',
  content,
  referencedContent: [
    { name: 'strategy_catalog', relativePath: '.', content: strategyCatalog },
    { name: 'ki_shapes', relativePath: '.', content: kiShapes },
    { name: 'glossary', relativePath: '.', content: glossary },
  ],
  getRegistryTools: () => [
    platformCoreTools.executeEsql,
    platformCoreTools.getIndexMapping,
    CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID,
  ],
});
