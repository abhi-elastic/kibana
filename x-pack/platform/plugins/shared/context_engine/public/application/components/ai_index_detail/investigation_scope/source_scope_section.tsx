/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiFlexGroup,
  EuiFlexItem,
  EuiSpacer,
  EuiStat,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import { FormattedMessage } from '@kbn/i18n-react';
import React, { useMemo } from 'react';
import type { AiIndexSource } from '../../../../../common/http_api/ai_indices';
import type {
  EsqlSourcePreview,
  PreviewSourcesResponse,
} from '../../../../../common/http_api/investigation_scope';
import { useDataConnectors } from '../../../hooks/use_data_connectors';
import { toSourceType } from '../../../utils/sources';
import { getSourceDisplay } from '../../source_display';
import { SourceRow } from '../../source_row';

interface SourceScopeSectionProps {
  sources: AiIndexSource[];
  canEdit: boolean;
  onEditSources: () => void;
  onPreview: () => void;
  isPreviewing: boolean;
  preview: PreviewSourcesResponse | undefined;
  previewError: Error | undefined;
}

const formatCount = (count: number, capped: boolean): string =>
  `${capped ? '≥' : ''}${count.toLocaleString()}`;

export const SourceScopeSection = ({
  sources,
  canEdit,
  onEditSources,
  onPreview,
  isPreviewing,
  preview,
  previewError,
}: SourceScopeSectionProps) => {
  const hasConnectorSources = useMemo(
    () => sources.some((source) => source.type === 'connector'),
    [sources]
  );
  const esqlSourceCount = useMemo(
    () => sources.filter((source) => source.type === 'esql').length,
    [sources]
  );
  const { connectorNameById, connectorActionTypeById } = useDataConnectors({
    enabled: hasConnectorSources,
  });

  const invalidPreviews: EsqlSourcePreview[] =
    preview?.sources.filter((entry): entry is EsqlSourcePreview => entry.status === 'invalid') ??
    [];

  return (
    <section data-test-subj="contextSourceScopeSection">
      <EuiFlexGroup alignItems="center" gutterSize="m" responsive={false}>
        <EuiFlexItem css={{ minWidth: 0 }}>
          <EuiTitle size="xs">
            <h3>
              <FormattedMessage
                id="xpack.contextEngine.investigationScope.sources.title"
                defaultMessage="Sources"
              />
            </h3>
          </EuiTitle>
          <EuiText size="xs" color="subdued">
            <p>
              <FormattedMessage
                id="xpack.contextEngine.investigationScope.sources.description"
                defaultMessage="Elasticsearch data the agent may read. Connector sources are listed but not investigated in this version."
              />
            </p>
          </EuiText>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiFlexGroup gutterSize="s" responsive={false}>
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty
                size="s"
                iconType="pencil"
                onClick={onEditSources}
                isDisabled={!canEdit}
                data-test-subj="contextEditSourcesButton"
              >
                <FormattedMessage
                  id="xpack.contextEngine.investigationScope.sources.editButton"
                  defaultMessage="Edit"
                />
              </EuiButtonEmpty>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton
                size="s"
                iconType="play"
                onClick={onPreview}
                isLoading={isPreviewing}
                isDisabled={esqlSourceCount === 0}
                data-test-subj="contextPreviewSourcesButton"
              >
                <FormattedMessage
                  id="xpack.contextEngine.investigationScope.sources.previewButton"
                  defaultMessage="Validate and preview"
                />
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="s" />
      {sources.length === 0 ? (
        <EuiText size="s" color="subdued" data-test-subj="contextAiIndexSourcesEmpty">
          <p>
            <FormattedMessage
              id="xpack.contextEngine.investigationScope.sources.empty"
              defaultMessage="No sources yet. Add the indices or ES|QL queries the agent should read."
            />
          </p>
        </EuiText>
      ) : (
        <EuiFlexGroup direction="column" gutterSize="s">
          {sources.map((source) => {
            const { label, typeLabel, icon, content } = getSourceDisplay(
              toSourceType(source.type),
              source.value,
              { connectorNameById, connectorActionTypeById }
            );
            return (
              <EuiFlexItem key={`${source.type}-${source.value}`}>
                <SourceRow
                  label={label}
                  typeLabel={typeLabel}
                  icon={icon}
                  data-test-subj="contextAiIndexSourceRow"
                >
                  {content}
                </SourceRow>
              </EuiFlexItem>
            );
          })}
        </EuiFlexGroup>
      )}

      {previewError && (
        <>
          <EuiSpacer size="s" />
          <EuiCallOut
            announceOnMount
            color="danger"
            size="s"
            title={i18n.translate('xpack.contextEngine.investigationScope.sources.previewFailed', {
              defaultMessage: 'Preview failed',
            })}
            data-test-subj="contextSourcePreviewError"
          >
            <p>{previewError.message}</p>
          </EuiCallOut>
        </>
      )}

      {preview && (
        <>
          <EuiSpacer size="m" />
          <EuiFlexGroup
            gutterSize="m"
            responsive={false}
            data-test-subj="contextSourcePreviewStats"
          >
            <EuiFlexItem>
              <EuiStat
                titleSize="s"
                title={`${preview.summary.valid_sources}/${esqlSourceCount}`}
                description={i18n.translate(
                  'xpack.contextEngine.investigationScope.sources.stat.valid',
                  { defaultMessage: 'ES|QL sources valid' }
                )}
                titleColor={preview.summary.invalid_sources > 0 ? 'danger' : 'success'}
              />
            </EuiFlexItem>
            <EuiFlexItem>
              <EuiStat
                titleSize="s"
                title={preview.summary.resolved_indices.length.toLocaleString()}
                description={i18n.translate(
                  'xpack.contextEngine.investigationScope.sources.stat.indices',
                  { defaultMessage: 'Indices resolved' }
                )}
              />
            </EuiFlexItem>
            <EuiFlexItem>
              <EuiStat
                titleSize="s"
                title={formatCount(preview.summary.doc_count, preview.summary.count_capped)}
                description={i18n.translate(
                  'xpack.contextEngine.investigationScope.sources.stat.documents',
                  { defaultMessage: 'Documents' }
                )}
              />
            </EuiFlexItem>
          </EuiFlexGroup>
          <EuiSpacer size="s" />
          {invalidPreviews.length > 0 ? (
            <EuiCallOut
              announceOnMount
              color="danger"
              size="s"
              title={i18n.translate('xpack.contextEngine.investigationScope.sources.invalidTitle', {
                defaultMessage:
                  '{count, plural, one {# source} other {# sources}} cannot run as written',
                values: { count: invalidPreviews.length },
              })}
              data-test-subj="contextSourcePreviewInvalid"
            >
              <ul>
                {invalidPreviews.map((entry) => (
                  <li key={entry.source.value}>
                    <code>{entry.source.value}</code>:{' '}
                    {entry.errors.map((error) => error.message).join('; ')}
                  </li>
                ))}
              </ul>
            </EuiCallOut>
          ) : (
            <EuiCallOut
              announceOnMount
              color="success"
              size="s"
              title={i18n.translate('xpack.contextEngine.investigationScope.sources.validTitle', {
                defaultMessage: 'All ES|QL sources run. Resolved: {indices}',
                values: {
                  indices:
                    preview.summary.resolved_indices.length > 0
                      ? preview.summary.resolved_indices.join(', ')
                      : '—',
                },
              })}
              data-test-subj="contextSourcePreviewValid"
            />
          )}
          {preview.summary.skipped_sources > 0 && (
            <>
              <EuiSpacer size="xs" />
              <EuiText size="xs" color="subdued">
                <FormattedMessage
                  id="xpack.contextEngine.investigationScope.sources.skippedNote"
                  defaultMessage="{count, plural, one {# connector source is} other {# connector sources are}} not investigated in this version."
                  values={{ count: preview.summary.skipped_sources }}
                />
              </EuiText>
            </>
          )}
        </>
      )}
    </section>
  );
};
