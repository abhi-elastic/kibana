/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ToolType } from '@kbn/agent-builder-common';
import { ToolResultType } from '@kbn/agent-builder-common/tools/tool_result';
import { hasWorkflowReadPrivilege } from '@kbn/agent-builder-tools-base/workflows';
import type { BuiltinToolDefinition } from '@kbn/agent-builder-server';
import type { CoreStart, ElasticsearchClient } from '@kbn/core/server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import { z } from '@kbn/zod/v4';
import dedent from 'dedent';
import {
  MAX_AI_INDEX_AUTOMATION_LENGTH,
  MAX_AI_INDEX_ID_LENGTH,
} from '@kbn/context-engine-plugin/common/constants';
import { validateAiIndexId } from '@kbn/context-engine-plugin/common/validation';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import type { AiIndexService } from '@kbn/context-engine-plugin/server/ai_indices/service';
import type { FindingsServiceApi } from '@kbn/context-engine-plugin/server/findings/service';
import { CONTEXT_ENGINE_SAVE_AUTOMATION_TOOL_ID } from '../../../../common/agent_builder_tools';
import {
  getSaveAutomationErrorMessage,
  normalizeSaveAutomationParams,
  saveAutomationHandler,
  tryResolveAiIndexDisplayLabelFromAttachments,
  tryResolveWorkflowDisplayNameById,
  tryResolveWorkflowDisplayNameFromAttachments,
} from './handler';

const MAX_ATTACHMENT_ID_LENGTH = 256;
const MAX_PLAN_ITEM_ID_LENGTH = 128;

const MAX_PLAN_IDS = 50;

// Placeholder strings ("", "/", "null") are accepted by the schema and dropped by
// normalizeSaveAutomationParams, so a model that fills every optional field is not rejected.
const saveAutomationSchema = z
  .object({
    workflowAttachmentId: z
      .string()
      .max(MAX_ATTACHMENT_ID_LENGTH)
      .optional()
      .describe(
        'Conversation attachment id of the generated workflow (the attachment_id returned by generate_workflow). Saves the YAML and attaches it to the AI index. Omit this field when passing workflowId.'
      ),
    workflowId: z
      .string()
      .max(MAX_AI_INDEX_AUTOMATION_LENGTH)
      .optional()
      .describe(
        'Saved workflow id to register as an automation on the AI index. Use only when the workflow was already saved manually. Omit this field when passing workflowAttachmentId.'
      ),
    aiIndexId: z
      .string()
      .max(MAX_AI_INDEX_ID_LENGTH)
      .optional()
      .describe(
        'Context Engine AI index id. Defaults to the id from the ai_index attachment in this conversation.'
      ),
    planId: z
      .string()
      .max(MAX_PLAN_ITEM_ID_LENGTH)
      .optional()
      .describe(
        'Plan item id (plan_item_id) from the investigation attachment this workflow implements. Links the saved workflow to the plan and moves the investigation to generated.'
      ),
    planIds: z
      .array(z.string().max(MAX_PLAN_ITEM_ID_LENGTH))
      .max(MAX_PLAN_IDS)
      .optional()
      .describe(
        'Plan item ids when one workflow implements several plan items (for example a static writer covering several targeted KIs). Every id is linked to the saved workflow.'
      ),
  })
  .superRefine((value, ctx) => {
    const { workflowAttachmentId, workflowId, aiIndexId } = normalizeSaveAutomationParams(value);

    if (!workflowAttachmentId && !workflowId) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Provide workflowAttachmentId (the attachment_id returned by generate_workflow) or workflowId (a saved workflow id).',
        path: ['workflowAttachmentId'],
      });
    } else if (workflowAttachmentId && workflowId) {
      ctx.addIssue({
        code: 'custom',
        message: `workflowAttachmentId "${workflowAttachmentId}" and workflowId "${workflowId}" name different workflows. Pass only the one you mean and leave the other field out entirely.`,
        path: ['workflowAttachmentId'],
      });
    }

    if (aiIndexId === undefined) {
      return;
    }

    const validationError = validateAiIndexId(aiIndexId);
    if (validationError) {
      ctx.addIssue({
        code: 'custom',
        message: validationError,
        path: ['aiIndexId'],
      });
    }
  });

