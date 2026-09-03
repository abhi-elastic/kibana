/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import { createAiIndexAttachmentType } from './ai_index';
import { createInvestigationAttachmentType } from './investigation';

type RegisteredAttachmentType = Parameters<
  AgentBuilderPluginSetup['attachments']['registerType']
>[0];

export const registerAttachmentTypes = (agentBuilder: AgentBuilderPluginSetup) => {
  agentBuilder.attachments.registerType(createAiIndexAttachmentType() as RegisteredAttachmentType);
  agentBuilder.attachments.registerType(
    createInvestigationAttachmentType() as RegisteredAttachmentType
  );
};
