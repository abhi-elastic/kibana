/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useQuery } from '@kbn/react-query';
import { contextEngineQueryKeys } from './query_keys';
import { useKibana } from './use_kibana';

export type IndexSuggestionKind = 'index' | 'data_stream' | 'alias';

export interface IndexSuggestion {
  name: string;
  kind: IndexSuggestionKind;
}

/** Results kept per kind so one noisy kind cannot crowd the others out of the list. */
export const INDEX_SUGGESTIONS_PER_KIND = 25;

const SUGGESTIONS_STALE_TIME_MS = 60_000;

const kindFromTags = (tags: Array<{ key: string }>): IndexSuggestionKind => {
  if (tags.some((tag) => tag.key === 'data_stream')) {
    return 'data_stream';
  }
  if (tags.some((tag) => tag.key === 'alias')) {
    return 'alias';
  }
  return 'index';
};

/** Drops system and hidden (dot-prefixed) names and caps each kind. */
export const shapeIndexSuggestions = (
  items: Array<{ name: string; tags: Array<{ key: string }> }>
): IndexSuggestion[] => {
  const perKind = new Map<IndexSuggestionKind, IndexSuggestion[]>();
  for (const item of items) {
    if (item.name.startsWith('.')) {
      continue;
    }
    const kind = kindFromTags(item.tags);
    const bucket = perKind.get(kind) ?? [];
    if (bucket.length < INDEX_SUGGESTIONS_PER_KIND) {
      bucket.push({ name: item.name, kind });
      perKind.set(kind, bucket);
    }
  }
  return [...perKind.values()].flat().sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * Typed-prefix index / data stream / alias lookup for the guided source picker. Never queries `*`:
 * an empty prefix yields no suggestions, so the first paint does not scan the cluster.
 */
export const useIndexSuggestions = (prefix: string) => {
  const {
    services: { data },
  } = useKibana();
  const trimmed = prefix.trim();
  const enabled = trimmed.length > 0;

  const {
    data: suggestions,
    isLoading,
    isError,
  } = useQuery<IndexSuggestion[], Error>({
    queryKey: contextEngineQueryKeys.investigationScope.indexSuggestions(trimmed),
    queryFn: async () => {
      const pattern = trimmed.endsWith('*') ? trimmed : `${trimmed}*`;
      const items = await data.dataViews.getIndices({
        pattern,
        showAllIndices: false,
        isRollupIndex: () => false,
      });
      return shapeIndexSuggestions(items);
    },
    enabled,
    staleTime: SUGGESTIONS_STALE_TIME_MS,
    keepPreviousData: true,
  });

  return { suggestions: suggestions ?? [], isLoading: enabled && isLoading, isError };
};
