/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';
import { useMutation, useQueryClient } from '@kbn/react-query';
import type { AiIndexInvestigationScope } from '../../../common/http_api/ai_indices';
import { putAiIndexInvestigationScope } from '../api/ai_indices';
import { getErrorMessage } from '../utils/get_error_message';
import { contextEngineQueryKeys } from './query_keys';
import { useKibana } from './use_kibana';

/** Persists the AI index's `investigation_scope` through its dedicated internal route. */
export const useSaveInvestigationScope = (aiIndexId: string | undefined) => {
  const {
    services: { http, notifications },
  } = useKibana();
  const queryClient = useQueryClient();

  const { mutateAsync, isLoading } = useMutation({
    mutationFn: (investigationScope: AiIndexInvestigationScope) => {
      if (!aiIndexId) {
        throw new Error('AI index id is required');
      }
      return putAiIndexInvestigationScope(http, { aiIndexId, investigationScope });
    },
    onSuccess: () => {
      if (aiIndexId) {
        queryClient.invalidateQueries({
          queryKey: contextEngineQueryKeys.aiIndex.detail(aiIndexId),
          exact: true,
        });
      }
    },
    onError: (error: Error) => {
      const toastMessage = getErrorMessage(error);
      notifications.toasts.addError(error, {
        title: i18n.translate('xpack.contextEngine.investigationScope.saveError', {
          defaultMessage: 'Unable to save the investigation scope',
        }),
        ...(toastMessage ? { toastMessage } : {}),
      });
    },
  });

  return { saveScope: mutateAsync, isSavingScope: isLoading };
};
