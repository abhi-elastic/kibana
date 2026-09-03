/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export {
  DEFAULT_PREVALENCE_MIN_REQUESTS,
  DEFAULT_PREVALENCE_MIN_FRACTION,
  DEFAULT_PREVALENCE_MIN_CONVERSATIONS,
  DEFAULT_SCALE_MIN_UNITS,
  DEFAULT_SCALE_MIN_FRACTION,
  applyGate,
} from '../../common/findings_gates';
export type { GateThresholds } from '../../common/findings_gates';
