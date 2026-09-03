/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types';
import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import { isResponseError } from '@kbn/es-errors';
import { v4 as uuidv4 } from 'uuid';
import {
  DEFAULT_FINDINGS_PAGE_SIZE,
  MAX_FINDINGS_PAGE_SIZE,
  MAX_FINDINGS_PER_INVESTIGATION,
  MAX_INVESTIGATIONS_PAGE_SIZE,
} from '../../common/constants';
import type {
  AccessMode,
  Finding,
  FindingDecision,
  FindingDecisionRecord,
  FindingInput,
  FindingStatus,
  InvestigationMeasurement,
  InvestigationPlan,
  InvestigationProbe,
  InvestigationRecord,
  InvestigationScopeSnapshot,
  InvestigationStrategy,
  ListFindingsResponse,
  ListInvestigationsResponse,
  PriorDecision,
} from '../../common/http_api/findings';
import {
  CREATE_DECISIONS,
  FINDINGS_INDEX,
  SUPPRESSING_DECISIONS,
} from '../../common/http_api/findings';
import { investigationStageIndex } from '../../common/investigation';
import type { InvestigationStage } from '../../common/investigation';
import {
  FindingNotFoundError,
  InvalidInvestigationActionError,
  InvestigationNotFoundError,
} from './errors';
import type { GateThresholds } from './gates';
import { applyGate } from './gates';
import { buildFindingId } from './identity';
import type { FindingsClient } from './storage';
import { createFindingsClient } from './storage';

const FINDING_DOCS: QueryDslQueryContainer = { term: { doc_type: 'finding' } };
const INVESTIGATION_DOCS: QueryDslQueryContainer = { term: { doc_type: 'investigation' } };

export interface StartInvestigationParams {
  aiIndexId: string;
  scope: InvestigationScopeSnapshot;
  startedBy?: string;
  /** Supplied by the page so the attachment and the store agree on the id before the first write. */
  investigationId?: string;
}

export interface RecordFindingsParams {
  investigationId: string;
  findings: FindingInput[];
  thresholds?: GateThresholds;
  accessMode?: AccessMode;
  probes?: InvestigationProbe[];
  measurements?: InvestigationMeasurement[];
  runSummary?: Record<string, number>;
}

export interface RecordFindingsResult {
  investigation: InvestigationRecord;
  findings: Finding[];
  /** Occurrences that matched a prior dismiss / known-issue decision. */
  suppressed: Finding[];
}

export interface FindingDecisionInput {
  finding_id: string;
  decision: FindingDecision;
  reason?: string;
}

export interface RecordDecisionsParams {
  investigationId: string;
  decisions: FindingDecisionInput[];
  decidedBy?: string;
}

export interface RecordOutcomeParams {
  investigationId: string;
  /** Plan item the artefact came from; resolves the finding ids through the stored plan. */
  planItemId?: string;
  findingIds?: string[];
  workflowId?: string;
  kiIds?: string[];
  signalKiId?: string;
}

export interface ListFindingsOptions {
  aiIndexId: string;
  investigationId?: string;
  status?: FindingStatus[];
  from?: number;
  size?: number;
}

export interface FindingsServiceApi {
  startInvestigation(params: StartInvestigationParams): Promise<InvestigationRecord>;
  getInvestigation(investigationId: string): Promise<InvestigationRecord | undefined>;
  latestInvestigation(aiIndexId: string): Promise<InvestigationRecord | undefined>;
  listInvestigations(
    aiIndexId: string,
    options?: { size?: number }
  ): Promise<ListInvestigationsResponse>;
  recordFindings(params: RecordFindingsParams): Promise<RecordFindingsResult>;
  recordDecisions(
    params: RecordDecisionsParams
  ): Promise<{ investigation: InvestigationRecord; findings: Finding[] }>;
  recordStrategy(params: {
    investigationId: string;
    strategy: InvestigationStrategy;
    approvedBy?: string;
  }): Promise<InvestigationRecord>;
  recordPlan(params: {
    investigationId: string;
    plan: InvestigationPlan;
  }): Promise<InvestigationRecord>;
  recordOutcome(
    params: RecordOutcomeParams
  ): Promise<{ investigation: InvestigationRecord; findings: Finding[] }>;
  /** Dismiss / known-issue decisions for an AI index, used to seed the attachment's `prior_decisions`. */
  priorDecisions(aiIndexId: string): Promise<PriorDecision[]>;
  listFindings(options: ListFindingsOptions): Promise<ListFindingsResponse>;
  getFindings(findingIds: string[]): Promise<Finding[]>;
  deleteByAiIndex(aiIndexId: string): Promise<void>;
}

