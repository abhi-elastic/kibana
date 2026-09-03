/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ATTACHMENT_REF_ACTOR } from '@kbn/agent-builder-common/attachments';
import { httpServerMock } from '@kbn/core-http-server-mocks';
import { loggingSystemMock } from '@kbn/core/server/mocks';
import {
  AI_INDEX_ATTACHMENT_TYPE,
  INVESTIGATION_ATTACHMENT_TYPE,
} from '../../../../common/agent_builder_attachments';
import { MAX_AI_INDEX_AUTOMATIONS } from '@kbn/context-engine-plugin/common/constants';
import {
  AiIndexConflictError,
  AiIndexManagedError,
} from '@kbn/context-engine-plugin/server/ai_indices/errors';
import type { AiIndexService } from '@kbn/context-engine-plugin/server/ai_indices/service';
import {
  isPlaceholderValue,
  normalizeSaveAutomationParams,
  parseWorkflowNameFromYaml,
  resolveAiIndexIdFromAttachments,
  saveAutomationHandler,
  getSaveAutomationErrorMessage,
  tryResolveAiIndexDisplayLabelFromAttachments,
  tryResolveWorkflowDisplayNameFromAttachments,
} from './handler';

jest.mock('../../assert_context_engine_write_access', () => ({
  assertContextEngineWriteAccess: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@kbn/agent-builder-tools-base/workflows', () => ({
  hasWorkflowReadPrivilege: jest.fn().mockResolvedValue(true),
  hasWorkflowCreatePrivilege: jest.fn().mockResolvedValue(true),
  hasWorkflowUpdatePrivilege: jest.fn().mockResolvedValue(true),
}));

const { hasWorkflowReadPrivilege, hasWorkflowCreatePrivilege, hasWorkflowUpdatePrivilege } =
  jest.requireMock('@kbn/agent-builder-tools-base/workflows');

const WORKFLOW_ATTACHMENT_ID = 'workflow-attachment-1';
const WORKFLOW_YAML = 'name: pilot\nsteps: []';

const createAttachmentStateManager = ({
  origin,
}: {
  origin?: string;
} = {}) => ({
  getAll: jest.fn().mockReturnValue([
    {
      id: WORKFLOW_ATTACHMENT_ID,
      type: 'workflow.yaml',
      origin,
      current_version: 1,
      versions: [{ version: 1, data: { yaml: WORKFLOW_YAML, workflowId: 'pilot-workflow' } }],
    },
    {
      id: 'ai-index-attachment',
      type: AI_INDEX_ATTACHMENT_TYPE,
      current_version: 1,
      versions: [{ version: 1, data: { id: 'my-ai-index' } }],
    },
  ]),
  updateOrigin: jest.fn().mockResolvedValue(true),
});

describe('normalizeSaveAutomationParams', () => {
  it.each(['', '  ', '/', '-', '_', '.', 'null', 'NULL', 'undefined', 'none', 'N/A', undefined])(
    'treats %p as a placeholder',
    (value) => {
      expect(isPlaceholderValue(value)).toBe(true);
    }
  );

  it.each(['wf-1', 'airline-targeted-ki-writer', '963ac884-d9d6-4ffd-8922-f57dec23bd3f', 'a/b'])(
    'keeps %p as a real value',
    (value) => {
      expect(isPlaceholderValue(value)).toBe(false);
    }
  );

  it('drops the placeholder side of the workflow xor', () => {
    expect(
      normalizeSaveAutomationParams({ workflowAttachmentId: 'att-1', workflowId: '/' })
    ).toEqual({ workflowAttachmentId: 'att-1', planIds: [] });
    expect(normalizeSaveAutomationParams({ workflowAttachmentId: '', workflowId: 'wf-1' })).toEqual(
      {
        workflowId: 'wf-1',
        planIds: [],
      }
    );
  });

  it('treats a workflowId equal to the attachment id as the attachment reference', () => {
    expect(
      normalizeSaveAutomationParams({ workflowAttachmentId: 'wf-1', workflowId: 'wf-1' })
    ).toEqual({ workflowAttachmentId: 'wf-1', planIds: [] });
  });

  it('merges planId and planIds, trims, deduplicates and drops placeholders', () => {
    expect(
      normalizeSaveAutomationParams({
        workflowId: 'wf-1',
        planId: ' ki-a ',
        planIds: ['ki-a', 'ki-b', '/', ''],
        aiIndexId: '/',
      })
    ).toEqual({ workflowId: 'wf-1', planIds: ['ki-a', 'ki-b'] });
  });
});

