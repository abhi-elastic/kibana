/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const contextEngineQueryKeys = {
  aiIndex: {
    list: () => ['context_engine', 'ai_index', 'list'] as const,
    detail: (aiIndexId: string) => ['context_engine', 'ai_index', aiIndexId] as const,
    kiList: (aiIndexId: string, size: number, type: string | undefined) =>
      ['context_engine', 'ai_index', aiIndexId, 'ki_list', size, type ?? ''] as const,
    ki: (aiIndexId: string, index: string, kiId: string) =>
      ['context_engine', 'ai_index', aiIndexId, 'ki', index, kiId] as const,
  },
  connectors: {
    list: () => ['context_engine', 'connectors', 'list'] as const,
    types: () => ['context_engine', 'connectors', 'types'] as const,
  },
  investigationScope: {
    traceAgents: (from: string, to: string) =>
      ['context_engine', 'investigation_scope', 'trace_agents', from, to] as const,
    traceScopePreview: (from: string, to: string, agentId: string, esql: string) =>
      [
        'context_engine',
        'investigation_scope',
        'trace_scope_preview',
        from,
        to,
        agentId,
        esql,
      ] as const,
    indexSuggestions: (prefix: string) =>
      ['context_engine', 'investigation_scope', 'index_suggestions', prefix] as const,
  },
  investigations: {
    latest: (aiIndexId: string) =>
      ['context_engine', 'investigations', aiIndexId, 'latest'] as const,
  },
  signals: {
    groups: () => ['context_engine', 'signals', 'groups'] as const,
    byTag: (tag: string, from: number, size: number) =>
      ['context_engine', 'signals', 'by_tag', tag, from, size] as const,
  },
};
