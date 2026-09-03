/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ATTACHMENT_REF_ACTOR, getLatestVersion } from '@kbn/agent-builder-common/attachments';
import type { AttachmentStateManager } from '@kbn/agent-builder-server/attachments';
import type { CoreStart, ElasticsearchClient, Logger } from '@kbn/core/server';
import type { KibanaRequest } from '@kbn/core-http-server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import type {
  AccessMode,
  Finding,
  FindingDecision,
  FindingInput,
  InvestigationMeasurement,
  InvestigationPlan,
  InvestigationProbe,
  InvestigationRecord,
  InvestigationStrategy,
} from '@kbn/context-engine-plugin/common/http_api/findings';
import {
  buildInvestigationAttachmentData,
  investigationAttachmentDataSchema,
  type InvestigationAttachmentData,
} from '@kbn/context-engine-plugin/common/investigation_schemas';
import type { InvestigationStage } from '@kbn/context-engine-plugin/common/investigation';
import type { FindingsServiceApi } from '@kbn/context-engine-plugin/server/findings/service';
import { INVESTIGATION_ATTACHMENT_TYPE } from '../../../../common/agent_builder_attachments';
import { assertContextEngineWriteAccess } from '../../assert_context_engine_write_access';

export type RecordInvestigationParams =
  | {
      action: 'findings';
      investigationId?: string;
      findings: FindingInput[];
      access_mode?: AccessMode;
      probes?: InvestigationProbe[];
      measurements?: InvestigationMeasurement[];
      run_summary?: Record<string, number>;
    }
  | {
      action: 'decisions';
      investigationId?: string;
      decisions: Array<{ finding_id: string; decision: FindingDecision; reason?: string }>;
    }
  | { action: 'strategy'; investigationId?: string; strategy: InvestigationStrategy }
  | { action: 'plan'; investigationId?: string; plan: InvestigationPlan };

export interface RecordInvestigationResult {
  action: RecordInvestigationParams['action'];
  investigation_id: string;
  ai_index_id: string;
  stage: InvestigationStage;
  attachment_id?: string;
  attachment_version?: number;
  /** `findings` action: what the gate decided per finding, plus prior reasons for suppressed ones. */
  findings?: Array<{
    finding_id: string;
    kind: Finding['kind'];
    subject: string;
    ki_eligible: boolean;
    gate_reason: string;
    status: Finding['status'];
    suppressed_reason?: string;
  }>;
  /** `decisions` action: how many findings now carry each decision. */
  decision_counts?: Partial<Record<FindingDecision, number>>;
  strategy_shape?: InvestigationStrategy['shape'];
  plan_items?: { workflows: number; targeted_kis: number };
}

interface InvestigationAttachmentRef {
  id: string;
  data: InvestigationAttachmentData;
}

/** The newest active investigation attachment in the conversation, optionally matched by id. */
export const findInvestigationAttachment = (
  attachments: AttachmentStateManager,
  investigationId?: string
): InvestigationAttachmentRef | undefined => {
  const candidates = attachments
    .getActive()
    .filter((attachment) => attachment.type === INVESTIGATION_ATTACHMENT_TYPE)
    .flatMap((attachment) => {
      const parsed = investigationAttachmentDataSchema.safeParse(
        getLatestVersion(attachment)?.data
      );
      return parsed.success ? [{ id: attachment.id, data: parsed.data }] : [];
    })
    .filter((candidate) => !investigationId || candidate.data.investigation_id === investigationId);
  return candidates.at(-1);
};

export const resolveInvestigationId = (
  attachments: AttachmentStateManager,
  investigationId?: string
): { investigationId: string; attachment?: InvestigationAttachmentRef } => {
  const attachment = findInvestigationAttachment(attachments, investigationId);
  const resolved = investigationId ?? attachment?.data.investigation_id;
  if (!resolved) {
    throw new Error(
      'No investigation attachment found in this conversation. Provide investigationId explicitly or start the investigation from the AI index page.'
    );
  }
  return { investigationId: resolved, attachment };
};

const summarizeDecisions = (findings: Finding[]): Partial<Record<FindingDecision, number>> =>
  findings.reduce<Partial<Record<FindingDecision, number>>>((counts, finding) => {
    const decision = finding.decision?.decision;
    if (decision) {
      counts[decision] = (counts[decision] ?? 0) + 1;
    }
    return counts;
  }, {});

