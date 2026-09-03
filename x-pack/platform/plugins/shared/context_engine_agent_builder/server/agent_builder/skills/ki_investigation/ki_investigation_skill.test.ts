/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { platformCoreTools } from '@kbn/agent-builder-common/tools';
import { validateSkillDefinition } from '@kbn/agent-builder-server/skills/type_definition';
import { isAllowedSkillRegistration } from '@kbn/agent-builder-server/allow_lists';
import { KI_INVESTIGATION_SKILL_ID } from '../../../../common/agent_builder_skills';
import {
  CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID,
  CONTEXT_ENGINE_TRACE_CHECKS_TOOL_ID,
} from '../../../../common/agent_builder_tools';
import { kiInvestigationSkill } from './ki_investigation_skill';
import { toTraceScopeSelector } from './trace_checks';

describe('kiInvestigationSkill', () => {
  it('is a valid, allow-listed skill excluded from Elastic capabilities', async () => {
    await expect(validateSkillDefinition(kiInvestigationSkill)).resolves.toBe(kiInvestigationSkill);
    expect(kiInvestigationSkill.id).toBe(KI_INVESTIGATION_SKILL_ID);
    expect(isAllowedSkillRegistration(kiInvestigationSkill)).toBe(true);
    expect(kiInvestigationSkill.excludeFromElasticCapabilities).toBe(true);
    expect(kiInvestigationSkill.basePath).toBe('skills/platform/context-engine');
  });

  it('exposes the trace_checks inline tool and the registry tools the playbooks call', async () => {
    const inline = await kiInvestigationSkill.getInlineTools?.();
    expect(inline?.map((tool) => tool.id)).toEqual([CONTEXT_ENGINE_TRACE_CHECKS_TOOL_ID]);
    expect(inline?.[0].confirmation).toEqual({ askUser: 'never' });
    expect(await kiInvestigationSkill.getRegistryTools?.()).toEqual([
      platformCoreTools.executeEsql,
      platformCoreTools.getIndexMapping,
      CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID,
    ]);
  });

  it('carries the reference documents and the fixed order of operations in the body', () => {
    expect(kiInvestigationSkill.referencedContent?.map((reference) => reference.name)).toEqual([
      'trace_checks',
      'answer_path_analysis',
      'confidence_rubric',
      'strategy_catalog',
      'glossary',
    ]);
    const { content } = kiInvestigationSkill;
    expect(content).toContain(CONTEXT_ENGINE_TRACE_CHECKS_TOOL_ID);
    expect(content).toContain('`glossary.md`');
    expect(content).toContain('`meaning`');
    expect(content).toContain('Rare in this range');
    expect(content).toContain('Never call `list_indices`');
    expect(content).toContain('Ran N checks over R requests');
    expect(content).toContain('Never before decisions are recorded');
    expect(content).toContain(
      '`Approve`, `Change family`, `Change unit`, `Targeted KIs only`, `No KIs`'
    );
    expect(content).toContain('Build the plan for this strategy now?');

    const order = [
      'action: findings',
      'ask_user_question`, in the same message as step 2',
      'action: decisions',
      '### E. Context strategy',
      'Approve this context strategy?',
      'action: strategy',
    ].map((marker) => content.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(content.split('\n').length).toBeLessThanOrEqual(180);
  });

  it('keeps presentation, decisions and the strategy proposal in the same turn', () => {
    const { content } = kiInvestigationSkill;
    // In a real run the agent presented findings, stopped, and waited to be told to ask decisions,
    // then stopped again before the strategy. Both hand-offs are now explicit.
    expect(content).toContain('Present the results and ask the decisions in the same message');
    expect(content).toContain('continue straight into E in the same message');
    expect(content).toContain('Turn discipline');
    expect(content).toContain('Never repeat a failed tool call unchanged');
    expect(content).not.toMatch(/fails twice/);
  });

  it('keeps the strategy catalog as guidance with the selection rules and three shapes', () => {
    const catalog = kiInvestigationSkill.referencedContent?.find(
      (reference) => reference.name === 'strategy_catalog'
    )?.content;
    expect(catalog).toContain('Guidance, not a menu');
    expect(catalog).toContain('## Selection rules');
    for (const shape of ['`systemic`', '`targeted_only`', '`both`', '`none`']) {
      expect(catalog).toContain(shape);
    }
    expect(catalog).not.toMatch(/```ya?ml/);
  });

  it('ships a glossary that defines every measured property, finding kind and label it may show', () => {
    const glossary = kiInvestigationSkill.referencedContent?.find(
      (reference) => reference.name === 'glossary'
    )?.content;
    expect(glossary).toBeDefined();
    for (const term of [
      '`spread`',
      '`fan_out`',
      '`reading_cost`',
      '`discovery_risk`',
      '`query_risk`',
      '`freshness`',
      '`spread_without_join_key`',
      '`consolidation_cost`',
      '`probe_unanswerable`',
      '`discovery_loop`',
      '`recovery_loop`',
      '`confirmed`',
      '`strong`',
      '`suggestive`',
      '`systemic`',
      '`targeted_only`',
      '`constraint`',
      '`workaround`',
      '`disambiguation`',
      '`task_recipe`',
      '`fact`',
      '`schema-shape`',
      '`esql-executes`',
    ]) {
      expect(glossary).toContain(term);
    }
    for (const check of Array.from({ length: 13 }, (_, index) => `T${index + 1} `)) {
      expect(glossary).toContain(check);
    }
  });

  it('accepts the trace scope as attached and rejects an incomplete one', () => {
    expect(toTraceScopeSelector({ agent_id: 'a', from: 'now-7d', to: 'now' }, 'traces-x')).toEqual({
      kind: 'agent',
      tracesIndex: 'traces-x',
      agentId: 'a',
      range: { from: 'now-7d', to: 'now' },
    });
    expect(
      toTraceScopeSelector({ custom_esql: 'FROM traces-x | WHERE a == 1' }, 'traces-x')
    ).toEqual({ kind: 'custom', esql: 'FROM traces-x | WHERE a == 1' });
    expect(() => toTraceScopeSelector({ agent_id: 'a' }, 'traces-x')).toThrow(
      'Provide agent_id, from and to, or a custom_esql scope.'
    );
  });
});
