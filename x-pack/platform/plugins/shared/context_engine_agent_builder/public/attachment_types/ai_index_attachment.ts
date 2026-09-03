/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AttachmentUIDefinition } from '@kbn/agent-builder-browser/attachments';
import { i18n } from '@kbn/i18n';
import type { AiIndexAttachment } from '../../common/agent_builder_attachment_schemas';

/** Chip label and icon for the AI index snapshot; the pill otherwise shows the raw type id. */
export const aiIndexAttachmentUiDefinition: AttachmentUIDefinition<AiIndexAttachment> = {
  getLabel: (attachment) =>
    i18n.translate('xpack.contextEngine.attachments.aiIndex.label', {
      defaultMessage: 'AI index {id}',
      values: { id: attachment.data.id },
    }),
  getIcon: () => 'indexSettings',
};
