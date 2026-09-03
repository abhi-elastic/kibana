/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { SIGNAL_KIS_AI_INDEX_ID } from '@kbn/context-engine-plugin/common/constants';
import type {
  AttachmentFinding,
  InvestigationAttachmentData,
} from '@kbn/context-engine-plugin/common/investigation_schemas';
import { INVESTIGATION_ATTACHMENT_TYPE } from '../../common/agent_builder_attachments';
import { CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID } from '../../common/agent_builder_tools';
import { createInvestigationAttachmentType, formatInvestigation } from './investigation';

const makeFinding = (
  index: number,
  overrides: Partial<AttachmentFinding> = {}
): AttachmentFinding => ({
  finding_id: `f-${index}`,
  kind: 'tool_error',
  evidence_type: 'observed',
  title: `execute_esql fails on field_${index}`,
  summary: `Verification exceptions on field_${index}, which was renamed in the last mapping change and is still referenced by generated queries.`,
  subject: `execute_esql:verification_exception:field_${index}`,
  confidence: 'confirmed',
  impact: 'high',
  ki_usefulness: 'likely',
  prevalence: {
    affected_requests: 12 + index,
    sampled_requests: 400,
    affected_fraction: (12 + index) / 400,
    distinct_conversations: 5,
  },
  ki_eligible: true,
  gate: { rule: 'prevalence', passed: true, reason: '12 of 400 requests across 5 conversations' },
  status: 'open',
  ...overrides,
});

const scoped: InvestigationAttachmentData = {
  investigation_id: 'inv-1',
  ai_index_id: 'support-context',
  stage: 'scoped',
  scope: {
    mode: 'both',
    sources: [{ type: 'esql', value: 'FROM support-tickets' }],
    source_summary: {
      valid_sources: 1,
      resolved_indices: ['support-tickets'],
      doc_count: 12000,
      count_capped: false,
    },
    trace: {
      agent_id: 'support-agent',
      from: 'now-7d',
      to: 'now',
      counts: { requests: 400, conversations: 120, tool_calls: 1800, failed_tool_calls: 40 },
    },
  },
  prior_decisions: [
    {
      finding_id: 'f-old',
      kind: 'system_error',
      subject: 'chat:ssl',
      decision: 'known_issue',
      reason: 'Connector certificate renewal in progress',
      decided_at: '2026-08-20T00:00:00.000Z',
    },
  ],
};

