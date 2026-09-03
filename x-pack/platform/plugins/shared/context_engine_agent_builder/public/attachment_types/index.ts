/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginStart } from '@kbn/agent-builder-browser';
import {
  AI_INDEX_ATTACHMENT_TYPE,
  INVESTIGATION_ATTACHMENT_TYPE,
} from '../../common/agent_builder_attachments';
import { aiIndexAttachmentUiDefinition } from './ai_index_attachment';
import { investigationAttachmentUiDefinition } from './investigation_attachment';

export const registerAttachmentUiDefinitions = (
  attachments: AgentBuilderPluginStart['attachments']
) => {
  attachments.addAttachmentType(AI_INDEX_ATTACHMENT_TYPE, aiIndexAttachmentUiDefinition);
  attachments.addAttachmentType(INVESTIGATION_ATTACHMENT_TYPE, investigationAttachmentUiDefinition);
};
