/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { isResponseError } from '@kbn/es-errors';
import type { KiVerifier, KiVerifierContext, KnowledgeIndicator } from '../types';

export const INDEX_EXISTS_VERIFIER_ID = 'index-exists';

/** KI attribute naming the index, alias, data stream or pattern the KI is about. */
export const INDEX_ATTRIBUTE_KEY = 'index';

const MAX_INDEX_PATTERNS = 20;

const getIndexPatterns = (ki: KnowledgeIndicator): string[] | undefined => {
  const value = ki.attributes?.[INDEX_ATTRIBUTE_KEY];
  const candidates = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
  if (!candidates) {
    return undefined;
  }
  return candidates.filter((entry): entry is string => typeof entry === 'string');
};

const resolves = async (
  pattern: string,
  { esClient, abortSignal }: KiVerifierContext
): Promise<boolean> => {
  try {
    const resolved = await esClient.indices.resolveIndex(
      { name: pattern, expand_wildcards: ['open'] },
      { signal: abortSignal }
    );
    return (
      resolved.indices.length > 0 || resolved.aliases.length > 0 || resolved.data_streams.length > 0
    );
  } catch (error) {
    if (isResponseError(error) && error.statusCode === 404) {
      return false;
    }
    throw error;
  }
};

/** Checks that every index named in `attributes.index` resolves to at least one open target. */
export const createIndexExistsVerifier = (): KiVerifier => ({
  id: INDEX_EXISTS_VERIFIER_ID,
  applies: (ki) => ki.attributes?.[INDEX_ATTRIBUTE_KEY] !== undefined,
  async verify(ki, context) {
    const patterns = getIndexPatterns(ki);
    if (!patterns || patterns.length === 0 || patterns.some((entry) => entry.trim().length === 0)) {
      return {
        passed: false,
        reason: `attributes.${INDEX_ATTRIBUTE_KEY} must be a non-empty index name or a non-empty array of index names`,
      };
    }
    if (patterns.length > MAX_INDEX_PATTERNS) {
      return {
        passed: false,
        reason: `attributes.${INDEX_ATTRIBUTE_KEY} names ${patterns.length} indices; the maximum is ${MAX_INDEX_PATTERNS}`,
      };
    }
    const missing: string[] = [];
    for (const pattern of patterns) {
      context.abortSignal?.throwIfAborted();
      if (!(await resolves(pattern.trim(), context))) {
        missing.push(pattern.trim());
      }
    }
    return missing.length > 0
      ? {
          passed: false,
          reason: `attributes.${INDEX_ATTRIBUTE_KEY} does not resolve to any open index, alias or data stream: ${missing.join(
            ', '
          )}`,
        }
      : { passed: true };
  },
});
