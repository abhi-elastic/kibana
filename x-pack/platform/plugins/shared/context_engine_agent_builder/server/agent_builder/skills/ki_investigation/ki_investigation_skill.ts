/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { platformCoreTools } from '@kbn/agent-builder-common/tools';
import { defineSkillType } from '@kbn/agent-builder-server/skills/type_definition';
import { AGENT_BUILDER_TRACING_ENABLED_SETTING_ID } from '@kbn/management-settings-ids';
import { KI_INVESTIGATION_SKILL_ID } from '../../../../common/agent_builder_skills';
import { CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID } from '../../../../common/agent_builder_tools';
import content from './ki_investigation_skill.md.text';
import answerPathAnalysis from './references/answer_path_analysis.md.text';
import confidenceRubric from './references/confidence_rubric.md.text';
import traceChecks from './references/trace_checks.md.text';
import glossary from '../references/glossary.md.text';
import strategyCatalog from '../references/strategy_catalog.md.text';
import { createTraceChecksTool } from './trace_checks';

export const CONTEXT_ENGINE_SKILLS_BASE_PATH = 'skills/platform/context-engine' as const;

/**
 * Investigation stage of a guided Context Engine run: trace checks and source answer-path
 * analysis, findings recorded for the user, decisions recorded. Tracing may be off, so the skill
 * is not gated on the tracing setting; the trace playbook reports an empty cohort instead.
 */
export const kiInvestigationSkill = defineSkillType({
  id: KI_INVESTIGATION_SKILL_ID,
  name: KI_INVESTIGATION_SKILL_ID,
  basePath: CONTEXT_ENGINE_SKILLS_BASE_PATH,
  excludeFromElasticCapabilities: true,
  description:
    "Investigate one Context Engine AI index scope: run the trace check catalog over an agent's " +
    'Agent Builder traces, measure the configured sources against confirmed probes, record findings ' +
    "with prevalence or scale, collect the user's decisions, and propose the context strategy " +
    '(unit of context, families, targeted KIs) for approval. Use when a ' +
    'platform.context_engine.investigation attachment is at stage scoped, findings_recorded or ' +
    `decisions_recorded. Does not author KIs or workflows. Tracing setting: ${AGENT_BUILDER_TRACING_ENABLED_SETTING_ID}.`,
  content,
  referencedContent: [
    { name: 'trace_checks', relativePath: '.', content: traceChecks },
    { name: 'answer_path_analysis', relativePath: '.', content: answerPathAnalysis },
    { name: 'confidence_rubric', relativePath: '.', content: confidenceRubric },
    { name: 'strategy_catalog', relativePath: '.', content: strategyCatalog },
    { name: 'glossary', relativePath: '.', content: glossary },
  ],
  getInlineTools: () => [createTraceChecksTool()],
  getRegistryTools: () => [
    platformCoreTools.executeEsql,
    platformCoreTools.getIndexMapping,
    CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID,
  ],
});
