/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ATTACHMENT_REF_ACTOR } from '@kbn/agent-builder-common/attachments';
import type { AttachmentStateManager } from '@kbn/agent-builder-server/attachments';
import { httpServerMock } from '@kbn/core-http-server-mocks';
import { elasticsearchServiceMock, loggingSystemMock } from '@kbn/core/server/mocks';
import type { CoreStart } from '@kbn/core/server';
import type {
  Finding,
  FindingInput,
  InvestigationRecord,
} from '@kbn/context-engine-plugin/common/http_api/findings';
import type { InvestigationAttachmentData } from '@kbn/context-engine-plugin/common/investigation_schemas';
import type { FindingsServiceApi } from '@kbn/context-engine-plugin/server/findings/service';
import { INVESTIGATION_ATTACHMENT_TYPE } from '../../../../common/agent_builder_attachments';
import {
  findInvestigationAttachment,
  recordInvestigationHandler,
  resolveInvestigationId,
} from './handler';

jest.mock('../../assert_context_engine_write_access', () => ({
  assertContextEngineWriteAccess: jest.fn().mockResolvedValue(undefined),
}));

const { assertContextEngineWriteAccess } = jest.requireMock(
  '../../assert_context_engine_write_access'
);

const INVESTIGATION_ID = 'inv-1';
const AI_INDEX_ID = 'support-context';
const ATTACHMENT_ID = 'investigation-attachment';

const scopedData: InvestigationAttachmentData = {
  investigation_id: INVESTIGATION_ID,
  ai_index_id: AI_INDEX_ID,
  stage: 'scoped',
  scope: { mode: 'sources', sources: [{ type: 'esql', value: 'FROM support-tickets' }] },
  prior_decisions: [],
};

const makeInvestigation = (overrides: Partial<InvestigationRecord> = {}): InvestigationRecord => ({
  doc_type: 'investigation',
  investigation_id: INVESTIGATION_ID,
  ai_index_id: AI_INDEX_ID,
  stage: 'scoped',
  '@timestamp': '2026-09-01T00:00:00.000Z',
  started_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  scope: scopedData.scope,
  finding_ids: [],
  ...overrides,
});

const input: FindingInput = {
  kind: 'discovery_risk',
  evidence_type: 'hypothesized',
  title: 'Twelve indices share field names',
  summary: 'logs-* indices overlap on 80% of top-level fields.',
  subject: 'logs-*:field_overlap',
  confidence: 'strong',
  impact: 'medium',
  ki_usefulness: 'likely',
  scale: { affected_units: 12, total_units: 40, unit_kind: 'indices' },
  evidence: { measured_property: 'field_overlap' },
};

const makeFinding = (overrides: Partial<Finding> = {}): Finding => ({
  ...input,
  doc_type: 'finding',
  finding_id: 'f-1',
  ai_index_id: AI_INDEX_ID,
  investigation_id: INVESTIGATION_ID,
  '@timestamp': '2026-09-01T00:00:00.000Z',
  first_seen_at: '2026-09-01T00:00:00.000Z',
  last_seen_at: '2026-09-01T00:00:00.000Z',
  seen_count: 1,
  ki_eligible: true,
  gate: { rule: 'scale', passed: true, reason: 'affects 12 of 40 indices' },
  status: 'open',
  ...overrides,
});

const createAttachments = (data: InvestigationAttachmentData | null = scopedData) => {
  const records = data
    ? [
        {
          id: ATTACHMENT_ID,
          type: INVESTIGATION_ATTACHMENT_TYPE,
          current_version: 1,
          versions: [{ version: 1, data }],
        },
      ]
    : [];
  return {
    getActive: jest.fn().mockReturnValue(records),
    getAll: jest.fn().mockReturnValue(records),
    update: jest.fn().mockResolvedValue({ id: ATTACHMENT_ID, current_version: 2 }),
    add: jest.fn().mockResolvedValue({ id: 'new-attachment', current_version: 1 }),
  } as unknown as AttachmentStateManager & {
    update: jest.Mock;
    add: jest.Mock;
  };
};

