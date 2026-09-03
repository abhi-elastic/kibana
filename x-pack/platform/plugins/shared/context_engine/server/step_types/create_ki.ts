/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import { ExecutionError } from '@kbn/workflows/server';
import { CREATE_KI_STEP_ID, createKiStepCommonDefinition } from '../../common/step_types/create_ki';
import type { KiVerificationService } from '../ki_verification';
import type { KiStepDependencies } from './helpers';
import {
  assertContextEngineEnabled,
  assertKiWritePrivilege,
  assertWritableDest,
  normalizeKiStepInput,
  resolveOrCreateAiIndex,
  withKiVerificationTelemetry,
  withKiWriteTelemetry,
} from './helpers';

export const KI_VERIFICATION_ERROR_TYPE = 'KiVerificationError';

export const getCreateKiStepDefinition = ({
  getAiIndexService,
  isContextEngineEnabled,
  checkWritePrivilege,
  analyticsService,
  logger,
  verificationService,
}: KiStepDependencies & { verificationService: KiVerificationService }) =>
  createServerStepDefinition({
    ...createKiStepCommonDefinition,
    handler: async (context) => {
      const request = context.contextManager.getFakeRequest();
      await assertContextEngineEnabled(isContextEngineEnabled, request);

      const {
        ai_index_id: aiIndexId,
        ki_id: kiId,
        ki,
        verify,
      } = normalizeKiStepInput(context.input, {
        stepTypeId: CREATE_KI_STEP_ID,
        booleanFields: ['verify'],
      });
      return withKiWriteTelemetry({
        action: 'create',
        aiIndexId,
        analyticsService,
        logger,
        run: async (setManaged) => {
          await assertKiWritePrivilege(checkWritePrivilege, request);

          const { dest, managed } = await resolveOrCreateAiIndex(getAiIndexService, aiIndexId);
          setManaged(managed);
          assertWritableDest(aiIndexId, dest);
          if (kiId !== undefined && dest.type === 'data_stream') {
            throw new ExecutionError({
              type: 'ValidationError',
              message: `Cannot create KI '${kiId}' in AI index '${aiIndexId}': the data stream backing store '${dest.value}' generates document ids`,
              details: { aiIndexId, kiId, destValue: dest.value },
            });
          }
          const esClient = context.contextManager.getScopedEsClient();

          if (verify === true) {
            // The setting was asserted above, so the registry runs unconditionally here.
            const summary = await withKiVerificationTelemetry({
              analyticsService,
              logger,
              run: () =>
                verificationService.verifyKi(ki, {
                  isEnabled: true,
                  esClient,
                  logger,
                  abortSignal: context.abortSignal,
                }),
            });
            if (!summary.passed) {
              const failures = summary.results.filter((result) => !result.passed);
              throw new ExecutionError({
                type: KI_VERIFICATION_ERROR_TYPE,
                message: `KI '${ki.title}' failed verification: ${failures
                  .map((result) => `${result.verifier}: ${result.reason ?? 'failed'}`)
                  .join('; ')}`,
                details: { aiIndexId, kiId, results: summary.results },
              });
            }
          }

          const response = await esClient.index(
            {
              index: dest.value,
              ...(kiId !== undefined && { id: kiId }),
              document: { '@timestamp': new Date().toISOString(), ...ki },
              // Data streams only accept `create`; `wait_for` makes the KI visible to later steps.
              ...(dest.type === 'data_stream' && { op_type: 'create' as const }),
              refresh: 'wait_for',
            },
            { signal: context.abortSignal }
          );

          return { output: { id: response._id } };
        },
      });
    },
  });
