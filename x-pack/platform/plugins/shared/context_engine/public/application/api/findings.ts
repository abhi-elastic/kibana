/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { HttpStart } from '@kbn/core-http-browser';
import {
  AI_INDEX_INTERNAL_API_VERSION,
  aiIndexLatestInvestigationPath,
} from '../../../common/constants';
import type { GetLatestInvestigationResponse } from '../../../common/http_api/findings';

const withAiIndex = (path: string, aiIndexId: string) =>
  path.replace('{aiIndexId}', encodeURIComponent(aiIndexId));

/** The newest run and its findings; what the Overview page shows after a reload instead of chat events. */
export const getLatestInvestigation = (
  http: HttpStart,
  { aiIndexId, signal }: { aiIndexId: string; signal?: AbortSignal }
): Promise<GetLatestInvestigationResponse> =>
  http.get<GetLatestInvestigationResponse>(withAiIndex(aiIndexLatestInvestigationPath, aiIndexId), {
    version: AI_INDEX_INTERNAL_API_VERSION,
    ...(signal ? { signal } : {}),
  });
