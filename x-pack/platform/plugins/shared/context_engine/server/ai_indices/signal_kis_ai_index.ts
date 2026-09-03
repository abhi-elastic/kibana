/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  SIGNAL_KIS_AI_INDEX_DESCRIPTION,
  SIGNAL_KIS_AI_INDEX_DEST,
  SIGNAL_KIS_AI_INDEX_ID,
} from '../../common/constants';
import type { AiIndexProperties } from '../../common/http_api/ai_indices';
import type { AiIndexRegistry } from './registry';

/** Managed AI index that receives the second copy of every `create_ki_and_signal` KI. */
export const signalKisAiIndexProperties: AiIndexProperties = {
  description: SIGNAL_KIS_AI_INDEX_DESCRIPTION,
  dest: { type: 'index', value: SIGNAL_KIS_AI_INDEX_DEST },
  automations: [],
  sources: [],
};

/**
 * Registers the signals AI index so it is upserted as a managed entry on startup. Generated
 * workflows dual-write signal KIs to it with `context-engine.createKi`, which creates the backing
 * index on first write; nothing here touches Elasticsearch.
 */
export const registerSignalKisAiIndex = (registry: AiIndexRegistry): void => {
  registry.register(SIGNAL_KIS_AI_INDEX_ID, signalKisAiIndexProperties);
};
