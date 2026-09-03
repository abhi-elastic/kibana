/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AttachmentTypeDefinition } from '@kbn/agent-builder-server/attachments';
import { SIGNAL_KIS_AI_INDEX_ID } from '@kbn/context-engine-plugin/common/constants';
import {
  investigationAttachmentDataSchema,
  type AttachmentFinding,
  type InvestigationAttachmentData,
} from '@kbn/context-engine-plugin/common/investigation_schemas';
import { INVESTIGATION_ATTACHMENT_TYPE } from '../../common/agent_builder_attachments';
import {
  KI_AUTOMATION_GENERATION_SKILL_ID,
  KI_INVESTIGATION_SKILL_ID,
  KI_OPPORTUNITY_PLANNER_SKILL_ID,
} from '../../common/agent_builder_skills';
import { CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID } from '../../common/agent_builder_tools';

/**
 * Generous guard; the compact stage view stays well under 10k chars for a dozen findings, and
 * the plan specs (the generation stage's input) add a few thousand chars per plan item.
 */
const MAX_CONTENT_LENGTH = 120_000;
const MAX_FINDINGS_IN_VIEW = 12;
const MAX_MEASUREMENTS_IN_VIEW = 40;
const MAX_PRIOR_DECISIONS_IN_VIEW = 20;
const MAX_SPEC_CHARS_IN_VIEW = 4_000;

/**
 * Server-side definition for the `investigation` attachment: the one document a guided
 * investigation is carried in, versioned through its stages by `record_investigation`.
 */
export const createInvestigationAttachmentType = (): AttachmentTypeDefinition<
  typeof INVESTIGATION_ATTACHMENT_TYPE,
  InvestigationAttachmentData
> => ({
  id: INVESTIGATION_ATTACHMENT_TYPE,
  isReadonly: false,
  maxContentLength: MAX_CONTENT_LENGTH,
  validate: (input) => {
    const parsed = investigationAttachmentDataSchema.safeParse(input);
    if (parsed.success) {
      return { valid: true, data: parsed.data };
    }
    return {
      valid: false,
      error: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    };
  },
  format: (attachment) => ({
    getRepresentation: () => ({ type: 'text', value: formatInvestigation(attachment.data) }),
  }),
  getAgentDescription: () =>
    [
      'An `investigation` attachment is the working record of a Context Engine guided investigation',
      'for one AI index. Stay inside its scope: do not call `list_indices` and do not query traces',
      'outside the given agent and time range. Analyse successes as well as failures. Never simulate',
      'the production agent. Return findings for review before creating anything, and propose the',
      'context strategy only after decisions are recorded.',
      `Read \`stage\` to know which skill applies: \`scoped\`, \`findings_recorded\` and \`decisions_recorded\``,
      `belong to \`${KI_INVESTIGATION_SKILL_ID}\` (through the strategy proposal); \`strategy_approved\` loads`,
      `\`${KI_OPPORTUNITY_PLANNER_SKILL_ID}\`; \`planned\` loads \`${KI_AUTOMATION_GENERATION_SKILL_ID}\`.`,
      `Every stage transition is a \`${CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID}\` call; never edit`,
      'this attachment by other means. Findings in `prior_decisions` were dismissed or marked as known',
      'issues in earlier runs: report them in one line, do not ask about them again.',
    ].join(' '),
  getTools: () => [CONTEXT_ENGINE_RECORD_INVESTIGATION_TOOL_ID],
});

const fmtFraction = (fraction: number): string => `${Math.round(fraction * 100)}%`;

const formatScope = (data: InvestigationAttachmentData): string[] => {
  const { scope } = data;
  const lines = [`Mode: ${scope.mode}`];
  if (scope.mode !== 'traces') {
    lines.push(
      scope.sources.length > 0
        ? `Sources: ${scope.sources.map((source) => `${source.type}:${source.value}`).join(' | ')}`
        : 'Sources: none configured'
    );
    if (scope.source_summary) {
      const {
        valid_sources: valid,
        resolved_indices: indices,
        doc_count: docs,
        count_capped: capped,
      } = scope.source_summary;
      lines.push(
        `Source preview: ${valid} valid source(s), ${indices.length} resolved index/indices` +
          (indices.length > 0
            ? ` (${indices.slice(0, 10).join(', ')}${indices.length > 10 ? ', …' : ''})`
            : '') +
          `, ${capped ? 'at least ' : ''}${docs.toLocaleString()} documents`
      );
    }
  }
  if (scope.mode !== 'sources' && scope.trace) {
    const { trace } = scope;
    lines.push(
      `Traces: ${trace.custom_esql ? 'custom ES|QL scope' : `agent ${trace.agent_id ?? '?'}`}, ${
        trace.from
      } to ${trace.to}`
    );
    if (trace.custom_esql) {
      lines.push(`Trace ES|QL: ${trace.custom_esql}`);
    }
    if (trace.counts) {
      const {
        requests,
        conversations,
        tool_calls: toolCalls,
        failed_tool_calls: failed,
      } = trace.counts;
      lines.push(
        `Trace counts: ${requests} requests, ${conversations} conversations, ${toolCalls} tool calls, ${failed} failed tool calls`
      );
    }
  }
  return lines;
};

