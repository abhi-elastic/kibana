/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  EuiAccordion,
  EuiButton,
  EuiCallOut,
  EuiComboBox,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiSpacer,
  EuiStat,
  EuiSuperDatePicker,
  EuiText,
  EuiTitle,
  useGeneratedHtmlId,
} from '@elastic/eui';
import type { EuiComboBoxOptionOption } from '@elastic/eui';
import type { AggregateQuery } from '@kbn/es-query';
import { ESQLLangEditor } from '@kbn/esql/public';
import { i18n } from '@kbn/i18n';
import { FormattedMessage } from '@kbn/i18n-react';
import React, { useEffect, useMemo, useState } from 'react';
import { buildAgentBuilderTracesIndexName } from '../../../../../common/constants';
import type { AiIndexInvestigationTraceScope } from '../../../../../common/http_api/ai_indices';
import type { TraceScopePreviewResponse } from '../../../../../common/http_api/investigation_scope';
import { useKibana } from '../../../hooks/use_kibana';
import { useSpaceId } from '../../../hooks/use_space_id';
import { useTraceAgents } from '../../../hooks/use_trace_agents';

const INCLUDE_REAL_IDS_SETTING = 'agentBuilder:tracing:includeRealIds';
const EDITOR_INLINE_MIN_HEIGHT = 140;

export const DEFAULT_TRACE_TIME_RANGE = { from: 'now-7d', to: 'now' } as const;

const getEsqlQuery = (query: AggregateQuery): string => ('esql' in query ? query.esql : '');

/** ES|QL prefill mirroring the picker, so the escape hatch starts from the same scope. */
export const buildTraceScopeEsql = ({
  tracesIndex,
  agentId,
  from,
  to,
}: {
  tracesIndex: string;
  agentId: string | undefined;
  from: string;
  to: string;
}): string =>
  [
    `FROM ${tracesIndex}`,
    `| WHERE @timestamp >= "${from}" AND @timestamp <= "${to}"`,
    ...(agentId ? [`  AND attributes.gen_ai.agent.id == "${agentId.replace(/"/g, '\\"')}"`] : []),
  ].join('\n');

interface TraceScopeSectionProps {
  trace: AiIndexInvestigationTraceScope | undefined;
  onChange: (trace: AiIndexInvestigationTraceScope) => void;
  preview: TraceScopePreviewResponse | undefined;
  isPreviewing: boolean;
  isDisabled?: boolean;
}

