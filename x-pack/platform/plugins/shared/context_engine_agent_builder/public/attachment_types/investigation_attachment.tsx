/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  EuiBadge,
  EuiBasicTable,
  EuiDescriptionList,
  EuiFlexGroup,
  EuiFlexItem,
  EuiSpacer,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type { EuiBasicTableColumn } from '@elastic/eui';
import type { Attachment } from '@kbn/agent-builder-common/attachments';
import type {
  AttachmentRenderProps,
  AttachmentUIDefinition,
} from '@kbn/agent-builder-browser/attachments';
import type {
  AttachmentFinding,
  InvestigationAttachmentData,
} from '@kbn/context-engine-plugin/common/investigation_schemas';
import type { InvestigationStage } from '@kbn/context-engine-plugin/common/investigation';
import { i18n } from '@kbn/i18n';
import { FormattedMessage } from '@kbn/i18n-react';
import React from 'react';
import type { INVESTIGATION_ATTACHMENT_TYPE } from '../../common/agent_builder_attachments';

export type InvestigationAttachment = Attachment<
  typeof INVESTIGATION_ATTACHMENT_TYPE,
  InvestigationAttachmentData
>;

const STAGE_LABELS: Record<InvestigationStage, string> = {
  scoped: i18n.translate('xpack.contextEngine.attachments.investigation.stage.scoped', {
    defaultMessage: 'Scoped',
  }),
  findings_recorded: i18n.translate(
    'xpack.contextEngine.attachments.investigation.stage.findings',
    {
      defaultMessage: 'Findings recorded',
    }
  ),
  decisions_recorded: i18n.translate(
    'xpack.contextEngine.attachments.investigation.stage.decisions',
    { defaultMessage: 'Decisions recorded' }
  ),
  strategy_approved: i18n.translate(
    'xpack.contextEngine.attachments.investigation.stage.strategy',
    {
      defaultMessage: 'Strategy approved',
    }
  ),
  planned: i18n.translate('xpack.contextEngine.attachments.investigation.stage.planned', {
    defaultMessage: 'Plan ready',
  }),
  generated: i18n.translate('xpack.contextEngine.attachments.investigation.stage.generated', {
    defaultMessage: 'Automation saved',
  }),
};

const CONFIDENCE_COLORS: Record<AttachmentFinding['confidence'], string> = {
  confirmed: 'success',
  strong: 'primary',
  suggestive: 'hollow',
};

const DECISION_LABELS: Record<string, string> = {
  dismiss: i18n.translate('xpack.contextEngine.attachments.investigation.decision.dismiss', {
    defaultMessage: 'Dismissed',
  }),
  known_issue: i18n.translate('xpack.contextEngine.attachments.investigation.decision.knownIssue', {
    defaultMessage: 'Known issue',
  }),
  create_ki: i18n.translate('xpack.contextEngine.attachments.investigation.decision.createKi', {
    defaultMessage: 'Create KI',
  }),
  create_ki_and_signal: i18n.translate(
    'xpack.contextEngine.attachments.investigation.decision.createKiAndSignal',
    { defaultMessage: 'Create KI and signal' }
  ),
};

const formatBreadth = (finding: AttachmentFinding): string => {
  if (finding.prevalence) {
    const {
      affected_requests: affected,
      sampled_requests: sampled,
      distinct_conversations: conv,
    } = finding.prevalence;
    return i18n.translate('xpack.contextEngine.attachments.investigation.prevalence', {
      defaultMessage: '{affected} of {sampled} requests, {conversations} conversations',
      values: { affected, sampled, conversations: conv },
    });
  }
  if (finding.scale) {
    const { affected_units: affected, total_units: total, unit_kind: kind } = finding.scale;
    return i18n.translate('xpack.contextEngine.attachments.investigation.scale', {
      defaultMessage: 'affects {affected} of {total} {kind}',
      values: { affected, total, kind },
    });
  }
  return '';
};

