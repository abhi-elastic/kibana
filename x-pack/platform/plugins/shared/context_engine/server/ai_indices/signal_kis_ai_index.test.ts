/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core/server/mocks';
import { SIGNAL_KIS_AI_INDEX_DEST, SIGNAL_KIS_AI_INDEX_ID } from '../../common/constants';
import { validateAiIndexId } from '../../common/ai_index_dest';
import { AiIndexRegistry } from './registry';
import type { AiIndexService } from './service';
import { registerSignalKisAiIndex, signalKisAiIndexProperties } from './signal_kis_ai_index';

describe('signal KIs AI index', () => {
  it('uses an id createKi can auto-create and the matching index-backed dest', () => {
    expect(validateAiIndexId('index', SIGNAL_KIS_AI_INDEX_ID)).toEqual({
      dest: { type: 'index', value: SIGNAL_KIS_AI_INDEX_DEST },
    });
    expect(signalKisAiIndexProperties.dest).toEqual({
      type: 'index',
      value: SIGNAL_KIS_AI_INDEX_DEST,
    });
    expect(SIGNAL_KIS_AI_INDEX_DEST).toBe(`ai-index-idx-${SIGNAL_KIS_AI_INDEX_ID}`);
    expect(signalKisAiIndexProperties.automations).toEqual([]);
    expect(signalKisAiIndexProperties.sources).toEqual([]);
  });

  it('is upserted as a managed AI index on startup', async () => {
    const registry = new AiIndexRegistry();
    registerSignalKisAiIndex(registry);
    const putManaged = jest.fn().mockResolvedValue('created');

    await registry.startupRegister({
      aiIndexService: { putManaged } as unknown as AiIndexService,
      isEnabled: true,
      logger: loggingSystemMock.createLogger(),
    });

    expect(putManaged).toHaveBeenCalledWith(SIGNAL_KIS_AI_INDEX_ID, signalKisAiIndexProperties);
  });
});
