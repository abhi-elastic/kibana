/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** Agent type every Context Engine hand-off opens: explicit tools and skills, no Elastic capabilities. */
export const CONTEXT_ENGINE_AGENT_TYPE_ID = 'platform.context_engine.investigation-type' as const;

/** Per-space agent id ensured lazily before a hand-off; user edits to the agent are kept. */
export const CONTEXT_ENGINE_AGENT_ID = 'platform.context_engine.agent' as const;

export const CONTEXT_ENGINE_AGENT_ENSURE_PATH = '/internal/context_engine/agent/_ensure' as const;

export const CONTEXT_ENGINE_AGENT_API_VERSION = '1' as const;

export interface EnsureContextEngineAgentResponse {
  agent_id: string;
  space_id: string;
}