const createService = () =>
  ({
    recordFindings: jest.fn(),
    recordDecisions: jest.fn(),
    recordStrategy: jest.fn(),
    recordPlan: jest.fn(),
    getFindings: jest.fn().mockResolvedValue([]),
    priorDecisions: jest.fn().mockResolvedValue([]),
  } as unknown as FindingsServiceApi & {
    recordFindings: jest.Mock;
    recordDecisions: jest.Mock;
    recordStrategy: jest.Mock;
    recordPlan: jest.Mock;
    getFindings: jest.Mock;
    priorDecisions: jest.Mock;
  });

describe('record_investigation handler', () => {
  const request = httpServerMock.createKibanaRequest();
  const logger = loggingSystemMock.createLogger();
  const esClient = elasticsearchServiceMock.createElasticsearchClient();
  const coreStart = {
    security: { authc: { getCurrentUser: jest.fn().mockReturnValue({ username: 'elastic' }) } },
  } as unknown as CoreStart;
  let service: ReturnType<typeof createService>;

  const run = (
    params: Parameters<typeof recordInvestigationHandler>[0]['params'],
    attachments = createAttachments()
  ) =>
    recordInvestigationHandler({
      params,
      request,
      spaceId: 'default',
      esClient,
      attachments,
      logger,
      getCoreStart: async () => coreStart,
      getSecurityStart: async () => undefined,
      getFindingsService: async () => service,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    service = createService();
  });

  describe('resolveInvestigationId', () => {
    it('reads the id from the newest investigation attachment', () => {
      expect(resolveInvestigationId(createAttachments())).toMatchObject({
        investigationId: INVESTIGATION_ID,
        attachment: { id: ATTACHMENT_ID },
      });
    });

    it('prefers an explicit id and ignores attachments for another run', () => {
      const resolved = resolveInvestigationId(createAttachments(), 'inv-other');
      expect(resolved.investigationId).toBe('inv-other');
      expect(resolved.attachment).toBeUndefined();
      expect(findInvestigationAttachment(createAttachments(), 'inv-other')).toBeUndefined();
    });

    it('throws when neither an id nor an attachment is available', () => {
      expect(() => resolveInvestigationId(createAttachments(null))).toThrow(
        /No investigation attachment found/
      );
    });
  });

  it('checks Context Engine write access before writing', async () => {
    assertContextEngineWriteAccess.mockRejectedValueOnce(new Error('nope'));
    await expect(run({ action: 'findings', findings: [] })).rejects.toThrow('nope');
    expect(service.recordFindings).not.toHaveBeenCalled();
  });

  it('records findings, returns the gate verdicts and versions the attachment to findings_recorded', async () => {
    const eligible = makeFinding();
    const suppressed = makeFinding({
      finding_id: 'f-2',
      subject: 'other',
      ki_eligible: false,
      gate: { rule: 'scale', passed: false, reason: 'affects 1 of 40 indices' },
      status: 'suppressed',
      suppressed_by: {
        decision: 'dismiss',
        reason: 'Legacy indices',
        decided_at: '2026-08-01T00:00:00.000Z',
      },
    });
    const investigation = makeInvestigation({
      stage: 'findings_recorded',
      finding_ids: ['f-1', 'f-2'],
      access_mode: 'queries',
    });
    service.recordFindings.mockResolvedValue({
      investigation,
      findings: [eligible, suppressed],
      suppressed: [suppressed],
    });
    service.getFindings.mockResolvedValue([eligible, suppressed]);
    const attachments = createAttachments();

    const result = await run(
      {
        action: 'findings',
        findings: [input, { ...input, subject: 'other' }],
        access_mode: 'queries',
        run_summary: { checks_run: 6 },
      },
      attachments
    );

    expect(service.recordFindings).toHaveBeenCalledWith({
      investigationId: INVESTIGATION_ID,
      findings: [input, { ...input, subject: 'other' }],
      accessMode: 'queries',
      probes: undefined,
      measurements: undefined,
      runSummary: { checks_run: 6 },
    });
    expect(result).toMatchObject({
      action: 'findings',
      stage: 'findings_recorded',
      attachment_id: ATTACHMENT_ID,
      attachment_version: 2,
      findings: [
        { finding_id: 'f-1', ki_eligible: true, status: 'open' },
        {
          finding_id: 'f-2',
          ki_eligible: false,
          status: 'suppressed',
          suppressed_reason: 'Legacy indices',
        },
      ],
    });
    expect(attachments.update).toHaveBeenCalledWith(
      ATTACHMENT_ID,
      {
        data: expect.objectContaining({
          stage: 'findings_recorded',
          access_mode: 'queries',
          findings: [
            expect.objectContaining({ finding_id: 'f-1', ki_eligible: true }),
            expect.objectContaining({ finding_id: 'f-2', status: 'suppressed' }),
          ],
        }),
      },
      ATTACHMENT_REF_ACTOR.agent
    );
    // Evidence never travels on the attachment.
    expect(attachments.update.mock.calls[0][1].data.findings[0]).not.toHaveProperty('evidence');
  });

  it('records decisions with the current user and summarises them', async () => {
    const decided = makeFinding({
      status: 'decided',
      decision: { decision: 'create_ki', decided_at: 'now', decided_by: 'elastic' },
    });
    service.recordDecisions.mockResolvedValue({
      investigation: makeInvestigation({ stage: 'decisions_recorded', finding_ids: ['f-1'] }),
      findings: [decided],
    });
    service.getFindings.mockResolvedValue([decided]);
    const attachments = createAttachments({
      ...scopedData,
      stage: 'findings_recorded',
      findings: [],
    });

    const result = await run(
      {
        action: 'decisions',
        decisions: [{ finding_id: 'f-1', decision: 'create_ki', reason: 'Recurs' }],
      },
      attachments
    );

    expect(service.recordDecisions).toHaveBeenCalledWith({
      investigationId: INVESTIGATION_ID,
      decisions: [{ finding_id: 'f-1', decision: 'create_ki', reason: 'Recurs' }],
      decidedBy: 'elastic',
    });
    expect(result).toMatchObject({
      action: 'decisions',
      stage: 'decisions_recorded',
      decision_counts: { create_ki: 1 },
    });
    expect(attachments.update.mock.calls[0][1].data.decisions).toEqual([
      { finding_id: 'f-1', decision: 'create_ki' },
    ]);
  });

  it('records the strategy and the plan with their stages', async () => {
    const strategy = {
      shape: 'none' as const,
      families: [],
      targeted_kis: [],
      cost_estimate: '',
      rationale: '',
    };
    service.recordStrategy.mockResolvedValue(
      makeInvestigation({ stage: 'strategy_approved', strategy })
    );
    const strategyResult = await run({ action: 'strategy', strategy });
    expect(service.recordStrategy).toHaveBeenCalledWith({
      investigationId: INVESTIGATION_ID,
      strategy,
      approvedBy: 'elastic',
    });
    expect(strategyResult).toMatchObject({
      action: 'strategy',
      stage: 'strategy_approved',
      strategy_shape: 'none',
    });

    const plan = { workflows: [], targeted_kis: [] };
    service.recordPlan.mockResolvedValue(makeInvestigation({ stage: 'planned', strategy, plan }));
    const planResult = await run({ action: 'plan', plan });
    expect(service.recordPlan).toHaveBeenCalledWith({ investigationId: INVESTIGATION_ID, plan });
    expect(planResult).toMatchObject({
      action: 'plan',
      stage: 'planned',
      plan_items: { workflows: 0, targeted_kis: 0 },
    });
  });

  it('adds an attachment when the run was referenced by id only', async () => {
    service.recordFindings.mockResolvedValue({
      investigation: makeInvestigation({ stage: 'findings_recorded' }),
      findings: [],
      suppressed: [],
    });
    const attachments = createAttachments(null);

    const result = await run(
      { action: 'findings', investigationId: INVESTIGATION_ID, findings: [] },
      attachments
    );

    expect(attachments.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: INVESTIGATION_ATTACHMENT_TYPE,
        data: expect.objectContaining({ stage: 'findings_recorded', findings: [] }),
      }),
      ATTACHMENT_REF_ACTOR.agent
    );
    expect(result.attachment_id).toBeUndefined();
    expect(result.attachment_version).toBe(1);
  });
});
