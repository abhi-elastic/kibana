/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ATTACHMENT_REF_ACTOR, getLatestVersion } from '@kbn/agent-builder-common/attachments';
import {
  hasWorkflowCreatePrivilege,
  hasWorkflowReadPrivilege,
  hasWorkflowUpdatePrivilege,
} from '@kbn/agent-builder-tools-base/workflows';
import type { AttachmentStateManager } from '@kbn/agent-builder-server/attachments';
import type { CoreStart, Logger } from '@kbn/core/server';
import type { KibanaRequest } from '@kbn/core-http-server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import { parseYamlToJSONWithoutValidation } from '@kbn/workflows-yaml';
import type { AiIndexService } from '@kbn/context-engine-plugin/server/ai_indices/service';
import type { FindingsServiceApi } from '@kbn/context-engine-plugin/server/findings/service';
import type { InvestigationRecord } from '@kbn/context-engine-plugin/common/http_api/findings';
import { buildInvestigationAttachmentData } from '@kbn/context-engine-plugin/common/investigation_schemas';
import {
  AI_INDEX_ATTACHMENT_TYPE,
  WORKFLOW_YAML_ATTACHMENT_TYPE,
} from '../../../../common/agent_builder_attachments';
import { assertContextEngineWriteAccess } from '../../assert_context_engine_write_access';
import { resolveInvestigationId } from '../record_investigation/handler';

export interface SaveAutomationParams {
  workflowAttachmentId?: string;
  workflowId?: string;
  aiIndexId?: string;
  planId?: string;
  planIds?: string[];
}

/** Params after placeholder values are dropped and `planId` / `planIds` are merged. */
export interface NormalizedSaveAutomationParams {
  workflowAttachmentId?: string;
  workflowId?: string;
  aiIndexId?: string;
  planIds: string[];
}

export interface SaveAutomationResult {
  aiIndexId: string;
  workflowId: string;
  status: 'saved_and_attached' | 'attached' | 'already_attached';
  /** Set when plan item ids linked the workflow to an investigation plan. */
  plan?: { planIds: string[]; investigationId: string; stage: string };
}

const PLACEHOLDER_VALUES = new Set(['null', 'undefined', 'none', 'n/a', 'na']);

/**
 * Models fill optional string arguments they do not mean with placeholders such as `"/"`, `""`
 * or `"null"` rather than omitting them. Treat those as absent so the xor between
 * `workflowAttachmentId` and `workflowId` is judged on real values only.
 */
export const isPlaceholderValue = (value: unknown): boolean => {
  if (typeof value !== 'string') {
    return true;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || /^[/\\._-]+$/.test(trimmed)) {
    return true;
  }
  return PLACEHOLDER_VALUES.has(trimmed.toLowerCase());
};

const realValue = (value: unknown): string | undefined =>
  isPlaceholderValue(value) ? undefined : (value as string).trim();

/**
 * Drops placeholder values, merges `planId` and `planIds` into one deduplicated list, and treats
 * a `workflowId` equal to the `workflowAttachmentId` as the attachment reference (a workflow
 * loaded with `get_workflow(attach: true)` uses its id as the attachment id).
 */
export const normalizeSaveAutomationParams = (
  params: SaveAutomationParams
): NormalizedSaveAutomationParams => {
  const workflowAttachmentId = realValue(params.workflowAttachmentId);
  let workflowId = realValue(params.workflowId);
  if (workflowAttachmentId && workflowId === workflowAttachmentId) {
    workflowId = undefined;
  }
  const planIds = [
    ...new Set(
      [params.planId, ...(params.planIds ?? [])]
        .map(realValue)
        .filter((id): id is string => id !== undefined)
    ),
  ];
  return {
    ...(workflowAttachmentId ? { workflowAttachmentId } : {}),
    ...(workflowId ? { workflowId } : {}),
    ...(realValue(params.aiIndexId) ? { aiIndexId: realValue(params.aiIndexId) } : {}),
    planIds,
  };
};

type WorkflowsManagementApi = WorkflowsServerPluginSetup['management'];

interface WorkflowYamlAttachmentData {
  yaml: string;
  workflowId?: string;
  name?: string;
}

const isWorkflowYamlData = (data: unknown): data is WorkflowYamlAttachmentData => {
  if (!data || typeof data !== 'object' || !('yaml' in data)) {
    return false;
  }

  return typeof data.yaml === 'string' && data.yaml.length > 0;
};

