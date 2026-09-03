/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowsExtensionsServerPluginSetup } from '@kbn/workflows-extensions/server';
import type { KiVerificationService } from '../ki_verification';
import type { KiStepDependencies } from './helpers';
import { getCreateKiStepDefinition } from './create_ki';
import { getUpdateKiStepDefinition } from './update_ki';
import { getDeleteKiStepDefinition } from './delete_ki';

export const registerStepDefinitions = ({
  workflowsExtensions,
  verificationService,
  ...deps
}: KiStepDependencies & {
  workflowsExtensions: WorkflowsExtensionsServerPluginSetup;
  verificationService: KiVerificationService;
}): void => {
  workflowsExtensions.registerStepDefinition(
    getCreateKiStepDefinition({ ...deps, verificationService })
  );
  workflowsExtensions.registerStepDefinition(getUpdateKiStepDefinition(deps));
  workflowsExtensions.registerStepDefinition(getDeleteKiStepDefinition(deps));
};
