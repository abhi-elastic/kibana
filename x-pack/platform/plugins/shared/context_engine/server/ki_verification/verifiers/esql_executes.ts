/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { isResponseError } from '@kbn/es-errors';
import type { KiVerifier } from '../types';
import {
  ESQL_ATTRIBUTE_KEY,
  getEsqlQueries,
  getEsqlValue,
  previewQuery,
} from './esql_valid_syntax';

export const ESQL_EXECUTES_VERIFIER_ID = 'esql-executes';

/** Named parameters (`?case_number`) mark a template the agent fills in at ask time; it cannot run as is. */
const NAMED_PARAM_PATTERN = /\?[A-Za-z_][A-Za-z0-9_]*/;

interface EsErrorBody {
  error?: {
    type?: string;
    reason?: string;
    root_cause?: Array<{ type?: string; reason?: string }>;
  };
}

const describeExecutionError = (error: unknown): string | undefined => {
  if (!isResponseError(error)) {
    return undefined;
  }
  const body = error.body as EsErrorBody | undefined;
  const rootCause = body?.error?.root_cause?.[0];
  const type = body?.error?.type ?? rootCause?.type ?? 'execution_error';
  const reason = rootCause?.reason ?? body?.error?.reason ?? error.message;
  return `${type}: ${reason}`;
};

/**
 * Runs each query in `attributes.esql` with `| LIMIT 0`, which surfaces unknown indices and
 * fields and missing privileges without returning rows. Opt-in through `executeEsql` on the
 * verifier context because it costs one query per KI. Parameterised templates are skipped.
 */
export const createEsqlExecutesVerifier = (): KiVerifier => ({
  id: ESQL_EXECUTES_VERIFIER_ID,
  applies: (ki, context) => context?.executeEsql === true && getEsqlValue(ki) !== undefined,
  async verify(ki, { esClient, abortSignal }) {
    const queries = getEsqlQueries(ki);
    if (!queries) {
      // The syntax verifier reports the malformed field; this one has nothing to run.
      return {
        passed: false,
        reason: `attributes.${ESQL_ATTRIBUTE_KEY} is not a well-formed query or list of queries`,
      };
    }
    const failures: string[] = [];
    for (const query of queries) {
      abortSignal?.throwIfAborted();
      if (NAMED_PARAM_PATTERN.test(query)) {
        continue;
      }
      try {
        await esClient.esql.query(
          { query: `${query} | LIMIT 0`, format: 'json' },
          { signal: abortSignal }
        );
      } catch (error) {
        const described = describeExecutionError(error);
        if (described === undefined) {
          throw error;
        }
        failures.push(`ES|QL query "${previewQuery(query)}" failed to execute: ${described}`);
      }
    }
    return failures.length > 0 ? { passed: false, reason: failures.join('\n') } : { passed: true };
  },
});