describe('resolveAiIndexIdFromAttachments', () => {
  it('returns an explicit aiIndexId when provided', () => {
    expect(
      resolveAiIndexIdFromAttachments(
        [{ type: AI_INDEX_ATTACHMENT_TYPE, data: { id: 'from-attachment' } }],
        'explicit-id'
      )
    ).toBe('explicit-id');
  });

  it('resolves aiIndexId from the ai_index attachment', () => {
    expect(
      resolveAiIndexIdFromAttachments([
        { type: AI_INDEX_ATTACHMENT_TYPE, data: { id: 'from-attachment' } },
      ])
    ).toBe('from-attachment');
  });

  it('throws when no aiIndexId is available', () => {
    expect(() => resolveAiIndexIdFromAttachments([])).toThrow(/No ai_index attachment found/);
  });
});

describe('save automation confirmation labels', () => {
  it('parses workflow names from yaml via the workflows yaml parser', () => {
    expect(parseWorkflowNameFromYaml('name: "Pilot Workflow"\nsteps: []')).toBe('Pilot Workflow');
    expect(parseWorkflowNameFromYaml('name: "My \\"escaped\\" value"\nsteps: []')).toBe(
      'My "escaped" value'
    );
    expect(parseWorkflowNameFromYaml('name: |\n  A multiline\n  name\nsteps: []')).toBe(
      'A multiline\nname\n'
    );
  });

  it('resolves workflow display names from attachments', () => {
    const attachments = createAttachmentStateManager();
    expect(
      tryResolveWorkflowDisplayNameFromAttachments(
        attachments as unknown as Parameters<
          typeof tryResolveWorkflowDisplayNameFromAttachments
        >[0],
        WORKFLOW_ATTACHMENT_ID
      )
    ).toBe('pilot');
  });

  it('resolves ai index display labels from attachments', () => {
    const attachments = createAttachmentStateManager();
    expect(
      tryResolveAiIndexDisplayLabelFromAttachments(
        attachments as unknown as Parameters<typeof tryResolveAiIndexDisplayLabelFromAttachments>[0]
      )
    ).toBe('my-ai-index');
  });
});

describe('getSaveAutomationErrorMessage', () => {
  it('returns error.message for Error instances', () => {
    expect(getSaveAutomationErrorMessage(new AiIndexManagedError('my-ai-index'))).toBe(
      "AI index 'my-ai-index' is managed and cannot be modified via the API"
    );
    expect(getSaveAutomationErrorMessage(new AiIndexConflictError('my-ai-index'))).toContain(
      'my-ai-index'
    );
    expect(
      getSaveAutomationErrorMessage(
        Object.assign(new Error("Workflow with id 'wf-1' already exists"), { statusCode: 409 })
      )
    ).toBe("Workflow with id 'wf-1' already exists");
    expect(
      getSaveAutomationErrorMessage(
        Object.assign(new Error('search failed'), { statusCode: 500, meta: {} })
      )
    ).toBe('search failed');
    expect(
      getSaveAutomationErrorMessage(new Error("Workflow 'wf-1' was not found in this space."))
    ).toBe("Workflow 'wf-1' was not found in this space.");
  });

  it('returns a generic message for non-Error values', () => {
    expect(getSaveAutomationErrorMessage('boom')).toBe(
      'An unexpected error occurred while saving the workflow automation.'
    );
  });
});