export const TraceScopeSection = ({
  trace,
  onChange,
  preview,
  isPreviewing,
  isDisabled = false,
}: TraceScopeSectionProps) => {
  const {
    services: { settings, spaces },
  } = useKibana();
  const { spaceId } = useSpaceId(spaces);
  const accordionId = useGeneratedHtmlId({ prefix: 'contextTraceScopeEsql' });

  const from = trace?.time_range.from ?? DEFAULT_TRACE_TIME_RANGE.from;
  const to = trace?.time_range.to ?? DEFAULT_TRACE_TIME_RANGE.to;
  const tracesIndex = buildAgentBuilderTracesIndexName(spaceId ?? 'default');

  const { agents, isLoading: isLoadingAgents, method } = useTraceAgents({ from, to });
  const includeRealIds = settings.client.get<boolean>(INCLUDE_REAL_IDS_SETTING, false);

  const [draftEsql, setDraftEsql] = useState<string>(trace?.esql ?? '');
  useEffect(() => {
    setDraftEsql(trace?.esql ?? '');
  }, [trace?.esql]);

  const options = useMemo<Array<EuiComboBoxOptionOption<string>>>(() => {
    const observed = agents.map((agent) => ({
      label:
        agent.requests !== undefined ? `${agent.agent_id} (${agent.requests})` : agent.agent_id,
      value: agent.agent_id,
    }));
    // Keep a stored agent selectable even when it has no traces in the current range.
    if (trace?.agent_id && !observed.some((option) => option.value === trace.agent_id)) {
      return [{ label: trace.agent_id, value: trace.agent_id }, ...observed];
    }
    return observed;
  }, [agents, trace?.agent_id]);

  const selectedOptions = useMemo(
    () => options.filter((option) => option.value === trace?.agent_id),
    [options, trace?.agent_id]
  );

  const update = (patch: Partial<AiIndexInvestigationTraceScope>) => {
    onChange({
      time_range: { from, to },
      ...(trace?.agent_id !== undefined ? { agent_id: trace.agent_id } : {}),
      ...(trace?.esql !== undefined ? { esql: trace.esql } : {}),
      ...patch,
    });
  };

  const prefill = buildTraceScopeEsql({ tracesIndex, agentId: trace?.agent_id, from, to });
  const hasCustomEsql = trace?.esql !== undefined && trace.esql.trim().length > 0;
  const draftDiffers = draftEsql.trim() !== (trace?.esql ?? '').trim();

  return (
    <section data-test-subj="contextTraceScopeSection">
      <EuiTitle size="xs">
        <h3>
          <FormattedMessage
            id="xpack.contextEngine.investigationScope.traces.title"
            defaultMessage="Traces"
          />
        </h3>
      </EuiTitle>
      <EuiText size="xs" color="subdued">
        <p>
          <FormattedMessage
            id="xpack.contextEngine.investigationScope.traces.description"
            defaultMessage="Agent Builder traces from this space ({index}). Only agents seen in the traces for the selected range are listed."
            values={{ index: <code>{tracesIndex}</code> }}
          />
        </p>
      </EuiText>
      <EuiSpacer size="s" />
      <EuiFlexGroup gutterSize="m">
        <EuiFlexItem>
          <EuiFormRow
            label={i18n.translate('xpack.contextEngine.investigationScope.traces.agentLabel', {
              defaultMessage: 'Agent',
            })}
            helpText={
              method === 'esql'
                ? i18n.translate('xpack.contextEngine.investigationScope.traces.agentEsqlHelp', {
                    defaultMessage: 'Listed by request count (aggregated fallback).',
                  })
                : undefined
            }
            fullWidth
          >
            <EuiComboBox<string>
              singleSelection={{ asPlainText: true }}
              placeholder={i18n.translate(
                'xpack.contextEngine.investigationScope.traces.agentPlaceholder',
                { defaultMessage: 'Select an agent seen in traces' }
              )}
              options={options}
              selectedOptions={selectedOptions}
              isLoading={isLoadingAgents}
              isDisabled={isDisabled || hasCustomEsql}
              onChange={(selected) => update({ agent_id: selected[0]?.value, esql: undefined })}
              fullWidth
              data-test-subj="contextTraceAgentPicker"
            />
          </EuiFormRow>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiFormRow
            label={i18n.translate('xpack.contextEngine.investigationScope.traces.timeRangeLabel', {
              defaultMessage: 'Time range',
            })}
            fullWidth
          >
            <EuiSuperDatePicker
              start={from}
              end={to}
              onTimeChange={({ start, end }) => update({ time_range: { from: start, to: end } })}
              showUpdateButton={false}
              isDisabled={isDisabled}
              width="full"
              data-test-subj="contextTraceTimeRange"
            />
          </EuiFormRow>
        </EuiFlexItem>
      </EuiFlexGroup>

      {!includeRealIds && (
        <>
          <EuiSpacer size="s" />
          <EuiCallOut
            announceOnMount
            size="s"
            color="primary"
            iconType="info"
            title={i18n.translate('xpack.contextEngine.investigationScope.traces.hashedIdsTitle', {
              defaultMessage:
                'Custom agent ids appear hashed because {setting} is off. The id shown is what the traces carry and what the scope stores.',
              values: { setting: INCLUDE_REAL_IDS_SETTING },
            })}
            data-test-subj="contextTraceHashedIdsCallout"
          />
        </>
      )}

      <EuiSpacer size="m" />
      <EuiAccordion
        id={accordionId}
        buttonContent={i18n.translate('xpack.contextEngine.investigationScope.traces.advanced', {
          defaultMessage: 'Advanced: ES|QL',
        })}
        initialIsOpen={hasCustomEsql}
        data-test-subj="contextTraceScopeEsqlAccordion"
      >
        <EuiSpacer size="s" />
        <EuiText size="xs" color="subdued">
          <p>
            <FormattedMessage
              id="xpack.contextEngine.investigationScope.traces.advancedHelp"
              defaultMessage="A custom query replaces the agent filter. Keep the standard span fields so the investigation can still count requests and tool calls."
            />
          </p>
        </EuiText>
        <EuiSpacer size="s" />
        <div css={{ minHeight: EDITOR_INLINE_MIN_HEIGHT }}>
          <ESQLLangEditor
            query={{ esql: draftEsql.length > 0 ? draftEsql : prefill }}
            onTextLangQueryChange={(next) => setDraftEsql(getEsqlQuery(next))}
            onTextLangQuerySubmit={async () => {}}
            editorIsInline
            hasOutline
            hideRunQueryButton
            hideQueryHistory
            expandToFitQueryOnMount
            isLoading={false}
          />
        </div>
        <EuiSpacer size="s" />
        <EuiFlexGroup gutterSize="s" justifyContent="flexEnd" responsive={false}>
          {hasCustomEsql && (
            <EuiFlexItem grow={false}>
              <EuiButton
                size="s"
                color="text"
                onClick={() => {
                  setDraftEsql('');
                  update({ esql: undefined });
                }}
                isDisabled={isDisabled}
                data-test-subj="contextTraceScopeEsqlClear"
              >
                <FormattedMessage
                  id="xpack.contextEngine.investigationScope.traces.clearEsql"
                  defaultMessage="Back to agent picker"
                />
              </EuiButton>
            </EuiFlexItem>
          )}
          <EuiFlexItem grow={false}>
            <EuiButton
              size="s"
              iconType="check"
              onClick={() => update({ esql: draftEsql.trim() })}
              isDisabled={isDisabled || draftEsql.trim().length === 0 || !draftDiffers}
              data-test-subj="contextTraceScopeEsqlApply"
            >
              <FormattedMessage
                id="xpack.contextEngine.investigationScope.traces.applyEsql"
                defaultMessage="Use this query as the trace scope"
              />
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiAccordion>

      {(trace?.agent_id || hasCustomEsql) && (
        <>
          <EuiSpacer size="m" />
          {preview?.errors && preview.errors.length > 0 ? (
            <EuiCallOut
              announceOnMount
              color="danger"
              size="s"
              title={i18n.translate(
                'xpack.contextEngine.investigationScope.traces.scopeInvalidTitle',
                { defaultMessage: 'The trace scope cannot run as written' }
              )}
              data-test-subj="contextTraceScopePreviewError"
            >
              <ul>
                {preview.errors.map((error, index) => (
                  <li key={index}>{error.message}</li>
                ))}
              </ul>
            </EuiCallOut>
          ) : (
            <EuiFlexGroup
              gutterSize="m"
              responsive={false}
              data-test-subj="contextTraceScopePreviewStats"
            >
              <EuiFlexItem>
                <EuiStat
                  titleSize="s"
                  isLoading={isPreviewing}
                  title={(preview?.requests ?? 0).toLocaleString()}
                  description={i18n.translate(
                    'xpack.contextEngine.investigationScope.traces.stat.requests',
                    { defaultMessage: 'Requests in range' }
                  )}
                />
              </EuiFlexItem>
              <EuiFlexItem>
                <EuiStat
                  titleSize="s"
                  isLoading={isPreviewing}
                  title={(preview?.tool_calls ?? 0).toLocaleString()}
                  description={i18n.translate(
                    'xpack.contextEngine.investigationScope.traces.stat.toolCalls',
                    { defaultMessage: 'Tool calls' }
                  )}
                />
              </EuiFlexItem>
              <EuiFlexItem>
                <EuiStat
                  titleSize="s"
                  isLoading={isPreviewing}
                  title={(preview?.failed_tool_calls ?? 0).toLocaleString()}
                  titleColor={(preview?.failed_tool_calls ?? 0) > 0 ? 'danger' : 'default'}
                  description={i18n.translate(
                    'xpack.contextEngine.investigationScope.traces.stat.failedToolCalls',
                    { defaultMessage: 'Failed tool calls' }
                  )}
                />
              </EuiFlexItem>
            </EuiFlexGroup>
          )}
        </>
      )}
    </section>
  );
};