const toDocuments = <T>(hits: Array<{ _source?: T }>): T[] =>
  hits.flatMap((hit) => (hit._source ? [hit._source] : []));

const totalOf = (total: number | { value: number } | undefined, fallback: number): number =>
  typeof total === 'number' ? total : total?.value ?? fallback;

const requireStage = (
  investigation: InvestigationRecord,
  minimum: InvestigationStage,
  action: string
): void => {
  if (investigationStageIndex(investigation.stage) < investigationStageIndex(minimum)) {
    throw new InvalidInvestigationActionError(
      `Cannot record ${action} while the investigation is at stage '${investigation.stage}'; '${minimum}' is required first.`
    );
  }
};

/** Stages only move forward within a run, except a re-run of findings which restarts from there. */
const advance = (current: InvestigationStage, next: InvestigationStage): InvestigationStage =>
  investigationStageIndex(next) >= investigationStageIndex(current) ? next : current;

/**
 * Owns the global `context-engine-findings` index: one record per investigation run and one per
 * finding fingerprint, both written by the `record_investigation` tool on behalf of the user and
 * read by the Overview page after a reload. Construct one per request with that request's client.
 */
export class FindingsService implements FindingsServiceApi {
  private readonly esClient: ElasticsearchClient;
  private readonly logger: Logger;
  private readonly client: FindingsClient;

  constructor({ esClient, logger }: { esClient: ElasticsearchClient; logger: Logger }) {
    this.esClient = esClient;
    this.logger = logger;
    this.client = createFindingsClient(esClient);
  }

  async startInvestigation({
    aiIndexId,
    scope,
    startedBy,
    investigationId,
  }: StartInvestigationParams): Promise<InvestigationRecord> {
    const now = new Date().toISOString();
    const investigation: InvestigationRecord = {
      doc_type: 'investigation',
      investigation_id: investigationId ?? uuidv4(),
      ai_index_id: aiIndexId,
      stage: 'scoped',
      '@timestamp': now,
      started_at: now,
      updated_at: now,
      ...(startedBy ? { started_by: startedBy } : {}),
      scope,
      finding_ids: [],
    };
    await this.writeInvestigation(investigation);
    return investigation;
  }

  async getInvestigation(investigationId: string): Promise<InvestigationRecord | undefined> {
    const response = await this.client.search<InvestigationRecord>({
      size: 1,
      track_total_hits: false,
      query: {
        bool: { filter: [INVESTIGATION_DOCS, { term: { investigation_id: investigationId } }] },
      },
    });
    return toDocuments(response.hits.hits)[0];
  }

  async latestInvestigation(aiIndexId: string): Promise<InvestigationRecord | undefined> {
    const { items } = await this.listInvestigations(aiIndexId, { size: 1 });
    return items[0];
  }

  async listInvestigations(
    aiIndexId: string,
    { size = MAX_INVESTIGATIONS_PAGE_SIZE }: { size?: number } = {}
  ): Promise<ListInvestigationsResponse> {
    const response = await this.client.search<InvestigationRecord>({
      size: Math.min(size, MAX_INVESTIGATIONS_PAGE_SIZE),
      track_total_hits: true,
      query: { bool: { filter: [INVESTIGATION_DOCS, { term: { ai_index_id: aiIndexId } }] } },
      sort: [{ updated_at: { order: 'desc' } }, { investigation_id: { order: 'desc' } }],
    });
    const items = toDocuments(response.hits.hits);
    return { items, total: totalOf(response.hits.total, items.length) };
  }