const formatFindingRow = (finding: AttachmentFinding): string => {
  const breadth = finding.prevalence
    ? `${finding.prevalence.affected_requests}/${
        finding.prevalence.sampled_requests
      } req (${fmtFraction(finding.prevalence.affected_fraction)}), ${
        finding.prevalence.distinct_conversations
      } conv`
    : finding.scale
    ? `${finding.scale.affected_units}/${finding.scale.total_units} ${finding.scale.unit_kind}`
    : '-';
  const decision = finding.decision?.decision ?? finding.suppressed_by?.decision ?? '-';
  return `| ${finding.finding_id} | ${finding.kind} | ${finding.evidence_type} | ${
    finding.subject
  } | ${breadth} | ${finding.confidence} | ${finding.ki_usefulness} | ${
    finding.ki_eligible ? 'yes' : 'no'
  } | ${finding.status} | ${decision} |`;
};

const formatFindings = (findings: AttachmentFinding[]): string[] => {
  if (findings.length === 0) {
    return ['Findings: none passed the gate in this scope (a valid result).'];
  }
  const eligible = findings.filter(
    (finding) => finding.ki_eligible && finding.status !== 'suppressed'
  );
  const rare = findings.filter(
    (finding) => !finding.ki_eligible && finding.status !== 'suppressed'
  );
  const suppressed = findings.filter((finding) => finding.status === 'suppressed');
  const lines = [
    `Findings: ${findings.length} total, ${eligible.length} KI-eligible, ${rare.length} rare, ${suppressed.length} suppressed`,
    '| id | kind | evidence | subject | prevalence or scale | confidence | KI usefulness | eligible | status | decision |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...eligible.slice(0, MAX_FINDINGS_IN_VIEW).map(formatFindingRow),
  ];
  if (eligible.length > MAX_FINDINGS_IN_VIEW) {
    lines.push(
      `Further eligible findings (not shown): ${eligible
        .slice(MAX_FINDINGS_IN_VIEW)
        .map((finding) => finding.finding_id)
        .join(', ')}`
    );
  }
  for (const finding of rare) {
    lines.push(
      `Rare in this range: ${finding.finding_id} ${finding.kind} ${finding.subject} (${finding.gate.reason})`
    );
  }
  for (const finding of suppressed) {
    lines.push(
      `Suppressed: ${finding.finding_id} ${finding.kind} ${finding.subject} (${
        finding.suppressed_by?.decision ?? 'prior decision'
      }${finding.suppressed_by?.reason ? `: ${finding.suppressed_by.reason}` : ''})`
    );
  }
  return lines;
};

const formatStrategy = (
  strategy: NonNullable<InvestigationAttachmentData['strategy']>
): string[] => {
  const lines = [
    `Strategy: shape ${strategy.shape}${strategy.approved_at ? ' (approved)' : ' (proposed)'}`,
  ];
  strategy.families.forEach((family, index) => {
    lines.push(
      `  ${index === 0 ? 'Primary' : 'Secondary'} family ${family.family_id}: ${
        family.family
      }, unit ${family.unit_key} (${family.unit_count} units), ${family.extraction} extraction, ${
        family.freshness
      }, ${family.readiness}, serves ${family.serves.length > 0 ? family.serves.join(', ') : '-'}`
    );
  });
  if (strategy.targeted_kis.length > 0) {
    lines.push(
      `  Targeted KIs: ${strategy.targeted_kis
        .map((ki) => `${ki.ki_type} for ${ki.finding_id}`)
        .join('; ')}`
    );
  }
  if (strategy.cost_estimate) {
    lines.push(`  Cost estimate: ${strategy.cost_estimate}`);
  }
  if (strategy.rationale) {
    lines.push(`  Rationale: ${strategy.rationale}`);
  }
  return lines;
};

