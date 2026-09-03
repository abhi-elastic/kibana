/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiCheckableCard,
  EuiCode,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiSkeletonText,
  EuiSpacer,
  EuiText,
  EuiTitle,
  EuiToolTip,
  useGeneratedHtmlId,
} from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import { FormattedMessage } from '@kbn/i18n-react';
import React, { useState } from 'react';
import type { AiIndexType, GetAiIndexResponse } from '../../../../common/http_api/ai_indices';
import { useSaveAiIndexStorageType } from '../../hooks/use_save_ai_index_storage_type';
import { getAiIndexDest } from '../../utils/ai_index_dest';
import { STORAGE_TYPE_OPTIONS, getStorageTypeOption } from './storage_type_options';

interface StorageTypePanelProps {
  isLoading: boolean;
  aiIndex: GetAiIndexResponse | undefined;
  /** Once Knowledge Indicators exist the backing store holds data, so the type is fixed. */
  hasKis: boolean;
  onSaved: () => void;
  isManaged: boolean;
}

const hasKisTooltip = i18n.translate('xpack.contextEngine.aiIndexDetail.storageType.lockedKis', {
  defaultMessage:
    'The storage type cannot change once this AI index holds Knowledge Indicators. Delete them first, or create a new AI index.',
});

const customDestTooltip = i18n.translate(
  'xpack.contextEngine.aiIndexDetail.storageType.lockedCustomDest',
  {
    defaultMessage:
      'This AI index points at a custom backing store. Change it through the API instead.',
  }
);

/** True when the dest is the one the UI derives from the id, so switching type is a clean swap. */
const usesCanonicalDest = (aiIndex: GetAiIndexResponse): boolean =>
  aiIndex.dest.value === getAiIndexDest(aiIndex.dest.type, aiIndex.id).value;

export const StorageTypePanel = ({
  isLoading,
  aiIndex,
  hasKis,
  onSaved,
  isManaged,
}: StorageTypePanelProps) => {
  const { saveStorageType, isSaving } = useSaveAiIndexStorageType();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<AiIndexType>('index');
  const groupName = useGeneratedHtmlId({ prefix: 'aiIndexStorageType' });

  const lockReason =
    aiIndex === undefined
      ? undefined
      : hasKis
      ? hasKisTooltip
      : !usesCanonicalDest(aiIndex)
      ? customDestTooltip
      : undefined;
  const canEdit = aiIndex !== undefined && !isManaged && !isLoading && lockReason === undefined;

  const startEditing = () => {
    if (!aiIndex) {
      return;
    }
    setDraft(aiIndex.dest.type);
    setIsEditing(true);
  };

  const handleSave = async () => {
    if (!aiIndex) {
      return;
    }
    if (draft === aiIndex.dest.type) {
      setIsEditing(false);
      return;
    }
    const saved = await saveStorageType(aiIndex, draft);
    if (saved) {
      setIsEditing(false);
      onSaved();
    }
  };

  const current = aiIndex ? getStorageTypeOption(aiIndex.dest.type) : undefined;

  const editButton = (
    <EuiButtonEmpty
      size="s"
      iconType="pencil"
      onClick={startEditing}
      isDisabled={!canEdit}
      data-test-subj="contextEditStorageTypeButton"
    >
      <FormattedMessage
        id="xpack.contextEngine.aiIndexDetail.storageType.editButton"
        defaultMessage="Edit"
      />
    </EuiButtonEmpty>
  );

  return (
    <EuiPanel hasBorder paddingSize="l" data-test-subj="contextStorageTypePanel">
      <EuiFlexGroup alignItems="flexStart" gutterSize="m" responsive={false}>
        <EuiFlexItem>
          <EuiTitle size="s">
            <h2>
              <FormattedMessage
                id="xpack.contextEngine.aiIndexDetail.storageType.title"
                defaultMessage="Storage type"
              />
            </h2>
          </EuiTitle>
          <EuiSpacer size="xs" />
          <EuiText size="s" color="subdued">
            <p>
              <FormattedMessage
                id="xpack.contextEngine.aiIndexDetail.storageType.description"
                defaultMessage="How this AI index stores pre-computed context."
              />
            </p>
          </EuiText>
        </EuiFlexItem>
        {!isEditing && !isManaged && !isLoading && (
          <EuiFlexItem grow={false}>
            {lockReason ? (
              <EuiToolTip content={lockReason} position="left">
                <span tabIndex={0} data-test-subj="contextStorageTypeLocked">
                  {editButton}
                </span>
              </EuiToolTip>
            ) : (
              editButton
            )}
          </EuiFlexItem>
        )}
      </EuiFlexGroup>
      <EuiSpacer size="m" />
      {isLoading || !aiIndex || !current ? (
        <EuiSkeletonText lines={2} />
      ) : isEditing ? (
        <>
          <EuiFlexGroup direction="column" gutterSize="m">
            {STORAGE_TYPE_OPTIONS.map((option) => (
              <EuiFlexItem key={option.type}>
                <EuiCheckableCard
                  id={`${groupName}-${option.type}`}
                  name={groupName}
                  checkableType="radio"
                  checked={draft === option.type}
                  onChange={() => setDraft(option.type)}
                  data-test-subj={`contextAiIndexStorageType-${option.type}`}
                  label={
                    <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
                      <EuiFlexItem grow={false}>
                        <strong>{option.title}</strong>
                      </EuiFlexItem>
                      <EuiFlexItem grow={false}>
                        <EuiBadge color="hollow">{option.badge}</EuiBadge>
                      </EuiFlexItem>
                    </EuiFlexGroup>
                  }
                >
                  <EuiText size="s" color="subdued">
                    {option.description}
                  </EuiText>
                </EuiCheckableCard>
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>
          <EuiSpacer size="s" />
          <EuiText size="xs" color="subdued">
            <p>
              <FormattedMessage
                id="xpack.contextEngine.aiIndexDetail.storageType.destPreview"
                defaultMessage="Pre-computed context will be stored in {dest}."
                values={{ dest: <EuiCode>{getAiIndexDest(draft, aiIndex.id).value}</EuiCode> }}
              />
            </p>
          </EuiText>
          <EuiSpacer size="m" />
          <EuiFlexGroup justifyContent="flexEnd" gutterSize="s" responsive={false}>
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty
                onClick={() => setIsEditing(false)}
                isDisabled={isSaving}
                data-test-subj="contextStorageTypeCancelButton"
              >
                <FormattedMessage
                  id="xpack.contextEngine.aiIndexDetail.storageType.cancelButton"
                  defaultMessage="Cancel"
                />
              </EuiButtonEmpty>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton
                fill
                size="s"
                onClick={handleSave}
                isLoading={isSaving}
                data-test-subj="contextStorageTypeSaveButton"
              >
                <FormattedMessage
                  id="xpack.contextEngine.aiIndexDetail.storageType.saveButton"
                  defaultMessage="Save"
                />
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        </>
      ) : (
        <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
          <EuiFlexItem grow={false}>
            <EuiText size="s">
              <strong data-test-subj="contextStorageTypeValue">{current.title}</strong>
            </EuiText>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiBadge color="hollow">{current.badge}</EuiBadge>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiText size="s" color="subdued">
              <FormattedMessage
                id="xpack.contextEngine.aiIndexDetail.storageType.currentDest"
                defaultMessage="stored in {dest}"
                values={{ dest: <EuiCode>{aiIndex.dest.value}</EuiCode> }}
              />
            </EuiText>
          </EuiFlexItem>
        </EuiFlexGroup>
      )}
    </EuiPanel>
  );
};
