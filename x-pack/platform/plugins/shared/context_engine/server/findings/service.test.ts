/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { elasticsearchServiceMock } from '@kbn/core/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import type {
  Finding,
  FindingInput,
  InvestigationRecord,
  InvestigationStrategy,
} from '../../common/http_api/findings';
import { FINDINGS_INDEX } from '../../common/http_api/findings';
import {
  FindingNotFoundError,
  InvalidInvestigationActionError,
  InvestigationNotFoundError,
} from './errors';
import { buildFindingId } from './identity';
import { FindingsService } from './service';
import { createFindingsClient } from './storage';

jest.mock('./storage');

const createFindingsClientMock = createFindingsClient as jest.MockedFunction<
  typeof createFindingsClient
>;

const AI_INDEX_ID = 'support-context';
const INVESTIGATION_ID = 'inv-1';

const makeInvestigation = (overrides: Partial<InvestigationRecord> = {}): InvestigationRecord => ({
  doc_type: 'investigation',
  investigation_id: INVESTIGATION_ID,
  ai_index_id: AI_INDEX_ID,
  stage: 'scoped',
  '@timestamp': '2026-09-01T00:00:00.000Z',
  started_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  scope: { mode: 'both', sources: [{ type: 'esql', value: 'FROM support-tickets' }] },
  finding_ids: [],
  ...overrides,
});

const makeInput = (overrides: Partial<FindingInput> = {}): FindingInput => ({
  kind: 'tool_error',
  evidence_type: 'observed',
  title: 'execute_esql fails on host.name',
  summary: 'Verification exceptions on a renamed field.',
  subject: 'execute_esql:verification_exception:host.name',
  confidence: 'confirmed',
  impact: 'high',
  ki_usefulness: 'likely',
  prevalence: {
    affected_requests: 12,
    sampled_requests: 100,
    affected_fraction: 0.12,
    distinct_conversations: 6,
  },
  evidence: { counts: { errors: 12 } },
  ...overrides,
});

const idOf = (input: FindingInput) =>
  buildFindingId({ aiIndexId: AI_INDEX_ID, kind: input.kind, subject: input.subject });

const makeFinding = (input: FindingInput, overrides: Partial<Finding> = {}): Finding => ({
  ...input,
  doc_type: 'finding',
  finding_id: idOf(input),
  ai_index_id: AI_INDEX_ID,
  investigation_id: 'inv-0',
  '@timestamp': '2026-08-01T00:00:00.000Z',
  first_seen_at: '2026-08-01T00:00:00.000Z',
  last_seen_at: '2026-08-01T00:00:00.000Z',
  seen_count: 1,
  ki_eligible: true,
  gate: { rule: 'prevalence', passed: true, reason: 'recurs' },
  status: 'open',
  ...overrides,
});

const searchResponse = <T>(documents: T[], total = documents.length) => ({
  hits: { hits: documents.map((document) => ({ _source: document })), total: { value: total } },
});

