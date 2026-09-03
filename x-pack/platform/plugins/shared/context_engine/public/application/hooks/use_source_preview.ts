/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useMutation } from '@kbn/react-query';
import type { AiIndexSource } from '../../../common/http_api/ai_indices';
import type { PreviewSourcesResponse } from '../../../common/http_api/investigation_scope';
import { previewSources } from '../api/investigation_scope';
import { useKibana } from './use_kibana';

/** On-demand "Validate and preview" of the configured sources; nothing runs until asked. */
export const useSourcePreview = () => {
  const {
    services: { http },
  } = useKibana();

  const { mutate, mutateAsync, data, isLoading, error, reset } = useMutation<
    PreviewSourcesResponse,
    Error,
    AiIndexSource[]
  >({
    mutationFn: (sources) => previewSources(http, { sources }),
  });

  return {
    runPreview: mutate,
    runPreviewAsync: mutateAsync,
    preview: data,
    isPreviewing: isLoading,
    previewError: error ?? undefined,
    resetPreview: reset,
  };
};