  async recordFindings({
    investigationId,
    findings,
    thresholds,
    accessMode,
    probes,
    measurements,
    runSummary,
  }: RecordFindingsParams): Promise<RecordFindingsResult> {
    if (findings.length > MAX_FINDINGS_PER_INVESTIGATION) {
      throw new InvalidInvestigationActionError(
        `At most ${MAX_FINDINGS_PER_INVESTIGATION} findings can be recorded per run; got ${findings.length}.`
      );
    }
    const investigation = await this.requireInvestigation(investigationId);
    const { ai_index_id: aiIndexId } = investigation;
    const now = new Date().toISOString();

    // Last one wins within a batch: two inputs with the same fingerprint describe one finding.
    const byId = new Map<string, FindingInput>();
    for (const input of findings) {
      byId.set(buildFindingId({ aiIndexId, kind: input.kind, subject: input.subject }), input);
    }

    const existing = new Map(
      (await this.getFindings([...byId.keys()])).map((finding) => [finding.finding_id, finding])
    );

    const written: Finding[] = [];
    const suppressed: Finding[] = [];
    for (const [findingId, input] of byId) {
      const prior = existing.get(findingId);
      const gate = applyGate(input, thresholds);
      const priorDecision = prior?.decision;
      const isSuppressed =
        priorDecision !== undefined && SUPPRESSING_DECISIONS.includes(priorDecision.decision);

      const status: FindingStatus = isSuppressed
        ? 'suppressed'
        : prior && prior.status !== 'open' && prior.status !== 'suppressed'
        ? prior.status
        : 'open';

      const finding: Finding = {
        ...input,
        doc_type: 'finding',
        finding_id: findingId,
        ai_index_id: aiIndexId,
        investigation_id: investigationId,
        '@timestamp': now,
        first_seen_at: prior?.first_seen_at ?? now,
        last_seen_at: now,
        seen_count: (prior?.seen_count ?? 0) + 1,
        ki_eligible: gate.passed,
        gate,
        status,
        ...(isSuppressed && priorDecision ? { suppressed_by: priorDecision } : {}),
        ...(priorDecision ? { decision: priorDecision } : {}),
        ...(prior?.outcome ? { outcome: prior.outcome } : {}),
      };
      written.push(finding);
      if (isSuppressed) {
        suppressed.push(finding);
      }
    }

    const updated: InvestigationRecord = {
      ...investigation,
      stage: 'findings_recorded',
      '@timestamp': now,
      updated_at: now,
      finding_ids: written.map((finding) => finding.finding_id),
      ...(accessMode ? { access_mode: accessMode } : {}),
      ...(probes ? { probes } : {}),
      ...(measurements ? { measurements } : {}),
      ...(runSummary ? { run_summary: runSummary } : {}),
      // A re-run discards downstream stages: decisions, strategy and plan refer to the old set.
      strategy: undefined,
      plan: undefined,
    };

    await this.client.bulk({
      operations: [
        ...written.map((finding) => ({ index: { _id: finding.finding_id, document: finding } })),
        { index: { _id: updated.investigation_id, document: updated } },
      ],
      refresh: 'wait_for',
    });

    this.logger.debug(
      `Recorded ${written.length} finding(s) for investigation '${investigationId}' (${suppressed.length} suppressed)`
    );
    return { investigation: updated, findings: written, suppressed };
  }

