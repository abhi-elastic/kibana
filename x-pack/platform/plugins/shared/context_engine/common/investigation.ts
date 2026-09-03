/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Stages of a guided investigation, in order. The `investigation` attachment carries the current
 * stage; the Context Engine agent's stage router and the Overview page's status line key on it.
 */
export const INVESTIGATION_STAGES = [
  'scoped',
  'findings_recorded',
  'decisions_recorded',
  'strategy_approved',
  'planned',
  'generated',
] as const;

export type InvestigationStage = (typeof INVESTIGATION_STAGES)[number];

export const investigationStageIndex = (stage: InvestigationStage): number =>
  INVESTIGATION_STAGES.indexOf(stage);

/** Session tag prefix for Agent Builder conversations started from an AI index. */
export const INVESTIGATION_SESSION_TAG_PREFIX = 'context-engine-investigation-';

export const buildInvestigationSessionTag = (aiIndexId: string): string =>
  `${INVESTIGATION_SESSION_TAG_PREFIX}${aiIndexId}`;
