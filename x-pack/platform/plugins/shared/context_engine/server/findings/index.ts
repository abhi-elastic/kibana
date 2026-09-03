/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export { FindingsService } from './service';
export type {
  FindingsServiceApi,
  FindingDecisionInput,
  RecordFindingsParams,
  RecordFindingsResult,
  RecordDecisionsParams,
  RecordOutcomeParams,
  StartInvestigationParams,
} from './service';
export { applyGate } from './gates';
export type { GateThresholds } from './gates';
export { buildFindingId } from './identity';
export {
  FindingNotFoundError,
  InvalidInvestigationActionError,
  InvestigationNotFoundError,
} from './errors';
export { installFindingsIndexTemplate } from './storage';