export const parseWorkflowNameFromYaml = (yaml: string): string | undefined => {
  const parsed = parseYamlToJSONWithoutValidation(yaml);
  if (!parsed.success || parsed.json == null || typeof parsed.json !== 'object') {
    return undefined;
  }

  const name = (parsed.json as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() !== '' ? name : undefined;
};

export const tryResolveWorkflowDisplayNameFromAttachments = (
  attachments: AttachmentStateManager | undefined,
  workflowAttachmentId: string
): string | undefined => {
  if (!attachments) {
    return undefined;
  }

  const attachment = attachments.getAll().find((entry) => entry.id === workflowAttachmentId);
  if (!attachment || attachment.type !== WORKFLOW_YAML_ATTACHMENT_TYPE) {
    return undefined;
  }

  const latestVersion = getLatestVersion(attachment);
  if (!latestVersion || !isWorkflowYamlData(latestVersion.data)) {
    return undefined;
  }

  return latestVersion.data.name ?? parseWorkflowNameFromYaml(latestVersion.data.yaml);
};

export const tryResolveAiIndexDisplayLabelFromAttachments = (
  attachments: AttachmentStateManager | undefined,
  aiIndexId?: string
): string => {
  if (!attachments) {
    return aiIndexId ?? 'the AI index';
  }

  for (const attachment of attachments.getAll()) {
    if (attachment.type !== AI_INDEX_ATTACHMENT_TYPE) {
      continue;
    }

    const latestVersion = getLatestVersion(attachment);
    const data = latestVersion?.data;
    if (!data || typeof data !== 'object' || !('id' in data) || typeof data.id !== 'string') {
      continue;
    }

    if (aiIndexId !== undefined && data.id !== aiIndexId) {
      continue;
    }

    if (
      'description' in data &&
      typeof data.description === 'string' &&
      data.description.length > 0
    ) {
      return data.description;
    }

    return data.id;
  }

  return aiIndexId ?? 'the AI index';
};

export const tryResolveWorkflowDisplayNameById = async ({
  workflowsManagement,
  workflowId,
  spaceId,
}: {
  workflowsManagement: WorkflowsManagementApi;
  workflowId: string;
  spaceId: string;
}): Promise<string | undefined> => {
  try {
    const workflow = await workflowsManagement.getWorkflow(workflowId, spaceId);
    return workflow?.name;
  } catch {
    return undefined;
  }
};

export const resolveAiIndexIdFromAttachments = (
  attachments: Array<{ type: string; data: { id?: string } }>,
  aiIndexId?: string
): string => {
  if (aiIndexId) {
    return aiIndexId;
  }

  const attachment = attachments.find(
    (entry) => entry.type === AI_INDEX_ATTACHMENT_TYPE && typeof entry.data.id === 'string'
  );

  if (!attachment?.data.id) {
    throw new Error(
      'No ai_index attachment found in this conversation. Provide aiIndexId explicitly or attach the AI index first.'
    );
  }

  return attachment.data.id;
};

const flattenAiIndexAttachments = (
  attachments: AttachmentStateManager
): Array<{ type: string; data: { id?: string } }> =>
  attachments.getAll().flatMap((attachment) => {
    const latestVersion = getLatestVersion(attachment);
    if (!latestVersion?.data || typeof latestVersion.data !== 'object') {
      return [];
    }

    return [
      {
        type: attachment.type,
        data: latestVersion.data as { id?: string },
      },
    ];
  });

export const resolveWorkflowYamlFromAttachments = (
  attachments: AttachmentStateManager,
  workflowAttachmentId: string
): { yaml: string; workflowId?: string; origin?: string } => {
  const attachment = attachments.getAll().find((entry) => entry.id === workflowAttachmentId);

  if (!attachment) {
    throw new Error(
      `Workflow attachment '${workflowAttachmentId}' not found in this conversation.`
    );
  }

  if (attachment.type !== WORKFLOW_YAML_ATTACHMENT_TYPE) {
    throw new Error(
      `Attachment '${workflowAttachmentId}' is not a workflow attachment (expected ${WORKFLOW_YAML_ATTACHMENT_TYPE}).`
    );
  }

  const latestVersion = getLatestVersion(attachment);
  if (!latestVersion || !isWorkflowYamlData(latestVersion.data)) {
    throw new Error(`Workflow attachment '${workflowAttachmentId}' has no YAML content to save.`);
  }

  return {
    yaml: latestVersion.data.yaml,
    workflowId: latestVersion.data.workflowId,
    origin: attachment.origin,
  };
};

const assertWorkflowReadAccess = async ({
  workflowId,
  spaceId,
  request,
  getSecurityStart,
  workflowsManagement,
}: {
  workflowId: string;
  spaceId: string;
  request: KibanaRequest;
  getSecurityStart: () => Promise<SecurityPluginStart | undefined>;
  workflowsManagement: WorkflowsManagementApi;
}): Promise<void> => {
  const security = await getSecurityStart();
  const canRead = await hasWorkflowReadPrivilege({ security, request, spaceId });
  if (!canRead) {
    throw new Error(
      `Unauthorized to reference workflow '${workflowId}'. The workflowsManagement read privilege is required.`
    );
  }

  const workflow = await workflowsManagement.getWorkflow(workflowId, spaceId);
  if (!workflow) {
    throw new Error(`Workflow '${workflowId}' was not found in this space.`);
  }
};

const assertWorkflowCreateAccess = async ({
  spaceId,
  request,
  getSecurityStart,
}: {
  spaceId: string;
  request: KibanaRequest;
  getSecurityStart: () => Promise<SecurityPluginStart | undefined>;
}): Promise<void> => {
  const security = await getSecurityStart();
  const canCreate = await hasWorkflowCreatePrivilege({ security, request, spaceId });
  if (!canCreate) {
    throw new Error(
      'Unauthorized to create a workflow. The workflowsManagement create privilege is required.'
    );
  }
};

const assertWorkflowUpdateAccess = async ({
  workflowId,
  spaceId,
  request,
  getSecurityStart,
}: {
  workflowId: string;
  spaceId: string;
  request: KibanaRequest;
  getSecurityStart: () => Promise<SecurityPluginStart | undefined>;
}): Promise<void> => {
  const security = await getSecurityStart();
  const canUpdate = await hasWorkflowUpdatePrivilege({ security, request, spaceId });
  if (!canUpdate) {
    throw new Error(
      `Unauthorized to update workflow '${workflowId}'. The workflowsManagement update privilege is required.`
    );
  }
};

const persistWorkflowFromAttachment = async ({
  yaml,
  proposedWorkflowId,
  existingWorkflowId,
  workflowsManagement,
  spaceId,
  request,
  getSecurityStart,
}: {
  yaml: string;
  proposedWorkflowId?: string;
  existingWorkflowId?: string;
  workflowsManagement: WorkflowsManagementApi;
  spaceId: string;
  request: KibanaRequest;
  getSecurityStart: () => Promise<SecurityPluginStart | undefined>;
}): Promise<{ workflowId: string; newlyCreated: boolean }> => {
  if (existingWorkflowId !== undefined) {
    await assertWorkflowUpdateAccess({
      workflowId: existingWorkflowId,
      spaceId,
      request,
      getSecurityStart,
    });
    await workflowsManagement.updateWorkflow(existingWorkflowId, { yaml }, spaceId, request);
    return { workflowId: existingWorkflowId, newlyCreated: false };
  }

  await assertWorkflowCreateAccess({ spaceId, request, getSecurityStart });
  const created = await workflowsManagement.createWorkflow(
    { yaml, ...(proposedWorkflowId ? { id: proposedWorkflowId } : {}) },
    spaceId,
    request
  );

  return { workflowId: created.id, newlyCreated: true };
};

/**
 * Writes the saved workflow id onto every named plan item and versions the investigation
 * attachment to `generated`. Runs after the automation is attached; a failure here is reported,
 * not rolled back, because the workflow is already live on the AI index.
 */
const linkWorkflowToPlan = async ({
  planIds,
  workflowId,
  attachments,
  getFindingsService,
  logger,
}: {
  planIds: string[];
  workflowId: string;
  attachments: AttachmentStateManager;
  getFindingsService: () => Promise<FindingsServiceApi>;
  logger: Logger;
}): Promise<SaveAutomationResult['plan']> => {
  const { investigationId, attachment } = resolveInvestigationId(attachments);
  const service = await getFindingsService();
  let investigation: InvestigationRecord | undefined;
  for (const planItemId of planIds) {
    ({ investigation } = await service.recordOutcome({ investigationId, planItemId, workflowId }));
  }
  if (!investigation) {
    throw new Error('At least one plan item id is required to link a workflow to the plan.');
  }
  if (attachment) {
    const [findings, priorDecisions] = await Promise.all([
      investigation.finding_ids.length > 0 ? service.getFindings(investigation.finding_ids) : [],
      service.priorDecisions(investigation.ai_index_id),
    ]);
    const updated = await attachments.update(
      attachment.id,
      { data: buildInvestigationAttachmentData({ investigation, findings, priorDecisions }) },
      ATTACHMENT_REF_ACTOR.agent
    );
    if (!updated) {
      logger.warn(
        `Workflow '${workflowId}' was linked to plan items '${planIds.join(
          ', '
        )}' but attachment '${attachment.id}' could not be updated.`
      );
    }
  }
  return { planIds, investigationId, stage: investigation.stage };
};

export const saveAutomationHandler = async ({
  params,
  request,
  spaceId,
  attachments,
  logger,
  getAiIndexService,
  getFindingsService,
  getCoreStart,
  getSecurityStart,
  getWorkflowsManagement,
}: {
  params: SaveAutomationParams;
  request: KibanaRequest;
  spaceId: string;
  attachments: AttachmentStateManager;
  logger: Logger;
  getAiIndexService: () => Promise<AiIndexService>;
  getFindingsService?: () => Promise<FindingsServiceApi>;
  getCoreStart: () => Promise<CoreStart>;
  getSecurityStart: () => Promise<SecurityPluginStart | undefined>;
  getWorkflowsManagement: () => WorkflowsManagementApi;
}): Promise<SaveAutomationResult> => {
  const normalized = normalizeSaveAutomationParams(params);
  const saved = await saveAutomation({
    params: normalized,
    request,
    spaceId,
    attachments,
    logger,
    getAiIndexService,
    getCoreStart,
    getSecurityStart,
    getWorkflowsManagement,
  });
  if (normalized.planIds.length === 0) {
    return saved;
  }
  if (!getFindingsService) {
    throw new Error('planId was provided but the findings store is not available.');
  }
  const plan = await linkWorkflowToPlan({
    planIds: normalized.planIds,
    workflowId: saved.workflowId,
    attachments,
    getFindingsService,
    logger,
  });
  return { ...saved, plan };
};

const saveAutomation = async ({
  params,
  request,
  spaceId,
  attachments,
  logger,
  getAiIndexService,
  getCoreStart,
  getSecurityStart,
  getWorkflowsManagement,
}: {
  params: NormalizedSaveAutomationParams;
  request: KibanaRequest;
  spaceId: string;
  attachments: AttachmentStateManager;
  logger: Logger;
  getAiIndexService: () => Promise<AiIndexService>;
  getCoreStart: () => Promise<CoreStart>;
  getSecurityStart: () => Promise<SecurityPluginStart | undefined>;
  getWorkflowsManagement: () => WorkflowsManagementApi;
}): Promise<SaveAutomationResult> => {
  await assertContextEngineWriteAccess({ request, spaceId, getCoreStart, getSecurityStart });

  const workflowsManagement = getWorkflowsManagement();
  const aiIndexAttachments = flattenAiIndexAttachments(attachments);
  const aiIndexId = resolveAiIndexIdFromAttachments(aiIndexAttachments, params.aiIndexId);
  const aiIndexService = await getAiIndexService();

  if (params.workflowId) {
    await assertWorkflowReadAccess({
      workflowId: params.workflowId,
      spaceId,
      request,
      getSecurityStart,
      workflowsManagement,
    });

    // Fail-fast: reject before attach when the index cannot accept this automation.
    await aiIndexService.assertCanAcceptAutomation(aiIndexId, {
      type: 'workflow',
      value: params.workflowId,
    });

    const attachStatus = await aiIndexService.addAutomation(aiIndexId, {
      type: 'workflow',
      value: params.workflowId,
    });

    return {
      aiIndexId,
      workflowId: params.workflowId,
      status: attachStatus,
    };
  }

  if (!params.workflowAttachmentId) {
    throw new Error(
      'Provide workflowAttachmentId (the attachment_id returned by generate_workflow) or workflowId (a saved workflow id). Leave the other one out entirely.'
    );
  }

  const {
    yaml,
    workflowId: proposedWorkflowId,
    origin: existingWorkflowId,
  } = resolveWorkflowYamlFromAttachments(attachments, params.workflowAttachmentId);
  const isUpdate = existingWorkflowId !== undefined;

  // Fail-fast: reject before createWorkflow/updateWorkflow when the index cannot accept this automation.
  await aiIndexService.assertCanAcceptAutomation(
    aiIndexId,
    existingWorkflowId ? { type: 'workflow', value: existingWorkflowId } : undefined
  );

  const { workflowId, newlyCreated } = await persistWorkflowFromAttachment({
    yaml,
    proposedWorkflowId,
    existingWorkflowId,
    workflowsManagement,
    spaceId,
    request,
    getSecurityStart,
  });

  try {
    const attachStatus = await aiIndexService.addAutomation(aiIndexId, {
      type: 'workflow',
      value: workflowId,
    });

    if (newlyCreated) {
      const originUpdated = await attachments.updateOrigin(
        params.workflowAttachmentId,
        workflowId,
        ATTACHMENT_REF_ACTOR.agent
      );
      if (!originUpdated) {
        logger.warn(
          `Workflow '${workflowId}' was attached but its attachment origin could not be recorded; ` +
            `a future save for attachment '${params.workflowAttachmentId}' may create a duplicate workflow.`
        );
      }
    }

    return {
      aiIndexId,
      workflowId,
      status: isUpdate || attachStatus === 'attached' ? 'saved_and_attached' : 'already_attached',
    };
  } catch (error) {
    if (newlyCreated) {
      try {
        await workflowsManagement.deleteWorkflows([workflowId], spaceId, request);
      } catch (deleteError) {
        logger.warn(`Failed to roll back workflow '${workflowId}' after attach failure`, {
          error: deleteError,
        });
      }
    }

    throw error;
  }
};

export const getSaveAutomationErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return 'An unexpected error occurred while saving the workflow automation.';
};
