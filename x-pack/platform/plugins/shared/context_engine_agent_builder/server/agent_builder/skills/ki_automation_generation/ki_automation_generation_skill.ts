/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { internalNamespaces } from '@kbn/agent-builder-common/base/namespaces';
import { platformCoreTools } from '@kbn/agent-builder-common/tools';
import { defineSkillType } from '@kbn/agent-builder-server/skills/type_definition';
import { KI_AUTOMATION_GENERATION_SKILL_ID } from '../../../../common/agent_builder_skills';
import { CONTEXT_ENGINE_SKILLS_BASE_PATH } from '../ki_investigation/ki_investigation_skill';
import glossary from '../references/glossary.md.text';
import kiShapes from '../references/ki_shapes.md.text';
import workflowGuidance from '../references/workflow_guidance.md.text';
import content from './ki_automation_generation_skill.md.text';

/**
 * Generation stage of a guided Context Engine run: each plan item becomes a validated, piloted
 * and saved workflow linked to the plan. Reached through the Context Engine agent type, which
 * lists it explicitly, so it is not gated on experimental features like the other two stages.
 */
export const kiAutomationGenerationSkill = defineSkillType({
  id: KI_AUTOMATION_GENERATION_SKILL_ID,
  name: KI_AUTOMATION_GENERATION_SKILL_ID,
  basePath: CONTEXT_ENGINE_SKILLS_BASE_PATH,
  excludeFromElasticCapabilities: true,
  description:
    'Generate Context Engine automations from a recorded plan: build one Kibana Workflow per plan ' +
    'item from its spec, validate it, pilot it on 1-3 units, expand, and save it linked to the plan. ' +
    'Use when a platform.context_engine.investigation attachment is at stage planned, or when the ' +
    'user asks to generate or edit a KI workflow. Does not pick the unit of context or author KI ' +
    'content; without a plan it points to ki-investigation first.',
  content,
  referencedContent: [
    { name: 'workflow_guidance', relativePath: '.', content: workflowGuidance },
    { name: 'ki_shapes', relativePath: '.', content: kiShapes },
    { name: 'glossary', relativePath: '.', content: glossary },
  ],
  getRegistryTools: () => [
    platformCoreTools.generateWorkflow,
    platformCoreTools.executeWorkflow,
    platformCoreTools.getWorkflowExecutionStatus,
    platformCoreTools.generateEsql,
    platformCoreTools.executeEsql,
    `${internalNamespaces.workflows}.validate_workflow`,
    `${internalNamespaces.workflows}.get_workflow`,
    `${internalNamespaces.workflows}.get_step_definitions`,
    `${internalNamespaces.workflows}.get_examples`,
    `${internalNamespaces.workflows}.get_connectors`,
  ],
});