  async recordDecisions({
    investigationId,
    decisions,
    decidedBy,
  }: RecordDecisionsParams): Promise<{ investigation: InvestigationRecord; findings: Finding[] }> {
    const investigation = await this.requireInvestigation(investigationId);
    requireStage(investigation, 'findings_recorded', 'decisions');

    const findingIds = [...new Set(decisions.map((decision) => decision.finding_id))];
    const findings = new Map(
      (await this.getFindings(findingIds)).map((finding) => [finding.finding_id, finding])
    );
    const missing = findingIds.filter((id) => !findings.has(id));
    if (missing.length > 0) {
      throw new FindingNotFoundError(missing);
    }
    // A signal asserts "this signature must not recur", which only makes sense for observed patterns.
    const signalOnHypothesized = decisions.filter(
      ({ finding_id: findingId, decision }) =>
        decision === 'create_ki_and_signal' &&
        findings.get(findingId)?.evidence_type === 'hypothesized'
    );
    if (signalOnHypothesized.length > 0) {
      throw new InvalidInvestigationActionError(
        `create_ki_and_signal is only available for observed findings; use create_ki for: ${signalOnHypothesized
          .map((decision) => decision.finding_id)
          .join(', ')}`
      );
    }

    const now = new Date().toISOString();
    const updatedFindings: Finding[] = decisions.map(
      ({ finding_id: findingId, decision, reason }) => {
        const finding = findings.get(findingId) as Finding;
        const record: FindingDecisionRecord = {
          decision,
          ...(reason ? { reason } : {}),
          decided_at: now,
          ...(decidedBy ? { decided_by: decidedBy } : {}),
          investigation_id: investigationId,
        };
        return {
          ...finding,
          '@timestamp': now,
          status: 'decided',
          decision: record,
          // A fresh decision on a suppressed occurrence supersedes the suppression.
          suppressed_by: undefined,
        };
      }
    );

    const updated: InvestigationRecord = {
      ...investigation,
      stage: advance(investigation.stage, 'decisions_recorded'),
      '@timestamp': now,
      updated_at: now,
    };

    await this.client.bulk({
      operations: [
        ...updatedFindings.map((finding) => ({
          index: { _id: finding.finding_id, document: finding },
        })),
        { index: { _id: updated.investigation_id, document: updated } },
      ],
      refresh: 'wait_for',
    });
    return { investigation: updated, findings: updatedFindings };
  }

  async recordStrategy({
    investigationId,
    strategy,
    approvedBy,
  }: {
    investigationId: string;
    strategy: InvestigationStrategy;
    approvedBy?: string;
  }): Promise<InvestigationRecord> {
    const investigation = await this.requireInvestigation(investigationId);
    requireStage(investigation, 'decisions_recorded', 'a strategy');

    if (strategy.targeted_kis.length > 0) {
      const targeted = await this.getFindings(strategy.targeted_kis.map((ki) => ki.finding_id));
      const byId = new Map(targeted.map((finding) => [finding.finding_id, finding]));
      const invalid = strategy.targeted_kis
        .map((ki) => ki.finding_id)
        .filter((id) => {
          const decision = byId.get(id)?.decision?.decision;
          return decision === undefined || !CREATE_DECISIONS.includes(decision);
        });
      if (invalid.length > 0) {
        throw new InvalidInvestigationActionError(
          `Targeted KIs must reference findings with a create_ki decision; not the case for: ${invalid.join(
            ', '
          )}`
        );
      }
    }
    if (strategy.shape !== 'none' && strategy.rationale.trim().length === 0) {
      throw new InvalidInvestigationActionError(
        'A strategy needs a rationale citing the measurements or accepted findings it rests on.'
      );
    }
    if (
      (strategy.shape === 'systemic' || strategy.shape === 'both') &&
      strategy.families.length === 0
    ) {
      throw new InvalidInvestigationActionError(
        `A '${strategy.shape}' strategy needs at least one KI family.`
      );
    }

    const now = new Date().toISOString();
    const updated: InvestigationRecord = {
      ...investigation,
      stage: advance(investigation.stage, 'strategy_approved'),
      '@timestamp': now,
      updated_at: now,
      strategy: {
        ...strategy,
        approved_at: now,
        ...(approvedBy ? { approved_by: approvedBy } : {}),
      },
    };
    await this.writeInvestigation(updated);
    return updated;
  }

