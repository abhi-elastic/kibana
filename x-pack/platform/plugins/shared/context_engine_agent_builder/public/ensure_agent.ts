/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { HttpStart } from '@kbn/core/public';
import {
  CONTEXT_ENGINE_AGENT_API_VERSION,
  CONTEXT_ENGINE_AGENT_ENSURE_PATH,
  type EnsureContextEngineAgentResponse,
} from '../common/agent_builder_agents';

/**
 * Create-if-absent install of the Context Engine agent in the current space, returning its id.
 * A failure resolves to `undefined` so the hand-off falls back to the default agent instead of
 * blocking; the skill mention in the initial message still steers the conversation.
 */
export const ensureContextEngineAgentId = async (http: HttpStart): Promise<string | undefined> => {
  try {
    const response = await http.post<EnsureContextEngineAgentResponse>(
      CONTEXT_ENGINE_AGENT_ENSURE_PATH,
      { version: CONTEXT_ENGINE_AGENT_API_VERSION }
    );
    return response.agent_id;
  } catch {
    return undefined;
  }
};