const formatPlan = (plan: NonNullable<InvestigationAttachmentData['plan']>): string[] => {
  const lines = [
    `Plan: ${plan.workflows.length} workflow spec(s), ${plan.targeted_kis.length} targeted KI spec(s)`,
  ];
  if (plan.workflows.length > 0) {
    lines.push(
      '| plan item | family | name | unit key | foreach | freshness | readiness | workflow id |'
    );
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const workflow of plan.workflows) {
      lines.push(
        `| ${workflow.plan_item_id} | ${workflow.family_id} | ${workflow.name} | ${
          workflow.unit_key
        } | ${workflow.foreach} | ${workflow.freshness_cursor ?? 'static'} | ${
          workflow.readiness
        } | ${workflow.workflow_id ?? '-'} |`
      );
    }
  }
  if (plan.targeted_kis.length > 0) {
    lines.push('| plan item | finding | KI type | title | KI id |');
    lines.push('|---|---|---|---|---|');
    for (const ki of plan.targeted_kis) {
      lines.push(
        `| ${ki.plan_item_id} | ${ki.finding_id} | ${ki.ki_type} | ${ki.title} | ${
          ki.ki_id ?? '-'
        } |`
      );
    }
  }
  lines.push(
    `Signals AI index id (dual-write target for create_ki_and_signal): ${SIGNAL_KIS_AI_INDEX_ID}`
  );
  for (const item of [...plan.workflows, ...plan.targeted_kis]) {
    lines.push(`Spec ${item.plan_item_id}:`, truncateSpec(item.spec));
  }
  return lines;
};

const truncateSpec = (spec: string): string =>
  spec.length > MAX_SPEC_CHARS_IN_VIEW
    ? `${spec.slice(0, MAX_SPEC_CHARS_IN_VIEW)}\n… (${
        spec.length - MAX_SPEC_CHARS_IN_VIEW
      } more chars)`
    : spec;

/** Compact stage view for the LLM: scope, prior decisions, measurements, findings table, strategy, plan. */
export const formatInvestigation = (data: InvestigationAttachmentData): string => {
  const lines: string[] = [
    `Investigation ${data.investigation_id} for AI index ${data.ai_index_id}`,
    `Stage: ${data.stage}`,
    ...formatScope(data),
  ];

  if (data.prior_decisions.length > 0) {
    lines.push(`Prior decisions (${data.prior_decisions.length}, do not ask again):`);
    for (const prior of data.prior_decisions.slice(0, MAX_PRIOR_DECISIONS_IN_VIEW)) {
      lines.push(
        `  ${prior.decision}: ${prior.kind} ${prior.subject}${
          prior.reason ? ` — ${prior.reason}` : ''
        }`
      );
    }
    if (data.prior_decisions.length > MAX_PRIOR_DECISIONS_IN_VIEW) {
      lines.push(`  … ${data.prior_decisions.length - MAX_PRIOR_DECISIONS_IN_VIEW} more`);
    }
  }

  if (data.access_mode) {
    lines.push(`Access mode: ${data.access_mode}`);
  }
  if (data.probes && data.probes.length > 0) {
    lines.push(`Probes (${data.probes.length}):`);
    for (const probe of data.probes) {
      lines.push(
        `  ${probe.probe_id}: ${probe.question}${
          probe.answer_path ? ` [${probe.answer_path.join(' -> ')}]` : ''
        }${
          probe.answerable === undefined ? '' : probe.answerable ? ' answerable' : ' unanswerable'
        }`
      );
    }
  }
  if (data.measurements && data.measurements.length > 0) {
    lines.push(`Measurements (${data.measurements.length}, facts for the strategy):`);
    for (const measurement of data.measurements.slice(0, MAX_MEASUREMENTS_IN_VIEW)) {
      const values = Object.entries(measurement.values)
        .map(([key, value]) => `${key}=${value === null ? 'null' : String(value)}`)
        .join(', ');
      lines.push(
        `  ${measurement.kind} ${measurement.subject}: ${values}${
          measurement.notes ? ` (${measurement.notes})` : ''
        }`
      );
    }
    if (data.measurements.length > MAX_MEASUREMENTS_IN_VIEW) {
      lines.push(`  … ${data.measurements.length - MAX_MEASUREMENTS_IN_VIEW} more`);
    }
  }

  if (data.findings) {
    lines.push(...formatFindings(data.findings));
  }
  if (data.run_summary) {
    lines.push(
      `Run summary: ${Object.entries(data.run_summary)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')}`
    );
  }
  if (data.strategy) {
    lines.push(...formatStrategy(data.strategy));
  }
  if (data.plan) {
    lines.push(...formatPlan(data.plan));
  }
  return lines.join('\n');
};
