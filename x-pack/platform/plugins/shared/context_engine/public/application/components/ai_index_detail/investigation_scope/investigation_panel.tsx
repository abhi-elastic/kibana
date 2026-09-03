/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  EuiBadge,
  EuiCallOut,
  EuiFlexGroup,
  EuiFlexItem,
  EuiSpacer,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import { FormattedMessage } from '@kbn/i18n-react';
import { AiButton } from '@kbn/shared-ux-ai-components';
import React from 'react';
import { INVESTIGATION_STAGES, investigationStageIndex } from '../../../../../common/investigation';
import type { InvestigationStage } from '../../../../../common/investigation';

const STAGE_LABELS: Record<InvestigationStage, string> = {
  scoped: i18n.translate('xpack.contextEngine.investigationScope.stage.scoped', {
    defaultMessage: 'Investigating',
  }),
  findings_recorded: i18n.translate('xpack.contextEngine.investigationScope.stage.findings', {
    defaultMessage: 'Findings ready',
  }),
  decisions_recorded: i18n.translate('xpack.contextEngine.investigationScope.stage.decisions', {
    defaultMessage: 'Decisions recorded',
  }),
  strategy_approved: i18n.translate('xpack.contextEngine.investigationScope.stage.strategy', {
    defaultMessage: 'Strategy approved',
  }),
  planned: i18n.translate('xpack.contextEngine.investigationScope.stage.planned', {
    defaultMessage: 'Plan ready',
  }),
  generated: i18n.translate('xpack.contextEngine.investigationScope.stage.generated', {
    defaultMessage: 'Automation saved',
  }),
};

interface InvestigationPanelProps {
  canRun: boolean;
  /** Why the button is unavailable, shown when `canRun` is false. */
  blockedReason?: string;
  isRunning: boolean;
  onRun: () => void;
  stage: InvestigationStage | undefined;
  savedWorkflowCount: number;
}

export const InvestigationPanel = ({
  canRun,
  blockedReason,
  isRunning,
  onRun,
  stage,
  savedWorkflowCount,
}: InvestigationPanelProps) => {
  const reachedIndex = stage ? investigationStageIndex(stage) : -1;

  return (
    <section data-test-subj="contextInvestigationPanel">
      <EuiFlexGroup alignItems="center" gutterSize="m" responsive={false}>
        <EuiFlexItem css={{ minWidth: 0 }}>
          <EuiTitle size="xs">
            <h3>
              <FormattedMessage
                id="xpack.contextEngine.investigationScope.investigation.title"
                defaultMessage="Investigation"
              />
            </h3>
          </EuiTitle>
          <EuiText size="xs" color="subdued">
            <p>
              <FormattedMessage
                id="xpack.contextEngine.investigationScope.investigation.description"
                defaultMessage="The Context Engine agent inspects the scope above in the Agent Builder side panel, returns findings for your review, proposes the unit of context, and only then plans and generates automations."
              />
            </p>
          </EuiText>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <AiButton
            size="s"
            iconType="productAgent"
            onClick={onRun}
            isLoading={isRunning}
            isDisabled={!canRun}
            data-test-subj="contextRunInvestigationButton"
          >
            {i18n.translate('xpack.contextEngine.investigationScope.investigation.runButton', {
              defaultMessage: 'Run investigation in Agent Builder',
            })}
          </AiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
      {!canRun && blockedReason && (
        <>
          <EuiSpacer size="s" />
          <EuiCallOut
            announceOnMount
            size="s"
            color="warning"
            title={blockedReason}
            data-test-subj="contextRunInvestigationBlocked"
          />
        </>
      )}
      <EuiSpacer size="s" />
      <EuiFlexGroup
        gutterSize="xs"
        wrap
        responsive={false}
        data-test-subj="contextInvestigationStages"
      >
        {INVESTIGATION_STAGES.map((entry, index) => {
          const reached = index <= reachedIndex;
          const current = index === reachedIndex;
          return (
            <EuiFlexItem grow={false} key={entry}>
              <EuiBadge
                color={current ? 'primary' : reached ? 'success' : 'hollow'}
                aria-current={current ? 'step' : undefined}
                data-test-subj={`contextInvestigationStage-${entry}`}
              >
                {STAGE_LABELS[entry]}
                {entry === 'generated' && savedWorkflowCount > 0 ? ` (${savedWorkflowCount})` : ''}
              </EuiBadge>
            </EuiFlexItem>
          );
        })}
      </EuiFlexGroup>
    </section>
  );
};
