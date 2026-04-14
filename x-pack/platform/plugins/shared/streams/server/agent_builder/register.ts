/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-plugin/server';
import type { Logger } from '@kbn/core/server';
import type { StreamsServer } from '../types';
import type { GetScopedClients } from '../routes/types';
import { MemoryServiceImpl } from '../lib/memory';
import { registerAgentBuilderTools } from './tools/register_tools';
import { streamExplorationSkill } from './skills/stream_exploration_skill';
import { createSigEventsMemorySkill } from './skills/sig_events_memory_skill';
import { createConversationMemorySkill } from './skills/conversation_memory_skill';

export const registerStreamsAgentBuilder = async ({
  agentBuilder,
  getScopedClients,
  server,
  logger,
  isMemoryEnabled,
  isABMemoryEnabled,
}: {
  agentBuilder: AgentBuilderPluginSetup;
  getScopedClients: GetScopedClients;
  server: StreamsServer;
  logger: Logger;
  isMemoryEnabled: () => Promise<boolean>;
  isABMemoryEnabled: () => Promise<boolean>;
}) => {
  registerAgentBuilderTools({ agentBuilder, getScopedClients, server, logger });

  const getMemoryService = () =>
    new MemoryServiceImpl({
      logger: logger.get('memory'),
      esClient: server.core.elasticsearch.client.asInternalUser,
    });

  agentBuilder.skills.register(streamExplorationSkill);

  // The sig-events memory skill is registered lazily — only once the Streams memory setting is on.
  let memorySkillRegistered = false;

  const ensureMemorySkillRegistered = () => {
    if (memorySkillRegistered) {
      return;
    }
    memorySkillRegistered = true;
    agentBuilder.skills.register(
      createSigEventsMemorySkill({
        getMemoryService,
        getSecurity: () => server.core.security,
      })
    );
    logger.info('Memory skill registered (observability:streamsEnableMemory is enabled)');
  };

  // The conversation memory skill is registered lazily — only once the AB memory setting is on.
  let conversationMemorySkillRegistered = false;

  const ensureConversationMemorySkillRegistered = () => {
    if (conversationMemorySkillRegistered) {
      return;
    }
    conversationMemorySkillRegistered = true;
    agentBuilder.skills.register(
      createConversationMemorySkill({
        getMemoryService,
        getSecurity: () => server.core.security,
        mode: 'natural',
      })
    );
    logger.info('Conversation memory skill registered (agentBuilder:enableMemory is enabled)');
  };

  if (await isMemoryEnabled()) {
    ensureMemorySkillRegistered();
  }

  if (await isABMemoryEnabled()) {
    ensureConversationMemorySkillRegistered();
  }

  return { ensureMemorySkillRegistered, ensureConversationMemorySkillRegistered };
};