const FINDING_COLUMNS: Array<EuiBasicTableColumn<AttachmentFinding>> = [
  {
    field: 'title',
    name: i18n.translate('xpack.contextEngine.attachments.investigation.columns.finding', {
      defaultMessage: 'Finding',
    }),
    render: (_title: string, finding: AttachmentFinding) => (
      <EuiText size="s">
        <strong>{finding.title}</strong>
        <br />
        <span>{finding.summary}</span>
        <br />
        <EuiText size="xs" color="subdued" component="span">
          {finding.kind} · {finding.subject} · {formatBreadth(finding)}
          {finding.ki_eligible ? '' : ` · ${finding.gate.reason}`}
        </EuiText>
      </EuiText>
    ),
  },
  {
    field: 'confidence',
    name: i18n.translate('xpack.contextEngine.attachments.investigation.columns.confidence', {
      defaultMessage: 'Confidence',
    }),
    width: '120px',
    render: (confidence: AttachmentFinding['confidence']) => (
      <EuiBadge color={CONFIDENCE_COLORS[confidence]}>{confidence}</EuiBadge>
    ),
  },
  {
    field: 'ki_usefulness',
    name: i18n.translate('xpack.contextEngine.attachments.investigation.columns.kiUsefulness', {
      defaultMessage: 'KI usefulness',
    }),
    width: '120px',
  },
  {
    field: 'status',
    name: i18n.translate('xpack.contextEngine.attachments.investigation.columns.decision', {
      defaultMessage: 'Decision',
    }),
    width: '170px',
    render: (_status: AttachmentFinding['status'], finding: AttachmentFinding) => {
      const decision = finding.decision?.decision ?? finding.suppressed_by?.decision;
      if (!decision) {
        return (
          <EuiBadge color="hollow">
            {finding.ki_eligible
              ? i18n.translate('xpack.contextEngine.attachments.investigation.decision.pending', {
                  defaultMessage: 'Pending',
                })
              : i18n.translate('xpack.contextEngine.attachments.investigation.decision.rare', {
                  defaultMessage: 'Rare in this range',
                })}
          </EuiBadge>
        );
      }
      return (
        <EuiBadge color={decision.startsWith('create') ? 'success' : 'default'}>
          {DECISION_LABELS[decision] ?? decision}
          {finding.status === 'suppressed' ? ' (prior run)' : ''}
        </EuiBadge>
      );
    },
  },
];

const ScopeSummary = ({ data }: { data: InvestigationAttachmentData }) => {
  const { scope } = data;
  const items = [
    {
      title: i18n.translate('xpack.contextEngine.attachments.investigation.scope.mode', {
        defaultMessage: 'Mode',
      }),
      description: scope.mode,
    },
    ...(scope.mode !== 'traces'
      ? [
          {
            title: i18n.translate('xpack.contextEngine.attachments.investigation.scope.sources', {
              defaultMessage: 'Sources',
            }),
            description:
              scope.sources.length > 0
                ? scope.sources.map((source) => source.value).join(', ')
                : i18n.translate('xpack.contextEngine.attachments.investigation.scope.noSources', {
                    defaultMessage: 'none',
                  }),
          },
        ]
      : []),
    ...(scope.mode !== 'sources' && scope.trace
      ? [
          {
            title: i18n.translate('xpack.contextEngine.attachments.investigation.scope.traces', {
              defaultMessage: 'Traces',
            }),
            description: `${
              scope.trace.custom_esql ? 'custom ES|QL' : scope.trace.agent_id ?? ''
            } · ${scope.trace.from} → ${scope.trace.to}${
              scope.trace.counts ? ` · ${scope.trace.counts.requests} requests` : ''
            }`,
          },
        ]
      : []),
    ...(data.access_mode
      ? [
          {
            title: i18n.translate(
              'xpack.contextEngine.attachments.investigation.scope.accessMode',
              {
                defaultMessage: 'Agent access',
              }
            ),
            description: data.access_mode,
          },
        ]
      : []),
  ];
  return <EuiDescriptionList type="column" compressed listItems={items} />;
};

const StrategyCard = ({
  strategy,
}: {
  strategy: NonNullable<InvestigationAttachmentData['strategy']>;
}) => (
  <>
    <EuiTitle size="xxs">
      <h4>
        <FormattedMessage
          id="xpack.contextEngine.attachments.investigation.strategy.title"
          defaultMessage="Context strategy: {shape}"
          values={{ shape: strategy.shape }}
        />
      </h4>
    </EuiTitle>
    <EuiSpacer size="xs" />
    <EuiText size="s">
      {strategy.families.map((family, index) => (
        <p key={family.family_id}>
          <strong>{index === 0 ? 'Primary' : 'Secondary'}:</strong> {family.family}, one KI per{' '}
          <code>{family.unit_key}</code> ({family.unit_count} units), {family.extraction}{' '}
          extraction, {family.freshness}, {family.readiness}
        </p>
      ))}
      {strategy.targeted_kis.length > 0 && (
        <p>
          <FormattedMessage
            id="xpack.contextEngine.attachments.investigation.strategy.targeted"
            defaultMessage="{count, plural, one {# targeted KI} other {# targeted KIs}} from accepted findings"
            values={{ count: strategy.targeted_kis.length }}
          />
        </p>
      )}
      {strategy.cost_estimate && <p>{strategy.cost_estimate}</p>}
      {strategy.rationale && (
        <p>
          <em>{strategy.rationale}</em>
        </p>
      )}
    </EuiText>
  </>
);

