/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useMemo } from 'react';
import { FormattedMessage } from '@kbn/i18n-react';
import type { ToolDefinition } from '@kbn/agent-builder-common';
import { AGENT_BUILDER_UI_EBT } from '@kbn/agent-builder-common';
import { labels } from '../../../utils/i18n';
import { appPaths } from '../../../utils/app_paths';
import { LibraryPanel } from '../common/library_panel';
import type { LibraryPanelLabels } from '../common/library_panel';

const libraryLabels: LibraryPanelLabels = {
  title: labels.agentTools.addToolFromLibraryTitle,
  manageLibraryLink: labels.agentTools.manageToolLibraryLink,
  searchPlaceholder: labels.agentTools.searchAvailableToolsPlaceholder,
  availableSummary: (showing, total) => (
    <FormattedMessage
      id="xpack.agentBuilder.agentTools.availableToolsSummary"
      defaultMessage="Showing <bold>1-{showing}</bold> of {total} <bold>{total, plural, one {Tool} other {Tools}}</bold>"
      values={{
        showing,
        total,
        bold: (chunks) => <strong>{chunks}</strong>,
      }}
    />
  ),
  noMatchMessage: labels.agentTools.noAvailableToolsMatchMessage,
  noItemsMessage: labels.agentTools.noAvailableToolsMessage,
  disabledBadgeLabel: labels.agentTools.autoIncludedBadgeLabel,
  disabledTooltipTitle: labels.agentTools.autoIncludedTooltipTitle,
  disabledTooltipBody: labels.agentTools.autoIncludedTooltipBody,
};

interface ToolLibraryPanelProps {
  onClose: () => void;
  allTools: ToolDefinition[];
  activeToolIdSet: Set<string>;
  onToggleTool: (tool: ToolDefinition, isActive: boolean) => void;
  enableElasticCapabilities?: boolean;
  builtinToolIdSet?: Set<string>;
  /** Tools contributed by the agent's type; always active, so not toggleable here. */
  inheritedToolIdSet?: ReadonlySet<string>;
}

export const ToolLibraryPanel: React.FC<ToolLibraryPanelProps> = ({
  onClose,
  allTools,
  activeToolIdSet,
  onToggleTool,
  enableElasticCapabilities = false,
  builtinToolIdSet,
  inheritedToolIdSet,
}) => {
  const disabledItemIdSet = useMemo(() => {
    const autoIncluded = enableElasticCapabilities && builtinToolIdSet ? [...builtinToolIdSet] : [];
    const inherited = inheritedToolIdSet ? [...inheritedToolIdSet] : [];
    if (autoIncluded.length === 0 && inherited.length === 0) return undefined;
    return new Set([...autoIncluded, ...inherited]);
  }, [enableElasticCapabilities, builtinToolIdSet, inheritedToolIdSet]);

  const readOnlyItemIdSet = useMemo(
    () => new Set(allTools.filter((t) => t.readonly).map((t) => t.id)),
    [allTools]
  );

  return (
    <LibraryPanel<ToolDefinition>
      onClose={onClose}
      allItems={allTools}
      activeItemIdSet={activeToolIdSet}
      onToggleItem={onToggleTool}
      flyoutTitleId="toolLibraryFlyoutTitle"
      libraryLabels={libraryLabels}
      manageLibraryPath={appPaths.tools.list}
      disabledItemIdSet={disabledItemIdSet}
      readOnlyItemIdSet={readOnlyItemIdSet}
      ebtEntityType={AGENT_BUILDER_UI_EBT.entity.TOOL}
    />
  );
};
