/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';
import type { AiIndexType } from '../../../../common/http_api/ai_indices';

export interface StorageTypeOption {
  type: AiIndexType;
  badge: string;
  title: string;
  description: string;
}

export const STORAGE_TYPE_OPTIONS: readonly StorageTypeOption[] = [
  {
    type: 'index',
    badge: 'idx',
    title: i18n.translate('xpack.contextEngine.storageType.index.title', {
      defaultMessage: 'Index',
    }),
    description: i18n.translate('xpack.contextEngine.storageType.index.description', {
      defaultMessage:
        "Enterprise data — docs, tickets, knowledge bases and other reference context that isn't time-based.",
    }),
  },
  {
    type: 'data_stream',
    badge: 'ds',
    title: i18n.translate('xpack.contextEngine.storageType.dataStream.title', {
      defaultMessage: 'Data stream',
    }),
    description: i18n.translate('xpack.contextEngine.storageType.dataStream.description', {
      defaultMessage:
        'Observability & security — time-based context for agents (logs, metrics, traces, alerts).',
    }),
  },
];

export const getStorageTypeOption = (type: AiIndexType): StorageTypeOption =>
  STORAGE_TYPE_OPTIONS.find((option) => option.type === type) ?? STORAGE_TYPE_OPTIONS[0];
