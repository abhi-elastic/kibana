/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, CoreStart, Plugin, PluginInitializerContext } from '@kbn/core/public';
import { registerAttachmentUiDefinitions } from './attachment_types';
import { createInvestigationProvider } from './create_investigation_provider';
import { createSuggestAutomationProvider } from './create_suggest_automation_provider';
import { ensureContextEngineAgentId } from './ensure_agent';
import type {
  ContextEngineAgentBuilderPublicSetup,
  ContextEngineAgentBuilderPublicSetupDependencies,
  ContextEngineAgentBuilderPublicStart,
  ContextEngineAgentBuilderPublicStartDependencies,
} from './types';

export class ContextEngineAgentBuilderPlugin
  implements
    Plugin<
      ContextEngineAgentBuilderPublicSetup,
      ContextEngineAgentBuilderPublicStart,
      ContextEngineAgentBuilderPublicSetupDependencies,
      ContextEngineAgentBuilderPublicStartDependencies
    >
{
  constructor(_context: PluginInitializerContext) {}

  setup(
    _core: CoreSetup<
      ContextEngineAgentBuilderPublicStartDependencies,
      ContextEngineAgentBuilderPublicStart
    >
  ): ContextEngineAgentBuilderPublicSetup {
    return {};
  }

  start(
    core: CoreStart,
    { contextEngine, agentBuilder }: ContextEngineAgentBuilderPublicStartDependencies
  ): ContextEngineAgentBuilderPublicStart {
    registerAttachmentUiDefinitions(agentBuilder.attachments);
    contextEngine.registerAgentBuilderIntegration({
      suggestAutomation: createSuggestAutomationProvider({
        agentBuilder,
        application: core.application,
        http: core.http,
      }),
      investigation: createInvestigationProvider({
        agentBuilder,
        application: core.application,
        http: core.http,
        notifications: core.notifications,
      }),
      ensureAgentId: () => ensureContextEngineAgentId(core.http),
    });

    return {};
  }

  stop() {}
}
