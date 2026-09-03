/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, Logger } from '@kbn/core/server';
import { ExecutionError } from '@kbn/workflows/server';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import { CONTEXT_ENGINE_ENABLED_SETTING_ID } from '@kbn/management-settings-ids';
import {
  VERIFY_KI_STEP_TYPE_ID,
  VerifyKiStepCommonDefinition,
} from '../../common/step_types/verify_ki_step';
import { createKiVerifierRegistry, KiVerificationService } from '../ki_verification';
import type { ContextEngineAnalyticsService } from '../telemetry';
import { normalizeKiStepInput, withKiVerificationTelemetry } from './helpers';

export const createVerifyKiStepDefinition = (
  coreSetup: CoreSetup,
  logger: Logger,
  analyticsService: ContextEngineAnalyticsService,
  service: KiVerificationService = new KiVerificationService(createKiVerifierRegistry())
) => {
  return createServerStepDefinition({
    ...VerifyKiStepCommonDefinition,
    handler: async (context) => {
      const [coreStart] = await coreSetup.getStartServices();
      const fakeRequest = context.contextManager.getFakeRequest();
      const soClient = coreStart.savedObjects.getScopedClient(fakeRequest);
      const uiSettings = coreStart.uiSettings.asScopedToClient(soClient);
      const isEnabled = (await uiSettings.get<boolean>(CONTEXT_ENGINE_ENABLED_SETTING_ID)) ?? false;
      if (!isEnabled) {
        throw new ExecutionError({
          type: 'FeatureDisabledError',
          message: `Context Engine is disabled. Enable the ${CONTEXT_ENGINE_ENABLED_SETTING_ID} advanced setting to verify knowledge indicators.`,
        });
      }

      const { ki, execute_esql: executeEsql } = normalizeKiStepInput(context.input, {
        stepTypeId: VERIFY_KI_STEP_TYPE_ID,
        booleanFields: ['execute_esql'],
      });

      const summary = await withKiVerificationTelemetry({
        analyticsService,
        logger,
        run: () =>
          service.verifyKi(ki, {
            isEnabled,
            esClient: context.contextManager.getScopedEsClient(),
            logger,
            abortSignal: context.abortSignal,
            executeEsql: executeEsql === true,
          }),
      });

      return { output: summary };
    },
  });
};
