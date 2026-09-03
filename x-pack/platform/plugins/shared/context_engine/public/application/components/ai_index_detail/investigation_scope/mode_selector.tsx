/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EuiButtonGroup, EuiFormRow, EuiText } from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import React from 'react';
import type { AiIndexInvestigationMode } from '../../../../../common/http_api/ai_indices';

const legend = i18n.translate('xpack.contextEngine.investigationScope.mode.legend', {
  defaultMessage: 'Choose what the agent can inspect',
});

const MODE_OPTIONS: Array<{ id: AiIndexInvestigationMode; label: string }> = [
  {
    id: 'both',
    label: i18n.translate('xpack.contextEngine.investigationScope.mode.both', {
      defaultMessage: 'Sources + traces',
    }),
  },
  {
    id: 'sources',
    label: i18n.translate('xpack.contextEngine.investigationScope.mode.sources', {
      defaultMessage: 'Sources only',
    }),
  },
  {
    id: 'traces',
    label: i18n.translate('xpack.contextEngine.investigationScope.mode.traces', {
      defaultMessage: 'Traces only',
    }),
  },
];

const MODE_HELP: Record<AiIndexInvestigationMode, string> = {
  both: i18n.translate('xpack.contextEngine.investigationScope.mode.bothHelp', {
    defaultMessage:
      'Observed agent behaviour is cross-referenced with the data it reads. Recurring task shapes from the traces become the probes.',
  }),
  sources: i18n.translate('xpack.contextEngine.investigationScope.mode.sourcesHelp', {
    defaultMessage:
      'No traces needed. The agent drafts up to 5 probe questions from the description, measures the data behind them, and proposes the unit of context.',
  }),
  traces: i18n.translate('xpack.contextEngine.investigationScope.mode.tracesHelp', {
    defaultMessage:
      'Recurring failures, loops and soft failures are detected in the selected agent’s traces; the indices it touches most are measured when they resolve here.',
  }),
};

interface ModeSelectorProps {
  mode: AiIndexInvestigationMode;
  onChange: (mode: AiIndexInvestigationMode) => void;
  isDisabled?: boolean;
}

export const ModeSelector = ({ mode, onChange, isDisabled = false }: ModeSelectorProps) => (
  <EuiFormRow label={legend} fullWidth helpText={<EuiText size="xs">{MODE_HELP[mode]}</EuiText>}>
    <EuiButtonGroup
      legend={legend}
      options={MODE_OPTIONS.map((option) => ({
        ...option,
        'data-test-subj': `contextInvestigationMode-${option.id}`,
      }))}
      idSelected={mode}
      onChange={(id) => onChange(id as AiIndexInvestigationMode)}
      isDisabled={isDisabled}
      buttonSize="compressed"
      isFullWidth
      data-test-subj="contextInvestigationModeSelector"
    />
  </EuiFormRow>
);