describe('saveAutomationHandler', () => {
  const request = httpServerMock.createKibanaRequest();
  const logger = loggingSystemMock.createLogger();
  const getCoreStart = jest.fn();
  const getSecurityStart = jest.fn().mockResolvedValue(undefined);
  let aiIndexService: jest.Mocked<
    Pick<AiIndexService, 'addAutomation' | 'assertCanAcceptAutomation'>
  >;
  let workflowsManagement: {
    getWorkflow: jest.Mock;
    createWorkflow: jest.Mock;
    updateWorkflow: jest.Mock;
    deleteWorkflows: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    hasWorkflowReadPrivilege.mockResolvedValue(true);
    hasWorkflowCreatePrivilege.mockResolvedValue(true);
    hasWorkflowUpdatePrivilege.mockResolvedValue(true);

    aiIndexService = {
      addAutomation: jest.fn(),
      assertCanAcceptAutomation: jest.fn().mockResolvedValue(undefined),
    };
    workflowsManagement = {
      getWorkflow: jest.fn().mockResolvedValue({ id: 'wf-new' }),
      createWorkflow: jest.fn(),
      updateWorkflow: jest.fn(),
      deleteWorkflows: jest.fn().mockResolvedValue({ total: 1, deleted: 1, failures: [] }),
    };
    getCoreStart.mockResolvedValue({});
  });

  it('creates the workflow and attaches it to the AI index', async () => {
    aiIndexService.addAutomation.mockResolvedValue('attached');
    workflowsManagement.createWorkflow.mockResolvedValue({ id: 'wf-new', name: 'pilot' });

    const attachments = createAttachmentStateManager();

    const result = await saveAutomationHandler({
      params: { workflowAttachmentId: WORKFLOW_ATTACHMENT_ID },
      request,
      spaceId: 'default',
      attachments: attachments as never,
      logger,
      getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
      getCoreStart,
      getSecurityStart,
      getWorkflowsManagement: () => workflowsManagement as never,
    });

    expect(hasWorkflowCreatePrivilege).toHaveBeenCalled();
    expect(workflowsManagement.createWorkflow).toHaveBeenCalledWith(
      { yaml: WORKFLOW_YAML, id: 'pilot-workflow' },
      'default',
      request
    );
    expect(aiIndexService.addAutomation).toHaveBeenCalledWith('my-ai-index', {
      type: 'workflow',
      value: 'wf-new',
    });
    expect(attachments.updateOrigin).toHaveBeenCalledWith(
      WORKFLOW_ATTACHMENT_ID,
      'wf-new',
      ATTACHMENT_REF_ACTOR.agent
    );
    expect(result).toEqual({
      aiIndexId: 'my-ai-index',
      workflowId: 'wf-new',
      status: 'saved_and_attached',
    });
  });

  it('updates an already persisted workflow before attaching', async () => {
    aiIndexService.addAutomation.mockResolvedValue('attached');

    const attachments = createAttachmentStateManager({ origin: 'wf-persisted' });

    const result = await saveAutomationHandler({
      params: { workflowAttachmentId: WORKFLOW_ATTACHMENT_ID },
      request,
      spaceId: 'default',
      attachments: attachments as never,
      logger,
      getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
      getCoreStart,
      getSecurityStart,
      getWorkflowsManagement: () => workflowsManagement as never,
    });

    expect(hasWorkflowUpdatePrivilege).toHaveBeenCalled();
    expect(workflowsManagement.updateWorkflow).toHaveBeenCalledWith(
      'wf-persisted',
      { yaml: WORKFLOW_YAML },
      'default',
      request
    );
    expect(workflowsManagement.createWorkflow).not.toHaveBeenCalled();
    expect(attachments.updateOrigin).not.toHaveBeenCalled();
    expect(result).toEqual({
      aiIndexId: 'my-ai-index',
      workflowId: 'wf-persisted',
      status: 'saved_and_attached',
    });
  });

  it('returns saved_and_attached when updating a workflow that is already linked', async () => {
    aiIndexService.addAutomation.mockResolvedValue('already_attached');

    const attachments = createAttachmentStateManager({ origin: 'wf-persisted' });

    const result = await saveAutomationHandler({
      params: { workflowAttachmentId: WORKFLOW_ATTACHMENT_ID },
      request,
      spaceId: 'default',
      attachments: attachments as never,
      logger,
      getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
      getCoreStart,
      getSecurityStart,
      getWorkflowsManagement: () => workflowsManagement as never,
    });

    expect(workflowsManagement.updateWorkflow).toHaveBeenCalledWith(
      'wf-persisted',
      { yaml: WORKFLOW_YAML },
      'default',
      request
    );
    expect(result).toEqual({
      aiIndexId: 'my-ai-index',
      workflowId: 'wf-persisted',
      status: 'saved_and_attached',
    });
  });

  it('attaches an already saved workflow by id', async () => {
    aiIndexService.addAutomation.mockResolvedValue('attached');

    const attachments = createAttachmentStateManager();

    const result = await saveAutomationHandler({
      params: { workflowId: 'wf-new' },
      request,
      spaceId: 'default',
      attachments: attachments as never,
      logger,
      getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
      getCoreStart,
      getSecurityStart,
      getWorkflowsManagement: () => workflowsManagement as never,
    });

    expect(hasWorkflowReadPrivilege).toHaveBeenCalled();
    expect(result).toEqual({
      aiIndexId: 'my-ai-index',
      workflowId: 'wf-new',
      status: 'attached',
    });
    expect(workflowsManagement.getWorkflow).toHaveBeenCalledWith('wf-new', 'default');
    expect(workflowsManagement.createWorkflow).not.toHaveBeenCalled();
  });

  it('links the saved workflow to the plan item and versions the investigation attachment', async () => {
    aiIndexService.addAutomation.mockResolvedValue('attached');
    const investigationData = {
      investigation_id: 'inv-1',
      ai_index_id: 'my-ai-index',
      stage: 'planned',
      scope: { mode: 'sources', sources: [] },
      prior_decisions: [],
      findings: [],
      decisions: [],
      strategy: { shape: 'none', families: [], targeted_kis: [], cost_estimate: '', rationale: '' },
      plan: { workflows: [], targeted_kis: [] },
    };
    const investigationAttachment = {
      id: 'investigation-attachment',
      type: INVESTIGATION_ATTACHMENT_TYPE,
      current_version: 1,
      versions: [{ version: 1, data: investigationData }],
    };
    const base = createAttachmentStateManager();
    const attachments = {
      ...base,
      getAll: jest.fn().mockReturnValue([...base.getAll(), investigationAttachment]),
      getActive: jest.fn().mockReturnValue([investigationAttachment]),
      update: jest.fn().mockResolvedValue({ current_version: 2 }),
    };
    const generated = {
      ...investigationData,
      doc_type: 'investigation',
      stage: 'generated',
      finding_ids: [],
      plan: { workflows: [{ plan_item_id: 'w-1', workflow_id: 'wf-new' }], targeted_kis: [] },
    };
    const findingsService = {
      recordOutcome: jest.fn().mockResolvedValue({ investigation: generated, findings: [] }),
      getFindings: jest.fn().mockResolvedValue([]),
      priorDecisions: jest.fn().mockResolvedValue([]),
    };

    const result = await saveAutomationHandler({
      params: { workflowId: 'wf-new', planId: 'w-1' },
      request,
      spaceId: 'default',
      attachments: attachments as never,
      logger,
      getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
      getFindingsService: async () => findingsService as never,
      getCoreStart,
      getSecurityStart,
      getWorkflowsManagement: () => workflowsManagement as never,
    });

    expect(findingsService.recordOutcome).toHaveBeenCalledWith({
      investigationId: 'inv-1',
      planItemId: 'w-1',
      workflowId: 'wf-new',
    });
    expect(attachments.update).toHaveBeenCalledWith(
      'investigation-attachment',
      { data: expect.objectContaining({ stage: 'generated' }) },
      ATTACHMENT_REF_ACTOR.agent
    );
    expect(result).toEqual({
      aiIndexId: 'my-ai-index',
      workflowId: 'wf-new',
      status: 'attached',
      plan: { planIds: ['w-1'], investigationId: 'inv-1', stage: 'generated' },
    });
  });

  it('links one workflow to several plan items and ignores placeholder values', async () => {
    aiIndexService.addAutomation.mockResolvedValue('attached');
    const investigationData = {
      investigation_id: 'inv-1',
      ai_index_id: 'my-ai-index',
      stage: 'planned',
      scope: { mode: 'sources', sources: [] },
      prior_decisions: [],
      findings: [],
      decisions: [],
      strategy: { shape: 'none', families: [], targeted_kis: [], cost_estimate: '', rationale: '' },
      plan: { workflows: [], targeted_kis: [] },
    };
    const investigationAttachment = {
      id: 'investigation-attachment',
      type: INVESTIGATION_ATTACHMENT_TYPE,
      current_version: 1,
      versions: [{ version: 1, data: investigationData }],
    };
    const base = createAttachmentStateManager();
    const attachments = {
      ...base,
      getAll: jest.fn().mockReturnValue([...base.getAll(), investigationAttachment]),
      getActive: jest.fn().mockReturnValue([investigationAttachment]),
      update: jest.fn().mockResolvedValue({ current_version: 2 }),
    };
    const generated = {
      ...investigationData,
      doc_type: 'investigation',
      stage: 'generated',
      finding_ids: [],
    };
    const findingsService = {
      recordOutcome: jest.fn().mockResolvedValue({ investigation: generated, findings: [] }),
      getFindings: jest.fn().mockResolvedValue([]),
      priorDecisions: jest.fn().mockResolvedValue([]),
    };

    const result = await saveAutomationHandler({
      params: {
        workflowId: 'wf-new',
        workflowAttachmentId: '/',
        planId: 'ki-a',
        planIds: ['ki-a', 'ki-b', ''],
      },
      request,
      spaceId: 'default',
      attachments: attachments as never,
      logger,
      getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
      getFindingsService: async () => findingsService as never,
      getCoreStart,
      getSecurityStart,
      getWorkflowsManagement: () => workflowsManagement as never,
    });

    expect(findingsService.recordOutcome).toHaveBeenCalledTimes(2);
    expect(findingsService.recordOutcome).toHaveBeenNthCalledWith(1, {
      investigationId: 'inv-1',
      planItemId: 'ki-a',
      workflowId: 'wf-new',
    });
    expect(findingsService.recordOutcome).toHaveBeenNthCalledWith(2, {
      investigationId: 'inv-1',
      planItemId: 'ki-b',
      workflowId: 'wf-new',
    });
    expect(attachments.update).toHaveBeenCalledTimes(1);
    expect(result.plan).toEqual({
      planIds: ['ki-a', 'ki-b'],
      investigationId: 'inv-1',
      stage: 'generated',
    });
  });

  it('rejects planId when the findings store is not wired', async () => {
    aiIndexService.addAutomation.mockResolvedValue('attached');

    await expect(
      saveAutomationHandler({
        params: { workflowId: 'wf-new', planId: 'w-1' },
        request,
        spaceId: 'default',
        attachments: createAttachmentStateManager() as never,
        logger,
        getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
        getCoreStart,
        getSecurityStart,
        getWorkflowsManagement: () => workflowsManagement as never,
      })
    ).rejects.toThrow(/findings store is not available/);
  });

  it('rejects attaching a workflow id that does not exist', async () => {
    workflowsManagement.getWorkflow.mockResolvedValue(null);

    await expect(
      saveAutomationHandler({
        params: { workflowId: 'wf-missing' },
        request,
        spaceId: 'default',
        attachments: createAttachmentStateManager() as never,
        logger,
        getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
        getCoreStart,
        getSecurityStart,
        getWorkflowsManagement: () => workflowsManagement as never,
      })
    ).rejects.toThrow(/Workflow 'wf-missing' was not found/);
  });

  it('rejects when the caller lacks workflow read privilege', async () => {
    hasWorkflowReadPrivilege.mockResolvedValue(false);

    await expect(
      saveAutomationHandler({
        params: { workflowId: 'wf-new' },
        request,
        spaceId: 'default',
        attachments: createAttachmentStateManager() as never,
        logger,
        getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
        getCoreStart,
        getSecurityStart,
        getWorkflowsManagement: () => workflowsManagement as never,
      })
    ).rejects.toThrow(/Unauthorized to reference workflow 'wf-new'/);
  });

  it('rejects when the caller lacks workflow create privilege', async () => {
    hasWorkflowCreatePrivilege.mockResolvedValue(false);

    await expect(
      saveAutomationHandler({
        params: { workflowAttachmentId: WORKFLOW_ATTACHMENT_ID },
        request,
        spaceId: 'default',
        attachments: createAttachmentStateManager() as never,
        logger,
        getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
        getCoreStart,
        getSecurityStart,
        getWorkflowsManagement: () => workflowsManagement as never,
      })
    ).rejects.toThrow(/Unauthorized to create a workflow/);
  });

  it('rejects when the caller lacks workflow update privilege', async () => {
    hasWorkflowUpdatePrivilege.mockResolvedValue(false);

    await expect(
      saveAutomationHandler({
        params: { workflowAttachmentId: WORKFLOW_ATTACHMENT_ID },
        request,
        spaceId: 'default',
        attachments: createAttachmentStateManager({ origin: 'wf-persisted' }) as never,
        logger,
        getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
        getCoreStart,
        getSecurityStart,
        getWorkflowsManagement: () => workflowsManagement as never,
      })
    ).rejects.toThrow(/Unauthorized to update workflow 'wf-persisted'/);
  });

  it('continues when updateOrigin fails after creating a workflow', async () => {
    aiIndexService.addAutomation.mockResolvedValue('attached');
    workflowsManagement.createWorkflow.mockResolvedValue({ id: 'wf-new', name: 'pilot' });

    const attachments = createAttachmentStateManager();
    attachments.updateOrigin.mockResolvedValue(false);

    const result = await saveAutomationHandler({
      params: { workflowAttachmentId: WORKFLOW_ATTACHMENT_ID },
      request,
      spaceId: 'default',
      attachments: attachments as never,
      logger,
      getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
      getCoreStart,
      getSecurityStart,
      getWorkflowsManagement: () => workflowsManagement as never,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('attachment origin could not be recorded')
    );
    expect(aiIndexService.addAutomation).toHaveBeenCalled();
    expect(attachments.updateOrigin).toHaveBeenCalledWith(
      WORKFLOW_ATTACHMENT_ID,
      'wf-new',
      ATTACHMENT_REF_ACTOR.agent
    );
    expect(result).toEqual({
      aiIndexId: 'my-ai-index',
      workflowId: 'wf-new',
      status: 'saved_and_attached',
    });
  });

  it('returns already_attached when the workflow is already linked', async () => {
    aiIndexService.addAutomation.mockResolvedValue('already_attached');
    workflowsManagement.createWorkflow.mockResolvedValue({ id: 'wf-existing', name: 'pilot' });

    const attachments = createAttachmentStateManager();

    const result = await saveAutomationHandler({
      params: { workflowAttachmentId: WORKFLOW_ATTACHMENT_ID },
      request,
      spaceId: 'default',
      attachments: attachments as never,
      logger,
      getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
      getCoreStart,
      getSecurityStart,
      getWorkflowsManagement: () => workflowsManagement as never,
    });

    expect(result.status).toBe('already_attached');
  });

  it('rejects managed AI indices before creating a workflow', async () => {
    aiIndexService.assertCanAcceptAutomation.mockRejectedValue(
      new AiIndexManagedError('my-ai-index')
    );
    workflowsManagement.createWorkflow.mockResolvedValue({ id: 'wf-new', name: 'pilot' });

    const attachments = createAttachmentStateManager();

    await expect(
      saveAutomationHandler({
        params: { workflowAttachmentId: WORKFLOW_ATTACHMENT_ID },
        request,
        spaceId: 'default',
        attachments: attachments as never,
        logger,
        getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
        getCoreStart,
        getSecurityStart,
        getWorkflowsManagement: () => workflowsManagement as never,
      })
    ).rejects.toBeInstanceOf(AiIndexManagedError);

    expect(workflowsManagement.createWorkflow).not.toHaveBeenCalled();
    expect(workflowsManagement.deleteWorkflows).not.toHaveBeenCalled();
    expect(aiIndexService.addAutomation).not.toHaveBeenCalled();
    expect(attachments.updateOrigin).not.toHaveBeenCalled();
  });

  it('rejects when the automation limit is reached before creating a workflow', async () => {
    aiIndexService.assertCanAcceptAutomation.mockRejectedValue(
      new Error(
        `AI index "my-ai-index" already has the maximum number of automations (${MAX_AI_INDEX_AUTOMATIONS}).`
      )
    );
    workflowsManagement.createWorkflow.mockResolvedValue({ id: 'wf-new', name: 'pilot' });

    const attachments = createAttachmentStateManager();

    await expect(
      saveAutomationHandler({
        params: { workflowAttachmentId: WORKFLOW_ATTACHMENT_ID },
        request,
        spaceId: 'default',
        attachments: attachments as never,
        logger,
        getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
        getCoreStart,
        getSecurityStart,
        getWorkflowsManagement: () => workflowsManagement as never,
      })
    ).rejects.toThrow(/maximum number of automations/);

    expect(workflowsManagement.createWorkflow).not.toHaveBeenCalled();
    expect(workflowsManagement.deleteWorkflows).not.toHaveBeenCalled();
    expect(aiIndexService.addAutomation).not.toHaveBeenCalled();
    expect(attachments.updateOrigin).not.toHaveBeenCalled();
  });

  it('rejects managed AI indices before attaching by workflow id', async () => {
    aiIndexService.assertCanAcceptAutomation.mockRejectedValue(
      new AiIndexManagedError('my-ai-index')
    );

    await expect(
      saveAutomationHandler({
        params: { workflowId: 'wf-new' },
        request,
        spaceId: 'default',
        attachments: createAttachmentStateManager() as never,
        logger,
        getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
        getCoreStart,
        getSecurityStart,
        getWorkflowsManagement: () => workflowsManagement as never,
      })
    ).rejects.toBeInstanceOf(AiIndexManagedError);

    expect(aiIndexService.addAutomation).not.toHaveBeenCalled();
  });

  it('does not roll back workflows created in the edit flow when attach fails', async () => {
    aiIndexService.assertCanAcceptAutomation.mockRejectedValue(
      new AiIndexManagedError('my-ai-index')
    );

    await expect(
      saveAutomationHandler({
        params: { workflowAttachmentId: WORKFLOW_ATTACHMENT_ID },
        request,
        spaceId: 'default',
        attachments: createAttachmentStateManager({ origin: 'wf-persisted' }) as never,
        logger,
        getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
        getCoreStart,
        getSecurityStart,
        getWorkflowsManagement: () => workflowsManagement as never,
      })
    ).rejects.toBeInstanceOf(AiIndexManagedError);

    expect(workflowsManagement.createWorkflow).not.toHaveBeenCalled();
    expect(workflowsManagement.updateWorkflow).not.toHaveBeenCalled();
    expect(workflowsManagement.deleteWorkflows).not.toHaveBeenCalled();
    expect(aiIndexService.addAutomation).not.toHaveBeenCalled();
  });

  it('rolls back a newly created workflow when attach fails after pre-check', async () => {
    aiIndexService.addAutomation.mockRejectedValue(new AiIndexManagedError('my-ai-index'));
    workflowsManagement.createWorkflow.mockResolvedValue({ id: 'wf-new', name: 'pilot' });

    const attachments = createAttachmentStateManager();

    await expect(
      saveAutomationHandler({
        params: { workflowAttachmentId: WORKFLOW_ATTACHMENT_ID },
        request,
        spaceId: 'default',
        attachments: attachments as never,
        logger,
        getAiIndexService: async () => aiIndexService as unknown as AiIndexService,
        getCoreStart,
        getSecurityStart,
        getWorkflowsManagement: () => workflowsManagement as never,
      })
    ).rejects.toBeInstanceOf(AiIndexManagedError);

    expect(workflowsManagement.createWorkflow).toHaveBeenCalled();
    expect(workflowsManagement.deleteWorkflows).toHaveBeenCalledWith(
      ['wf-new'],
      'default',
      request
    );
    expect(attachments.updateOrigin).not.toHaveBeenCalled();
  });
});
