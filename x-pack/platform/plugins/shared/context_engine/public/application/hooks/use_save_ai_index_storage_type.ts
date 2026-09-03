/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';
import type {
  AiIndexProperties,
  AiIndexType,
  GetAiIndexResponse,
} from '../../../common/http_api/ai_indices';
import { getAiIndexDest } from '../utils/ai_index_dest';
import { toProperties, useSaveAiIndexField } from './use_save_ai_index_field';

const buildProperties = (aiIndex: GetAiIndexResponse, type: AiIndexType): AiIndexProperties => ({
  ...toProperties(aiIndex),
  dest: getAiIndexDest(type, aiIndex.id),
});

/** Repoints the AI index at the canonical backing store for the chosen storage type. */
export const useSaveAiIndexStorageType = () => {
  const { save, isSaving } = useSaveAiIndexField<AiIndexType>({
    errorTitle: i18n.translate('xpack.contextEngine.saveAiIndexStorageType.errorTitle', {
      defaultMessage: 'Unable to update storage type',
    }),
    buildProperties,
  });

  return { saveStorageType: save, isSaving };
};
