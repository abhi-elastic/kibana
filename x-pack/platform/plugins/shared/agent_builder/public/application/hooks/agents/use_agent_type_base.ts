/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { formatAgentBuilderErrorMessage } from '@kbn/agent-builder-browser';
import type { ToolSelection } from '@kbn/agent-builder-common';
import { useQuery } from '@kbn/react-query';
import { useMemo } from 'react';
import type { GetAgentTypeBaseResponse } from '../../../../common/http_api/agents';
import { queryKeys } from '../../query_keys';
import { labels } from '../../utils/i18n';
import { useAgentBuilderServices } from '../use_agent_builder_service';
import { useToasts } from '../use_toasts';

export interface AgentTypeBase {
  /** Human-readable type name, falling back to the type id. */
  typeName: string;
  tools: ToolSelection[];
  skillIds: string[];
}

const EMPTY_TOOLS: ToolSelection[] = [];
const EMPTY_SKILL_IDS: string[] = [];

interface UseAgentTypeBaseResult {
  typeBase: AgentTypeBase | undefined;
  isLoading: boolean;
}

/**
 * Loads the tools and skills an existing agent inherits from its type. Disabled while creating an
 * agent, when there is nothing persisted to inherit from yet.
 */
export const useAgentTypeBase = (agentId: string | undefined): UseAgentTypeBaseResult => {
  const { agentService } = useAgentBuilderServices();
  const { addErrorToast } = useToasts();
  const isEnabled = Boolean(agentId);

  const { data, isLoading } = useQuery<GetAgentTypeBaseResponse, Error>({
    queryKey: queryKeys.agentProfiles.agentTypeBaseById(agentId ?? ''),
    queryFn: () => agentService.getAgentTypeBase(agentId!),
    enabled: isEnabled,
    onError: (err) => {
      if (isEnabled) {
        addErrorToast({
          title: labels.agentTools.loadInheritedErrorMessage,
          text: formatAgentBuilderErrorMessage(err),
        });
      }
    },
  });

  const typeBase = useMemo<AgentTypeBase | undefined>(
    () =>
      data
        ? {
            typeName: data.agent_type_name ?? data.agent_type,
            tools: data.tools.length > 0 ? data.tools : EMPTY_TOOLS,
            skillIds: data.skill_ids.length > 0 ? data.skill_ids : EMPTY_SKILL_IDS,
          }
        : undefined,
    [data]
  );

  return { typeBase, isLoading: isEnabled && isLoading };
};
