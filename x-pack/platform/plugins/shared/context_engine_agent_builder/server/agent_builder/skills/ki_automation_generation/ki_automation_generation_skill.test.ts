/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { readdirSync } from 'fs';
import { internalNamespaces } from '@kbn/agent-builder-common/base/namespaces';
import { platformCoreTools } from '@kbn/agent-builder-common/tools';
import { isAllowedBuiltinSkill } from '@kbn/agent-builder-server/allow_lists';
import { kiAutomationGenerationSkill } from './ki_automation_generation_skill';

const MAX_WORKFLOW_GUIDANCE_LINES = 120;

const referencedContentByName = (name: string) => {
  const entry = kiAutomationGenerationSkill.referencedContent?.find((ref) => ref.name === name);
  if (!entry) {
    throw new Error(`referencedContent "${name}" is missing`);
  }
  return entry;
};

describe('kiAutomationGenerationSkill', () => {
  it('registers with stable id, name, and context-engine base path', () => {
    expect(kiAutomationGenerationSkill.id).toBe('ki-automation-generation');
    expect(kiAutomationGenerationSkill.name).toBe('ki-automation-generation');
    expect(kiAutomationGenerationSkill.basePath).toBe('skills/platform/context-engine');
  });

  it('is present in the built-in skills allow list', () => {
    expect(isAllowedBuiltinSkill(kiAutomationGenerationSkill.id)).toBe(true);
  });

  it('is excluded from Elastic capabilities and reached through the Context Engine agent type', () => {
    expect(kiAutomationGenerationSkill.excludeFromElasticCapabilities).toBe(true);
    expect(kiAutomationGenerationSkill.experimental).toBeUndefined();
  });

  it('ships a build, pilot and expand body that starts from a recorded plan', () => {
    const { content } = kiAutomationGenerationSkill;
    expect(content).toContain('stage `planned`');
    expect(content).toContain('save_automation');
    expect(content).toContain('planId');
    expect(content).toContain('## Build');
    expect(content).toContain('## Pilot');
    expect(content).toContain('## Expand');
    // Strategy, discovery and KI authoring belong to the neighbouring stages.
    expect(content).not.toMatch(/strategy catalog/i);
    expect(content).not.toContain('list_indices');
    // The phase numbering is a leftover from the six-phase skill this one replaced.
    expect(content).not.toMatch(/phase \d/i);
  });

  it('tells the agent how to call save_automation and generate_workflow safely', () => {
    const { content } = kiAutomationGenerationSkill;
    // The generator only sees the context string, so the typing rules must travel with it.
    expect(content).toContain('typing rules');
    expect(content).toContain('verbatim');
    // Placeholders in the unused field caused seven rejected saves in a real run.
    expect(content).toContain('omit the other field entirely');
    expect(content).toContain('planIds');
    expect(content).toContain('Never retry a failed call unchanged');
  });

  it('points to ki-investigation when there is no plan', () => {
    expect(kiAutomationGenerationSkill.content).toContain('`ki-investigation` produces one');
  });

  it('documents the signal dual-write', () => {
    expect(kiAutomationGenerationSkill.content).toContain('signal: true');
    expect(kiAutomationGenerationSkill.content).toContain('signals AI index');
  });

  it('references workflow_guidance and ki_shapes, and no full workflow example', () => {
    const names = (kiAutomationGenerationSkill.referencedContent ?? []).map((ref) => ref.name);
    expect(names).toEqual(['workflow_guidance', 'ki_shapes', 'glossary']);
    for (const ref of kiAutomationGenerationSkill.referencedContent ?? []) {
      expect(ref.relativePath).toBe('.');
      expect(ref.content.length).toBeGreaterThan(0);
      expect(kiAutomationGenerationSkill.content).toContain(ref.name);
    }
    const files = readdirSync(__dirname);
    expect(files.filter((file) => file.endsWith('.yaml.text'))).toEqual([]);
  });

  it('keeps workflow_guidance under the line budget and free of unit steering', () => {
    const guidance = referencedContentByName('workflow_guidance').content;
    expect(guidance.split('\n').length).toBeLessThan(MAX_WORKFLOW_GUIDANCE_LINES);
    expect(guidance).toContain('verifyKi');
    expect(guidance).toContain('provenance');
    expect(guidance).toContain('output.content');
    expect(guidance).not.toMatch(/one KI per (index|case|document)/i);
  });

  it('states the real data.set contract and the typing rules block in workflow_guidance', () => {
    const guidance = referencedContentByName('workflow_guidance').content;
    // `data.set` keys live directly under `with`; the earlier `variables:` wrapper was wrong.
    expect(guidance).toContain('directly under `with`');
    expect(guidance).toMatch(/never\s+nested under a `variables` key/);
    expect(guidance).toMatch(/condition[\s\S]{0,200}KQL string/);
    expect(guidance).toContain('Typing rules for this workflow:');
    expect(guidance).toContain('Never use `| json` to pass an object between steps.');
  });

  it('binds the workflow authoring and pilot tools only', async () => {
    const toolIds = (await kiAutomationGenerationSkill.getRegistryTools?.()) ?? [];

    expect(toolIds).toEqual([
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
    ]);
    expect(toolIds).not.toContain(platformCoreTools.listIndices);
  });

  it('only instructs the agent to call tools that are actually bound', async () => {
    const boundTools = (await kiAutomationGenerationSkill.getRegistryTools?.()) ?? [];

    const referencedToolIds = [
      ...new Set(
        [
          ...kiAutomationGenerationSkill.content.matchAll(
            /platform\.(?:core|workflows|context_engine)\.[a-z_]+/g
          ),
        ].map((match) => match[0])
      ),
    ];

    expect(referencedToolIds.length).toBeGreaterThan(0);

    const attachmentTypeIds = new Set([
      `${internalNamespaces.platformContextEngine}.ai_index`,
      `${internalNamespaces.platformContextEngine}.investigation`,
    ]);
    const attachmentScopedToolIds = new Set([
      `${internalNamespaces.platformContextEngine}.save_automation`,
    ]);
    const unboundReferences = referencedToolIds.filter(
      (toolId) =>
        !attachmentTypeIds.has(toolId) &&
        !attachmentScopedToolIds.has(toolId) &&
        !boundTools.includes(toolId)
    );
    expect(unboundReferences).toEqual([]);
  });
});
