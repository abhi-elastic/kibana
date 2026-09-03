/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const CONTEXT_ENGINE_SAVE_AUTOMATION_TOOL_ID =
  'platform.context_engine.save_automation' as const;

/** Writes findings, decisions, strategy and plan to the findings store and advances the attachment. */
export const CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID =
  'platform.context_engine.record_investigation' as const;

/** Inline tool of the ki-investigation skill: runs the trace check catalog T1-T13 in one call. */
export const CONTEXT_ENGINE_TRACE_CHECKS_TOOL_ID = 'ki-investigation.trace_checks' as const;