type WorkflowsManagementApi = WorkflowsServerPluginSetup['management'];

export const createSaveAutomationTool = ({
  getAiIndexService,
  getFindingsService,
  getCoreStart,
  getSecurityStart,
  getWorkflowsManagement,
}: {
  getAiIndexService: () => Promise<AiIndexService>;
  getFindingsService?: (esClient: ElasticsearchClient) => Promise<FindingsServiceApi>;
  getCoreStart: () => Promise<CoreStart>;
  getSecurityStart: () => Promise<SecurityPluginStart | undefined>;
  getWorkflowsManagement: () => WorkflowsManagementApi;
}): BuiltinToolDefinition<typeof saveAutomationSchema> => ({
  id: CONTEXT_ENGINE_SAVE_AUTOMATION_TOOL_ID,
  type: ToolType.builtin,
  tags: ['context_engine', 'workflows'],
  // Create/upsert write: persists a workflow and attaches it to the AI index.
  annotations: {
    title: 'Save workflow automation',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  description: dedent`
    Save a generated workflow and/or attach it to a Context Engine AI index as an automation.
    - To persist a draft from generate_workflow, pass workflowAttachmentId and omit workflowId.
    - If the user already saved the workflow manually, pass workflowId and omit workflowAttachmentId.
    - Pass planId (one plan item) or planIds (several) to link the workflow to the investigation plan.
    Requires an ai_index attachment in the conversation unless aiIndexId is provided explicitly.
  `,
  schema: saveAutomationSchema,
  confirmation: {
    askUser: 'always',
    getConfirmation: async ({ toolParams, context }) => {
      const { attachments, request, spaceId } = context;
      const { workflowAttachmentId, workflowId, aiIndexId } =
        normalizeSaveAutomationParams(toolParams);
      const aiIndexLabel = tryResolveAiIndexDisplayLabelFromAttachments(attachments, aiIndexId);

      let workflowLabel = 'workflow';
      if (workflowAttachmentId) {
        const workflowName = tryResolveWorkflowDisplayNameFromAttachments(
          attachments,
          workflowAttachmentId
        );
        workflowLabel = workflowName
          ? `workflow "${workflowName}"`
          : `draft workflow attachment "${workflowAttachmentId}"`;
      } else if (workflowId) {
        let workflowName: string | undefined;
        const security = await getSecurityStart();
        const canRead = await hasWorkflowReadPrivilege({
          security,
          request,
          spaceId,
        });
        if (canRead) {
          workflowName = await tryResolveWorkflowDisplayNameById({
            workflowsManagement: getWorkflowsManagement(),
            workflowId,
            spaceId,
          });
        }
        workflowLabel = workflowName ? `workflow "${workflowName}"` : `workflow "${workflowId}"`;
      }

      return {
        title: 'Save workflow automation',
        message: `Save ${workflowLabel} to Kibana and attach it to AI index "${aiIndexLabel}"?`,
        confirm_text: 'Save and attach',
        cancel_text: 'Cancel',
      };
    },
  },
  handler: async (params, { request, spaceId, esClient, attachments, logger }) => {
    try {
      const result = await saveAutomationHandler({
        params,
        request,
        spaceId,
        attachments,
        logger,
        getAiIndexService,
        getCoreStart,
        getSecurityStart,
        getWorkflowsManagement,
        ...(getFindingsService
          ? { getFindingsService: () => getFindingsService(esClient.asCurrentUser) }
          : {}),
      });

      return {
        results: [
          {
            type: ToolResultType.other,
            data: result,
          },
        ],
      };
    } catch (error) {
      const message = getSaveAutomationErrorMessage(error);
      logger.error(`Error running ${CONTEXT_ENGINE_SAVE_AUTOMATION_TOOL_ID}: ${message}`, {
        error,
      });
      return {
        results: [
          {
            type: ToolResultType.error,
            data: {
              message: `Failed to save workflow automation: ${message}`,
            },
          },
        ],
      };
    }
  },
});