const PlanTable = ({ plan }: { plan: NonNullable<InvestigationAttachmentData['plan']> }) => (
  <>
    <EuiTitle size="xxs">
      <h4>
        <FormattedMessage
          id="xpack.contextEngine.attachments.investigation.plan.title"
          defaultMessage="Plan: {workflows, plural, one {# workflow} other {# workflows}}, {kis, plural, one {# targeted KI} other {# targeted KIs}}"
          values={{ workflows: plan.workflows.length, kis: plan.targeted_kis.length }}
        />
      </h4>
    </EuiTitle>
    <EuiSpacer size="xs" />
    <EuiText size="s">
      <ul>
        {plan.workflows.map((workflow) => (
          <li key={workflow.plan_item_id}>
            <strong>{workflow.name}</strong> — foreach {workflow.foreach} by{' '}
            <code>{workflow.unit_key}</code>, {workflow.freshness_cursor ?? 'static'},{' '}
            {workflow.readiness}
            {workflow.workflow_id ? ` · saved as ${workflow.workflow_id}` : ''}
          </li>
        ))}
        {plan.targeted_kis.map((ki) => (
          <li key={ki.plan_item_id}>
            <strong>{ki.title}</strong> — {ki.ki_type} KI for finding {ki.finding_id}
            {ki.ki_id ? ` · created as ${ki.ki_id}` : ''}
          </li>
        ))}
      </ul>
    </EuiText>
  </>
);

const InvestigationInlineContent = ({
  attachment,
}: AttachmentRenderProps<InvestigationAttachment>) => {
  const { data } = attachment;
  const findings = data.findings ?? [];
  return (
    <div data-test-subj="contextInvestigationAttachment">
      <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiBadge color="primary">{STAGE_LABELS[data.stage]}</EuiBadge>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiText size="xs" color="subdued">
            {data.investigation_id}
          </EuiText>
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="s" />
      <ScopeSummary data={data} />
      {data.prior_decisions.length > 0 && (
        <>
          <EuiSpacer size="s" />
          <EuiText size="xs" color="subdued">
            <FormattedMessage
              id="xpack.contextEngine.attachments.investigation.priorDecisions"
              defaultMessage="{count, plural, one {# finding} other {# findings}} dismissed or marked as known in earlier runs will not be asked about again."
              values={{ count: data.prior_decisions.length }}
            />
          </EuiText>
        </>
      )}
      {data.findings && (
        <>
          <EuiSpacer size="m" />
          {findings.length === 0 ? (
            <EuiText size="s">
              <FormattedMessage
                id="xpack.contextEngine.attachments.investigation.noFindings"
                defaultMessage="No findings passed the gate in this scope."
              />
            </EuiText>
          ) : (
            <EuiBasicTable<AttachmentFinding>
              items={findings}
              columns={FINDING_COLUMNS}
              tableCaption={i18n.translate(
                'xpack.contextEngine.attachments.investigation.findingsTableCaption',
                { defaultMessage: 'Investigation findings' }
              )}
              tableLayout="auto"
              compressed
              data-test-subj="contextInvestigationFindingsTable"
            />
          )}
        </>
      )}
      {data.strategy && (
        <>
          <EuiSpacer size="m" />
          <StrategyCard strategy={data.strategy} />
        </>
      )}
      {data.plan && (
        <>
          <EuiSpacer size="m" />
          <PlanTable plan={data.plan} />
        </>
      )}
    </div>
  );
};

/** Read-only, stage-aware card for the investigation attachment. */
export const investigationAttachmentUiDefinition: AttachmentUIDefinition<InvestigationAttachment> =
  {
    getLabel: (attachment) =>
      i18n.translate('xpack.contextEngine.attachments.investigation.label', {
        defaultMessage: 'Investigation · {stage}',
        values: { stage: STAGE_LABELS[attachment.data.stage] },
      }),
    getIcon: () => 'inspect',
    renderInlineContent: (props) => <InvestigationInlineContent {...props} />,
  };