describe('FindingsService', () => {
  const client = { bulk: jest.fn(), search: jest.fn() } as unknown as ReturnType<
    typeof createFindingsClient
  >;
  const bulk = client.bulk as jest.Mock;
  const search = client.search as jest.Mock;
  const esClient = elasticsearchServiceMock.createElasticsearchClient();
  const logger = loggerMock.create();
  let service: FindingsService;

  /** Routes `search` calls by the filter they carry, so a test can seed both doc kinds. */
  const seed = ({
    investigation,
    findings = [],
  }: {
    investigation?: InvestigationRecord;
    findings?: Finding[];
  }) => {
    search.mockImplementation(async (request: { query: { bool: { filter: unknown[] } } }) => {
      const filters = JSON.stringify(request.query.bool.filter);
      if (filters.includes('"doc_type":"investigation"')) {
        return searchResponse(investigation ? [investigation] : []);
      }
      const requested = request.query.bool.filter.find(
        (filter): filter is { terms: { finding_id: string[] } } =>
          typeof filter === 'object' &&
          filter !== null &&
          'terms' in filter &&
          'finding_id' in (filter as { terms: Record<string, unknown> }).terms
      );
      if (requested) {
        return searchResponse(
          findings.filter((finding) => requested.terms.finding_id.includes(finding.finding_id))
        );
      }
      return searchResponse(findings);
    });
  };

  const bulkDocuments = (): Array<Finding | InvestigationRecord> =>
    bulk.mock.calls.flatMap(([{ operations }]) =>
      operations.map(
        (operation: { index: { document: Finding | InvestigationRecord } }) =>
          operation.index.document
      )
    );

  const lastInvestigationWritten = (): InvestigationRecord =>
    bulkDocuments()
      .filter((document): document is InvestigationRecord => document.doc_type === 'investigation')
      .at(-1) as InvestigationRecord;

  const findingsWritten = (): Finding[] =>
    bulkDocuments().filter((document): document is Finding => document.doc_type === 'finding');

  beforeEach(() => {
    jest.clearAllMocks();
    createFindingsClientMock.mockReturnValue(client);
    bulk.mockResolvedValue({ errors: false, items: [] });
    search.mockResolvedValue(searchResponse([]));
    service = new FindingsService({ esClient, logger });
  });

  describe('startInvestigation', () => {
    it('writes a scoped record keyed by its id', async () => {
      const investigation = await service.startInvestigation({
        aiIndexId: AI_INDEX_ID,
        scope: { mode: 'sources', sources: [] },
        startedBy: 'elastic',
        investigationId: 'given-id',
      });

      expect(investigation).toMatchObject({
        doc_type: 'investigation',
        investigation_id: 'given-id',
        stage: 'scoped',
        started_by: 'elastic',
        finding_ids: [],
      });
      const [{ operations, refresh }] = bulk.mock.calls[0];
      expect(operations[0].index._id).toBe('given-id');
      expect(refresh).toBe('wait_for');
    });
  });

  describe('recordFindings', () => {
    it('throws when the investigation does not exist', async () => {
      await expect(
        service.recordFindings({ investigationId: 'nope', findings: [makeInput()] })
      ).rejects.toBeInstanceOf(InvestigationNotFoundError);
    });

    it('fingerprints, gates and upserts new findings, then moves the run to findings_recorded', async () => {
      seed({ investigation: makeInvestigation() });

      const { investigation, findings, suppressed } = await service.recordFindings({
        investigationId: INVESTIGATION_ID,
        findings: [makeInput()],
        accessMode: 'queries',
        runSummary: { checks_run: 13, fired: 1 },
      });

      expect(suppressed).toEqual([]);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        finding_id: idOf(makeInput()),
        status: 'open',
        seen_count: 1,
        ki_eligible: true,
        gate: { rule: 'prevalence', passed: true },
      });
      expect(investigation).toMatchObject({
        stage: 'findings_recorded',
        finding_ids: [idOf(makeInput())],
        access_mode: 'queries',
        run_summary: { checks_run: 13, fired: 1 },
      });
      // Finding and investigation are written in a single bulk.
      expect(bulk).toHaveBeenCalledTimes(1);
      expect(bulk.mock.calls[0][0].operations).toHaveLength(2);
    });

    it('merges two inputs with the same fingerprint into one finding', async () => {
      seed({ investigation: makeInvestigation() });

      const { findings } = await service.recordFindings({
        investigationId: INVESTIGATION_ID,
        findings: [
          makeInput(),
          makeInput({
            title: 'Reworded title',
            subject: '  EXECUTE_ESQL:verification_exception:host.name ',
          }),
        ],
      });

      expect(findings).toHaveLength(1);
      expect(findings[0].title).toBe('Reworded title');
    });

    it('suppresses a fingerprint that carries a prior dismiss decision and keeps its history', async () => {
      const prior = makeFinding(makeInput(), {
        status: 'decided',
        seen_count: 2,
        first_seen_at: '2026-07-01T00:00:00.000Z',
        decision: {
          decision: 'dismiss',
          reason: 'Field was renamed on purpose',
          decided_at: '2026-08-02T00:00:00.000Z',
          decided_by: 'elastic',
        },
      });
      seed({ investigation: makeInvestigation(), findings: [prior] });

      const { findings, suppressed } = await service.recordFindings({
        investigationId: INVESTIGATION_ID,
        findings: [makeInput()],
      });

      expect(suppressed).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        status: 'suppressed',
        seen_count: 3,
        first_seen_at: '2026-07-01T00:00:00.000Z',
        suppressed_by: { decision: 'dismiss', reason: 'Field was renamed on purpose' },
      });
    });

    it('keeps a create_ki decision and downstream status on a re-observed finding', async () => {
      const prior = makeFinding(makeInput(), {
        status: 'generated',
        decision: { decision: 'create_ki', decided_at: '2026-08-02T00:00:00.000Z' },
        outcome: { ki_ids: ['ki-1'], updated_at: '2026-08-03T00:00:00.000Z' },
      });
      seed({ investigation: makeInvestigation(), findings: [prior] });

      const { findings, suppressed } = await service.recordFindings({
        investigationId: INVESTIGATION_ID,
        findings: [makeInput()],
      });

      expect(suppressed).toEqual([]);
      expect(findings[0]).toMatchObject({
        status: 'generated',
        decision: { decision: 'create_ki' },
        outcome: { ki_ids: ['ki-1'] },
      });
    });

    it('marks rare observed findings as not eligible but still records them', async () => {
      seed({ investigation: makeInvestigation() });

      const { findings } = await service.recordFindings({
        investigationId: INVESTIGATION_ID,
        findings: [
          makeInput({
            prevalence: {
              affected_requests: 1,
              sampled_requests: 100,
              affected_fraction: 0.01,
              distinct_conversations: 1,
            },
          }),
        ],
      });

      expect(findings[0]).toMatchObject({ ki_eligible: false, status: 'open' });
    });

    it('discards a stale strategy and plan when findings are re-recorded', async () => {
      seed({
        investigation: makeInvestigation({
          stage: 'planned',
          strategy: {
            shape: 'none',
            families: [],
            targeted_kis: [],
            cost_estimate: '',
            rationale: '',
          },
          plan: { workflows: [], targeted_kis: [] },
        }),
      });

      const { investigation } = await service.recordFindings({
        investigationId: INVESTIGATION_ID,
        findings: [makeInput()],
      });

      expect(investigation.stage).toBe('findings_recorded');
      expect(investigation.strategy).toBeUndefined();
      expect(investigation.plan).toBeUndefined();
    });

    it('rejects more findings than the per-run cap', async () => {
      seed({ investigation: makeInvestigation() });
      const many = Array.from({ length: 51 }, (_, index) =>
        makeInput({ subject: `tool:${index}` })
      );

      await expect(
        service.recordFindings({ investigationId: INVESTIGATION_ID, findings: many })
      ).rejects.toBeInstanceOf(InvalidInvestigationActionError);
      expect(bulk).not.toHaveBeenCalled();
    });
  });

  describe('recordDecisions', () => {
    const open = makeFinding(makeInput());

    it('requires findings to have been recorded first', async () => {
      seed({ investigation: makeInvestigation({ stage: 'scoped' }), findings: [open] });

      await expect(
        service.recordDecisions({
          investigationId: INVESTIGATION_ID,
          decisions: [{ finding_id: open.finding_id, decision: 'dismiss' }],
        })
      ).rejects.toBeInstanceOf(InvalidInvestigationActionError);
    });

    it('throws when a finding id is unknown', async () => {
      seed({ investigation: makeInvestigation({ stage: 'findings_recorded' }), findings: [open] });

      await expect(
        service.recordDecisions({
          investigationId: INVESTIGATION_ID,
          decisions: [{ finding_id: 'missing', decision: 'dismiss' }],
        })
      ).rejects.toBeInstanceOf(FindingNotFoundError);
    });

    it('rejects create_ki_and_signal on a hypothesized finding', async () => {
      const hypothesized = makeFinding(
        makeInput({
          kind: 'discovery_risk',
          evidence_type: 'hypothesized',
          subject: 'logs-*:field_overlap',
          prevalence: undefined,
          scale: { affected_units: 12, total_units: 40, unit_kind: 'indices' },
        })
      );
      seed({
        investigation: makeInvestigation({ stage: 'findings_recorded' }),
        findings: [hypothesized],
      });

      await expect(
        service.recordDecisions({
          investigationId: INVESTIGATION_ID,
          decisions: [{ finding_id: hypothesized.finding_id, decision: 'create_ki_and_signal' }],
        })
      ).rejects.toThrow(/only available for observed findings/);
    });

    it('stamps user, time and run on each decision and advances the stage', async () => {
      seed({ investigation: makeInvestigation({ stage: 'findings_recorded' }), findings: [open] });

      const { investigation, findings } = await service.recordDecisions({
        investigationId: INVESTIGATION_ID,
        decisions: [{ finding_id: open.finding_id, decision: 'create_ki', reason: 'Recurs daily' }],
        decidedBy: 'elastic',
      });

      expect(investigation.stage).toBe('decisions_recorded');
      expect(findings[0]).toMatchObject({
        status: 'decided',
        decision: {
          decision: 'create_ki',
          reason: 'Recurs daily',
          decided_by: 'elastic',
          investigation_id: INVESTIGATION_ID,
        },
      });
      expect(findings[0].decision?.decided_at).toEqual(expect.any(String));
      expect(findings[0].suppressed_by).toBeUndefined();
    });

    it('does not move a later stage backwards', async () => {
      seed({ investigation: makeInvestigation({ stage: 'strategy_approved' }), findings: [open] });

      const { investigation } = await service.recordDecisions({
        investigationId: INVESTIGATION_ID,
        decisions: [{ finding_id: open.finding_id, decision: 'dismiss' }],
      });

      expect(investigation.stage).toBe('strategy_approved');
    });
  });

  describe('recordStrategy', () => {
    const decided = makeFinding(makeInput(), {
      status: 'decided',
      decision: { decision: 'create_ki', decided_at: '2026-09-01T00:00:00.000Z' },
    });
    const dismissed = makeFinding(makeInput({ subject: 'other' }), {
      status: 'decided',
      decision: { decision: 'dismiss', decided_at: '2026-09-01T00:00:00.000Z' },
    });
    const strategy: InvestigationStrategy = {
      shape: 'both',
      families: [
        {
          family_id: 'fam-1',
          family: 'index_summary',
          unit_key: '_index',
          unit_count: 40,
          extraction: 'llm',
          freshness: 'static',
          readiness: 'routing_only',
          serves: ['probe-1'],
        },
      ],
      targeted_kis: [{ finding_id: decided.finding_id, ki_type: 'constraint' }],
      cost_estimate: '40 LLM calls once',
      rationale: 'Field overlap affects 12 of 40 indices (measurement m-1).',
    };

    it('requires decisions first', async () => {
      seed({ investigation: makeInvestigation({ stage: 'findings_recorded' }) });

      await expect(
        service.recordStrategy({ investigationId: INVESTIGATION_ID, strategy })
      ).rejects.toBeInstanceOf(InvalidInvestigationActionError);
    });

    it('rejects targeted KIs whose finding was not accepted', async () => {
      seed({
        investigation: makeInvestigation({ stage: 'decisions_recorded' }),
        findings: [decided, dismissed],
      });

      await expect(
        service.recordStrategy({
          investigationId: INVESTIGATION_ID,
          strategy: {
            ...strategy,
            targeted_kis: [{ finding_id: dismissed.finding_id, ki_type: 'constraint' }],
          },
        })
      ).rejects.toThrow(/create_ki decision/);
    });

    it('rejects a systemic strategy without families', async () => {
      seed({
        investigation: makeInvestigation({ stage: 'decisions_recorded' }),
        findings: [decided],
      });

      await expect(
        service.recordStrategy({
          investigationId: INVESTIGATION_ID,
          strategy: { ...strategy, shape: 'systemic', families: [], targeted_kis: [] },
        })
      ).rejects.toThrow(/at least one KI family/);
    });

    it('stores the approved strategy with approval metadata', async () => {
      seed({
        investigation: makeInvestigation({ stage: 'decisions_recorded' }),
        findings: [decided],
      });

      const investigation = await service.recordStrategy({
        investigationId: INVESTIGATION_ID,
        strategy,
        approvedBy: 'elastic',
      });

      expect(investigation.stage).toBe('strategy_approved');
      expect(investigation.strategy).toMatchObject({ shape: 'both', approved_by: 'elastic' });
      expect(investigation.strategy?.approved_at).toEqual(expect.any(String));
    });
  });

  describe('recordPlan', () => {
    const decided = makeFinding(makeInput(), {
      status: 'decided',
      decision: { decision: 'create_ki', decided_at: '2026-09-01T00:00:00.000Z' },
    });
    const approved = makeInvestigation({
      stage: 'strategy_approved',
      strategy: {
        shape: 'both',
        families: [
          {
            family_id: 'fam-1',
            family: 'index_summary',
            unit_key: '_index',
            unit_count: 40,
            extraction: 'llm',
            freshness: 'static',
            readiness: 'routing_only',
            serves: [],
          },
        ],
        targeted_kis: [{ finding_id: decided.finding_id, ki_type: 'constraint' }],
        cost_estimate: '',
        rationale: 'r',
      },
    });

    it('rejects workflows for families outside the approved strategy', async () => {
      seed({ investigation: approved, findings: [decided] });

      await expect(
        service.recordPlan({
          investigationId: INVESTIGATION_ID,
          plan: {
            workflows: [
              {
                plan_item_id: 'p-1',
                family_id: 'fam-unknown',
                name: 'x',
                unit_key: '_index',
                foreach: 'indices',
                readiness: 'routing_only',
                spec: 'spec',
              },
            ],
            targeted_kis: [],
          },
        })
      ).rejects.toThrow(/fam-unknown/);
    });

    it('refuses a targeted KI spec for a finding without a create decision', async () => {
      const dismissed = makeFinding(makeInput({ subject: 'other' }), {
        status: 'decided',
        ki_eligible: false,
        decision: { decision: 'dismiss', decided_at: '2026-09-01T00:00:00.000Z' },
      });
      seed({ investigation: approved, findings: [decided, dismissed] });

      await expect(
        service.recordPlan({
          investigationId: INVESTIGATION_ID,
          plan: {
            workflows: [],
            targeted_kis: [
              {
                plan_item_id: 'p-2',
                finding_id: dismissed.finding_id,
                ki_type: 'constraint',
                title: 'x',
                spec: 'spec',
              },
            ],
          },
        })
      ).rejects.toThrow(/need a create_ki decision/);
    });

    it('stores the plan and marks targeted findings as planned', async () => {
      seed({ investigation: approved, findings: [decided] });

      const investigation = await service.recordPlan({
        investigationId: INVESTIGATION_ID,
        plan: {
          workflows: [
            {
              plan_item_id: 'p-1',
              family_id: 'fam-1',
              name: 'Index summaries',
              unit_key: '_index',
              foreach: 'indices',
              readiness: 'routing_only',
              spec: 'spec',
            },
          ],
          targeted_kis: [
            {
              plan_item_id: 'p-2',
              finding_id: decided.finding_id,
              ki_type: 'constraint',
              title: 'host.name was renamed',
              spec: 'spec',
            },
          ],
        },
      });

      expect(investigation.stage).toBe('planned');
      expect(investigation.plan?.workflows).toHaveLength(1);
      expect(findingsWritten()).toEqual([expect.objectContaining({ status: 'planned' })]);
    });
  });

  describe('recordOutcome', () => {
    const planned = makeFinding(makeInput(), {
      status: 'planned',
      decision: { decision: 'create_ki_and_signal', decided_at: '2026-09-01T00:00:00.000Z' },
    });
    const plannedInvestigation = makeInvestigation({
      stage: 'planned',
      plan: {
        workflows: [
          {
            plan_item_id: 'p-1',
            family_id: 'fam-1',
            name: 'Index summaries',
            unit_key: '_index',
            foreach: 'indices',
            readiness: 'routing_only',
            spec: 'spec',
          },
        ],
        targeted_kis: [
          {
            plan_item_id: 'p-2',
            finding_id: planned.finding_id,
            ki_type: 'constraint',
            title: 't',
            spec: 'spec',
          },
        ],
      },
    });

    it('writes the workflow id back onto the plan item and moves to generated', async () => {
      seed({ investigation: plannedInvestigation, findings: [planned] });

      const { investigation, findings } = await service.recordOutcome({
        investigationId: INVESTIGATION_ID,
        planItemId: 'p-1',
        workflowId: 'wf-1',
      });

      expect(investigation.stage).toBe('generated');
      expect(investigation.plan?.workflows[0].workflow_id).toBe('wf-1');
      expect(findings).toEqual([]);
    });

    it('resolves the finding through a targeted plan item and records the KI', async () => {
      seed({ investigation: plannedInvestigation, findings: [planned] });

      const { investigation, findings } = await service.recordOutcome({
        investigationId: INVESTIGATION_ID,
        planItemId: 'p-2',
        kiIds: ['ki-9'],
        signalKiId: 'sig-1',
      });

      expect(investigation.plan?.targeted_kis[0].ki_id).toBe('ki-9');
      expect(findings[0]).toMatchObject({
        status: 'generated',
        outcome: { ki_ids: ['ki-9'], workflow_ids: [], signal_ki_id: 'sig-1' },
      });
      expect(lastInvestigationWritten().stage).toBe('generated');
    });
  });

  describe('priorDecisions', () => {
    it('returns dismiss and known-issue decisions with the fingerprint fields', async () => {
      const dismissed = makeFinding(makeInput(), {
        status: 'decided',
        decision: {
          decision: 'known_issue',
          reason: 'Tracked',
          decided_at: '2026-09-01T00:00:00.000Z',
        },
      });
      search.mockResolvedValue(searchResponse([dismissed]));

      const prior = await service.priorDecisions(AI_INDEX_ID);

      expect(prior).toEqual([
        expect.objectContaining({
          finding_id: dismissed.finding_id,
          kind: 'tool_error',
          subject: dismissed.subject,
          decision: 'known_issue',
          reason: 'Tracked',
        }),
      ]);
      const [request] = search.mock.calls[0];
      expect(request.query.bool.filter).toContainEqual({
        terms: { 'decision.decision': ['dismiss', 'known_issue'] },
      });
    });
  });

  describe('listFindings', () => {
    it('filters by AI index, run and status, eligible and prevalent first', async () => {
      search.mockResolvedValue(searchResponse([makeFinding(makeInput())], 7));

      const { items, total } = await service.listFindings({
        aiIndexId: AI_INDEX_ID,
        investigationId: INVESTIGATION_ID,
        status: ['open'],
        size: 500,
      });

      expect(items).toHaveLength(1);
      expect(total).toBe(7);
      const [request] = search.mock.calls[0];
      expect(request.size).toBe(200);
      expect(request.query.bool.filter).toEqual([
        { term: { doc_type: 'finding' } },
        { term: { ai_index_id: AI_INDEX_ID } },
        { term: { investigation_id: INVESTIGATION_ID } },
        { terms: { status: ['open'] } },
      ]);
      expect(request.sort[0]).toEqual({ ki_eligible: { order: 'desc' } });
    });
  });

  describe('deleteByAiIndex', () => {
    it('deletes every document for the AI index and tolerates a missing index', async () => {
      await service.deleteByAiIndex(AI_INDEX_ID);

      expect(esClient.deleteByQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          index: FINDINGS_INDEX,
          query: { term: { ai_index_id: AI_INDEX_ID } },
          ignore_unavailable: true,
        })
      );
    });
  });
});