describe('investigation attachment type', () => {
  const type = createInvestigationAttachmentType();

  it('is a mutable type exposing only record_investigation', () => {
    expect(type.id).toBe(INVESTIGATION_ATTACHMENT_TYPE);
    expect(type.isReadonly).toBe(false);
    expect(type.getTools?.()).toEqual([CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID]);
    expect(type.getAgentDescription?.()).toContain('stage');
  });

  describe('validate', () => {
    it('accepts a scoped document without findings', async () => {
      expect(type.validate(scoped)).toMatchObject({ valid: true });
    });

    it('requires findings from findings_recorded on', async () => {
      const result = await type.validate({ ...scoped, stage: 'findings_recorded' });
      expect(result).toMatchObject({ valid: false });
      expect((result as { error: string }).error).toContain("'findings' is required");
    });

    it('requires decisions, strategy and plan at their stages', async () => {
      const withFindings = { ...scoped, stage: 'decisions_recorded', findings: [makeFinding(1)] };
      expect((await type.validate(withFindings)) as { error: string }).toMatchObject({
        error: expect.stringContaining("'decisions' is required"),
      });

      const withDecisions = {
        ...withFindings,
        stage: 'strategy_approved',
        decisions: [{ finding_id: 'f-1', decision: 'create_ki' }],
      };
      expect((await type.validate(withDecisions)) as { error: string }).toMatchObject({
        error: expect.stringContaining("'strategy' is required"),
      });

      const withStrategy = {
        ...withDecisions,
        stage: 'planned',
        strategy: {
          shape: 'targeted_only',
          families: [],
          targeted_kis: [{ finding_id: 'f-1', ki_type: 'constraint' }],
          cost_estimate: '',
          rationale: 'f-1 accepted',
        },
      };
      expect((await type.validate(withStrategy)) as { error: string }).toMatchObject({
        error: expect.stringContaining("'plan' is required"),
      });

      expect(
        type.validate({ ...withStrategy, plan: { workflows: [], targeted_kis: [] } })
      ).toMatchObject({ valid: true });
    });

    it('rejects a strategy whose shape and contents disagree', async () => {
      const result = await type.validate({
        ...scoped,
        stage: 'strategy_approved',
        findings: [],
        decisions: [],
        strategy: {
          shape: 'systemic',
          families: [],
          targeted_kis: [],
          cost_estimate: '',
          rationale: 'r',
        },
      });
      expect((result as { error: string }).error).toContain('at least one family');
    });
  });

  describe('format', () => {
    it('renders the scope, prior decisions and a compact findings table', () => {
      const text = formatInvestigation({
        ...scoped,
        stage: 'findings_recorded',
        findings: [
          makeFinding(1),
          makeFinding(2, {
            ki_eligible: false,
            gate: { rule: 'prevalence', passed: false, reason: '1 of 400 requests' },
          }),
          makeFinding(3, {
            status: 'suppressed',
            suppressed_by: {
              decision: 'dismiss',
              reason: 'Not our agent',
              decided_at: '2026-08-01T00:00:00.000Z',
            },
          }),
        ],
        run_summary: { checks_run: 13, eligible: 1, rare: 1, not_fired: 9, skipped: 2 },
      });

      expect(text).toContain('Stage: findings_recorded');
      expect(text).toContain('Sources: esql:FROM support-tickets');
      expect(text).toContain('Traces: agent support-agent, now-7d to now');
      expect(text).toContain('Prior decisions (1, do not ask again)');
      expect(text).toContain('known_issue: system_error chat:ssl — Connector certificate renewal');
      expect(text).toContain('Findings: 3 total, 1 KI-eligible, 1 rare, 1 suppressed');
      expect(text).toContain('| f-1 | tool_error | observed |');
      expect(text).toContain('Rare in this range: f-2');
      expect(text).toContain(
        'Suppressed: f-3 tool_error execute_esql:verification_exception:field_3 (dismiss: Not our agent)'
      );
      expect(text).toContain('Run summary: checks_run=13');
      // Evidence bodies never reach the LLM through the attachment.
      expect(text).not.toContain('sample_trace_ids');
    });

    it('stays under 10,000 characters for a twelve-finding run with strategy and plan', () => {
      const findings = Array.from({ length: 12 }, (_, index) => makeFinding(index + 1));
      const text = formatInvestigation({
        ...scoped,
        stage: 'planned',
        access_mode: 'queries',
        probes: [
          {
            probe_id: 'p1',
            question: 'Which cases mention SSO outages this week?',
            answer_path: ['support-tickets'],
          },
          {
            probe_id: 'p2',
            question: 'What did we tell customer X about the SLA?',
            answer_path: ['support-tickets', 'kb'],
          },
        ],
        measurements: Array.from({ length: 12 }, (_, index) => ({
          measurement_id: `m-${index}`,
          kind: 'fan_out',
          subject: `index-${index}`,
          values: { units: 400, med: 12, p95: 90 },
        })),
        findings,
        decisions: findings.map((finding) => ({
          finding_id: finding.finding_id,
          decision: 'create_ki' as const,
        })),
        strategy: {
          shape: 'both',
          families: [
            {
              family_id: 'fam-1',
              family: 'per-entity snapshot',
              unit_key: 'case_id',
              unit_count: 400,
              extraction: 'llm',
              freshness: 'cursor',
              readiness: 'query_ready',
              serves: ['p1', 'p2'],
            },
          ],
          targeted_kis: findings.map((finding) => ({
            finding_id: finding.finding_id,
            ki_type: 'constraint',
          })),
          cost_estimate: '400 units x ~3k tokens = ~1.2M tokens',
          rationale: 'Fan-out p95 of 90 feed events per case on both probes.',
        },
        plan: {
          workflows: [
            {
              plan_item_id: 'w-1',
              family_id: 'fam-1',
              name: 'Case snapshots',
              unit_key: 'case_id',
              foreach: 'FROM support-tickets | STATS BY case_id',
              freshness_cursor: 'updated_at',
              readiness: 'query_ready',
              spec: 'spec',
            },
          ],
          targeted_kis: findings.map((finding, index) => ({
            plan_item_id: `k-${index}`,
            finding_id: finding.finding_id,
            ki_type: 'constraint',
            title: finding.title,
            spec: 'spec',
          })),
        },
      });

      expect(text.length).toBeLessThan(10_000);
      expect(text).toContain('Strategy: shape both (proposed)');
      expect(text).toContain('Primary family fam-1: per-entity snapshot, unit case_id (400 units)');
      expect(text).toContain('Plan: 1 workflow spec(s), 12 targeted KI spec(s)');
    });

    it('carries every plan spec and the signals AI index id into the planned view', () => {
      const longSpec = 'x'.repeat(5_000);
      const text = formatInvestigation({
        ...scoped,
        stage: 'planned',
        findings: [],
        decisions: [],
        strategy: {
          shape: 'systemic',
          families: [
            {
              family_id: 'fam-1',
              family: 'per-entity snapshot',
              unit_key: 'case_id',
              unit_count: 400,
              extraction: 'llm',
              freshness: 'cursor',
              readiness: 'routing_only',
              serves: ['p1'],
            },
          ],
          targeted_kis: [],
          cost_estimate: 'estimate',
          rationale: 'fan-out',
        },
        plan: {
          workflows: [
            {
              plan_item_id: 'wf-fam-1',
              family_id: 'fam-1',
              name: 'Case snapshots',
              unit_key: 'case_id',
              foreach: 'FROM support-tickets | STATS BY case_id',
              readiness: 'routing_only',
              spec: longSpec,
            },
          ],
          targeted_kis: [
            {
              plan_item_id: 'ki-f1',
              finding_id: 'f1',
              ki_type: 'constraint',
              title: 'ES|QL on logs-app: message is text',
              spec: '{"type":"constraint"}\nsignal: true',
              ki_id: 'targeted/f1',
            },
          ],
        },
      });

      expect(text).toContain(
        `Signals AI index id (dual-write target for create_ki_and_signal): ${SIGNAL_KIS_AI_INDEX_ID}`
      );
      expect(text).toContain('Spec wf-fam-1:');
      expect(text).toContain('… (1000 more chars)');
      expect(text).toContain('Spec ki-f1:\n{"type":"constraint"}\nsignal: true');
    });
  });
});