  async recordPlan({
    investigationId,
    plan,
  }: {
    investigationId: string;
    plan: InvestigationPlan;
  }): Promise<InvestigationRecord> {
    const investigation = await this.requireInvestigation(investigationId);
    requireStage(investigation, 'strategy_approved', 'a plan');

    const familyIds = new Set(investigation.strategy?.families.map((family) => family.family_id));
    const unknownFamilies = plan.workflows
      .map((workflow) => workflow.family_id)
      .filter((familyId) => !familyIds.has(familyId));
    if (unknownFamilies.length > 0) {
      throw new InvalidInvestigationActionError(
        `Plan workflows reference families not in the approved strategy: ${[
          ...new Set(unknownFamilies),
        ].join(', ')}`
      );
    }

    const now = new Date().toISOString();
    const targetedFindingIds = [...new Set(plan.targeted_kis.map((ki) => ki.finding_id))];
    const findings =
      targetedFindingIds.length > 0 ? await this.getFindings(targetedFindingIds) : [];
    const byId = new Map(findings.map((finding) => [finding.finding_id, finding]));
    const missing = targetedFindingIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new FindingNotFoundError(missing);
    }
    // Below-gate, dismissed and suppressed findings are only planned on an explicit create decision.
    const withoutCreateDecision = targetedFindingIds.filter((id) => {
      const decision = byId.get(id)?.decision?.decision;
      return decision === undefined || !CREATE_DECISIONS.includes(decision);
    });
    if (withoutCreateDecision.length > 0) {
      throw new InvalidInvestigationActionError(
        `Targeted KI specs need a create_ki decision on their finding; not the case for: ${withoutCreateDecision.join(
          ', '
        )}`
      );
    }
    const plannedFindings: Finding[] = findings
      .filter((finding) => finding.status === 'decided')
      .map((finding) => ({ ...finding, '@timestamp': now, status: 'planned' }));

    const updated: InvestigationRecord = {
      ...investigation,
      stage: advance(investigation.stage, 'planned'),
      '@timestamp': now,
      updated_at: now,
      plan,
    };