export const recordInvestigationHandler = async ({
  params,
  request,
  spaceId,
  esClient,
  attachments,
  logger,
  getCoreStart,
  getSecurityStart,
  getFindingsService,
}: {
  params: RecordInvestigationParams;
  request: KibanaRequest;
  spaceId: string;
  esClient: ElasticsearchClient;
  attachments: AttachmentStateManager;
  logger: Logger;
  getCoreStart: () => Promise<CoreStart>;
  getSecurityStart: () => Promise<SecurityPluginStart | undefined>;
  getFindingsService: (esClient: ElasticsearchClient) => Promise<FindingsServiceApi>;
}): Promise<RecordInvestigationResult> => {
  await assertContextEngineWriteAccess({ request, spaceId, getCoreStart, getSecurityStart });

  const { investigationId, attachment } = resolveInvestigationId(
    attachments,
    params.investigationId
  );
  const service = await getFindingsService(esClient);
  const coreStart = await getCoreStart();
  const username = coreStart.security.authc.getCurrentUser(request)?.username;

  let investigation: InvestigationRecord;
  let result: Omit<RecordInvestigationResult, 'investigation_id' | 'ai_index_id' | 'stage'>;

  switch (params.action) {
    case 'findings': {
      const recorded = await service.recordFindings({
        investigationId,
        findings: params.findings,
        accessMode: params.access_mode,
        probes: params.probes,
        measurements: params.measurements,
        runSummary: params.run_summary,
      });
      investigation = recorded.investigation;
      result = {
        action: 'findings',
        findings: recorded.findings.map((finding) => ({
          finding_id: finding.finding_id,
          kind: finding.kind,
          subject: finding.subject,
          ki_eligible: finding.ki_eligible,
          gate_reason: finding.gate.reason,
          status: finding.status,
          ...(finding.suppressed_by?.reason
            ? { suppressed_reason: finding.suppressed_by.reason }
            : {}),
        })),
      };
      break;
    }
    case 'decisions': {
      const recorded = await service.recordDecisions({
        investigationId,
        decisions: params.decisions,
        decidedBy: username,
      });
      investigation = recorded.investigation;
      result = { action: 'decisions', decision_counts: summarizeDecisions(recorded.findings) };
      break;
    }
    case 'strategy': {
      investigation = await service.recordStrategy({
        investigationId,
        strategy: params.strategy,
        approvedBy: username,
      });
      result = { action: 'strategy', strategy_shape: params.strategy.shape };
      break;
    }
    case 'plan': {
      investigation = await service.recordPlan({ investigationId, plan: params.plan });
      result = {
        action: 'plan',
        plan_items: {
          workflows: params.plan.workflows.length,
          targeted_kis: params.plan.targeted_kis.length,
        },
      };
      break;
    }
    default: {
      const exhaustive: never = params;
      throw new Error(`Unknown action: ${JSON.stringify(exhaustive)}`);
    }
  }

  const [findings, priorDecisions] = await Promise.all([
    investigation.finding_ids.length > 0 ? service.getFindings(investigation.finding_ids) : [],
    service.priorDecisions(investigation.ai_index_id),
  ]);
  const nextData = buildInvestigationAttachmentData({ investigation, findings, priorDecisions });

  let attachmentVersion: number | undefined;
  if (attachment) {
    const updated = await attachments.update(
      attachment.id,
      { data: nextData },
      ATTACHMENT_REF_ACTOR.agent
    );
    attachmentVersion = updated?.current_version;
    if (!updated) {
      logger.warn(
        `Investigation '${investigationId}' was recorded but attachment '${attachment.id}' could not be updated.`
      );
    }
  } else {
    const added = await attachments.add(
      {
        type: INVESTIGATION_ATTACHMENT_TYPE,
        data: nextData,
        description: `Investigation for AI index ${investigation.ai_index_id}`,
      },
      ATTACHMENT_REF_ACTOR.agent
    );
    attachmentVersion = added.current_version;
  }

  logger.debug(
    `record_investigation(${params.action}) moved investigation '${investigationId}' to stage '${investigation.stage}'`
  );

  return {
    ...result,
    investigation_id: investigation.investigation_id,
    ai_index_id: investigation.ai_index_id,
    stage: investigation.stage,
    ...(attachment ? { attachment_id: attachment.id } : {}),
    ...(attachmentVersion !== undefined ? { attachment_version: attachmentVersion } : {}),
  };
};

export const getRecordInvestigationErrorMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : 'An unexpected error occurred while recording the investigation.';