    await this.client.bulk({
      operations: [
        ...plannedFindings.map((finding) => ({
          index: { _id: finding.finding_id, document: finding },
        })),
        { index: { _id: updated.investigation_id, document: updated } },
      ],
      refresh: 'wait_for',
    });
    return updated;
  }

  async recordOutcome({
    investigationId,
    planItemId,
    findingIds = [],
    workflowId,
    kiIds,
    signalKiId,
  }: RecordOutcomeParams): Promise<{ investigation: InvestigationRecord; findings: Finding[] }> {
    const investigation = await this.requireInvestigation(investigationId);
    const now = new Date().toISOString();

    const plan = investigation.plan;
    let nextPlan: InvestigationPlan | undefined = plan;
    const resolvedFindingIds = new Set(findingIds);
    if (planItemId && plan) {
      nextPlan = {
        workflows: plan.workflows.map((workflow) =>
          workflow.plan_item_id === planItemId && workflowId
            ? { ...workflow, workflow_id: workflowId }
            : workflow
        ),
        targeted_kis: plan.targeted_kis.map((ki) => {
          if (ki.plan_item_id !== planItemId) {
            return ki;
          }
          resolvedFindingIds.add(ki.finding_id);
          return kiIds?.[0] ? { ...ki, ki_id: kiIds[0] } : ki;
        }),
      };
    }

    const findings =
      resolvedFindingIds.size > 0 ? await this.getFindings([...resolvedFindingIds]) : [];
    const updatedFindings: Finding[] = findings.map((finding) => ({
      ...finding,
      '@timestamp': now,
      status: 'generated',
      outcome: {
        ki_ids: [...new Set([...(finding.outcome?.ki_ids ?? []), ...(kiIds ?? [])])],
        workflow_ids: [
          ...new Set([
            ...(finding.outcome?.workflow_ids ?? []),
            ...(workflowId ? [workflowId] : []),
          ]),
        ],
        ...(signalKiId
          ? { signal_ki_id: signalKiId }
          : finding.outcome?.signal_ki_id
          ? { signal_ki_id: finding.outcome.signal_ki_id }
          : {}),
        updated_at: now,
      },
    }));

    const updated: InvestigationRecord = {
      ...investigation,
      stage: advance(investigation.stage, 'generated'),
      '@timestamp': now,
      updated_at: now,
      ...(nextPlan ? { plan: nextPlan } : {}),
    };

    await this.client.bulk({
      operations: [
        ...updatedFindings.map((finding) => ({
          index: { _id: finding.finding_id, document: finding },
        })),
        { index: { _id: updated.investigation_id, document: updated } },
      ],
      refresh: 'wait_for',
    });
    return { investigation: updated, findings: updatedFindings };
  }

  async priorDecisions(aiIndexId: string): Promise<PriorDecision[]> {
    const response = await this.client.search<Finding>({
      size: MAX_FINDINGS_PAGE_SIZE,
      track_total_hits: false,
      query: {
        bool: {
          filter: [
            FINDING_DOCS,
            { term: { ai_index_id: aiIndexId } },
            { terms: { 'decision.decision': [...SUPPRESSING_DECISIONS] } },
          ],
        },
      },
      sort: [{ 'decision.decided_at': { order: 'desc' } }],
    });
    return toDocuments(response.hits.hits).flatMap((finding) =>
      finding.decision
        ? [
            {
              ...finding.decision,
              finding_id: finding.finding_id,
              kind: finding.kind,
              subject: finding.subject,
            },
          ]
        : []
    );
  }

  async listFindings({
    aiIndexId,
    investigationId,
    status,
    from = 0,
    size = DEFAULT_FINDINGS_PAGE_SIZE,
  }: ListFindingsOptions): Promise<ListFindingsResponse> {
    const filter: QueryDslQueryContainer[] = [FINDING_DOCS, { term: { ai_index_id: aiIndexId } }];
    if (investigationId) {
      filter.push({ term: { investigation_id: investigationId } });
    }
    if (status && status.length > 0) {
      filter.push({ terms: { status } });
    }
    const response = await this.client.search<Finding>({
      from,
      size: Math.min(size, MAX_FINDINGS_PAGE_SIZE),
      track_total_hits: true,
      query: { bool: { filter } },
      // Eligible and prevalent first, mirroring the order shown in chat.
      sort: [
        { ki_eligible: { order: 'desc' } },
        { 'prevalence.affected_fraction': { order: 'desc', missing: '_last' } },
        { 'scale.affected_units': { order: 'desc', missing: '_last' } },
        { last_seen_at: { order: 'desc' } },
        { finding_id: { order: 'asc' } },
      ],
    });
    const items = toDocuments(response.hits.hits);
    return { items, total: totalOf(response.hits.total, items.length) };
  }

  async getFindings(findingIds: string[]): Promise<Finding[]> {
    if (findingIds.length === 0) {
      return [];
    }
    const response = await this.client.search<Finding>({
      size: Math.min(findingIds.length, MAX_FINDINGS_PAGE_SIZE),
      track_total_hits: false,
      query: { bool: { filter: [FINDING_DOCS, { terms: { finding_id: findingIds } }] } },
    });
    return toDocuments(response.hits.hits);
  }

  async deleteByAiIndex(aiIndexId: string): Promise<void> {
    try {
      await this.esClient.deleteByQuery({
        index: FINDINGS_INDEX,
        query: { term: { ai_index_id: aiIndexId } },
        conflicts: 'proceed',
        refresh: true,
        ignore_unavailable: true,
      });
    } catch (error) {
      if (isResponseError(error) && error.statusCode === 404) {
        return;
      }
      throw error;
    }
  }

  private async requireInvestigation(investigationId: string): Promise<InvestigationRecord> {
    const investigation = await this.getInvestigation(investigationId);
    if (!investigation) {
      throw new InvestigationNotFoundError(investigationId);
    }
    return investigation;
  }

  private async writeInvestigation(investigation: InvestigationRecord): Promise<void> {
    await this.client.bulk({
      operations: [{ index: { _id: investigation.investigation_id, document: investigation } }],
      refresh: 'wait_for',
    });
  }
}
