/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EditorError } from '@elastic/esql/types';
import type { ElasticsearchClient } from '@kbn/core/server';
import { isResponseError } from '@kbn/es-errors';
import type { ESQLMessage } from '@kbn/esql-language';
import { validateQuery } from '@kbn/esql-language';
import type { AiIndexSource } from '../../common/http_api/ai_indices';
import type {
  EsqlSourceValidationError,
  ValidateEsqlSourceResponse,
} from '../../common/http_api/investigation_scope';
import { InvalidEsqlSourceError } from '../ai_indices/errors';

const STATIC_ERROR_TYPE = 'static';

const toStaticError = (error: ESQLMessage | EditorError): EsqlSourceValidationError =>
  'text' in error
    ? {
        type: STATIC_ERROR_TYPE,
        message: error.text,
        position: { min: error.location.min, max: error.location.max },
      }
    : {
        type: STATIC_ERROR_TYPE,
        message: error.message,
        position: { min: error.startColumn, max: error.endColumn },
      };

interface EsErrorBody {
  error?: {
    type?: string;
    reason?: string;
    root_cause?: Array<{ type?: string; reason?: string }>;
  };
}

const toExecutionError = (error: unknown): EsqlSourceValidationError | undefined => {
  if (!isResponseError(error)) {
    return undefined;
  }
  const body = error.body as EsErrorBody | undefined;
  const rootCause = body?.error?.root_cause?.[0];
  return {
    type: body?.error?.type ?? rootCause?.type ?? 'execution_error',
    message: rootCause?.reason ?? body?.error?.reason ?? error.message,
  };
};

/**
 * Validates an ES|QL source in two layers, as the calling user: the static parser (the same
 * `validateQuery` the `esql-valid-syntax` verifier uses), then a `| LIMIT 0` execution that
 * surfaces unknown indices or fields and missing privileges without returning rows.
 */
export const validateEsqlSource = async (
  esClient: ElasticsearchClient,
  query: string
): Promise<ValidateEsqlSourceResponse> => {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return {
      valid: false,
      errors: [{ type: STATIC_ERROR_TYPE, message: 'ES|QL query must not be empty' }],
    };
  }

  const { errors } = await validateQuery(trimmed);
  if (errors.length > 0) {
    return { valid: false, errors: errors.map(toStaticError) };
  }

  try {
    await esClient.esql.query({ query: `${trimmed} | LIMIT 0`, format: 'json' });
  } catch (error) {
    const executionError = toExecutionError(error);
    if (executionError === undefined) {
      throw error;
    }
    return { valid: false, errors: [executionError] };
  }

  return { valid: true };
};

const previewQuery = (query: string): string =>
  query.length > 120 ? `${query.slice(0, 120)}…` : query;

/**
 * Rejects an AI index write when any `esql` source fails {@link validateEsqlSource}, so API
 * callers cannot persist a source the investigation could never run.
 */
export const assertValidEsqlSources = async (
  esClient: ElasticsearchClient,
  sources: AiIndexSource[]
): Promise<void> => {
  // Blank values are accepted by the schema (placeholder rows); there is nothing to validate.
  const esqlSources = sources.filter(
    (source) => source.type === 'esql' && source.value.trim().length > 0
  );
  for (const source of esqlSources) {
    const result = await validateEsqlSource(esClient, source.value);
    if (!result.valid) {
      throw new InvalidEsqlSourceError(
        `ES|QL source "${previewQuery(source.value)}" is invalid: ${result.errors
          .map((error) => error.message)
          .join('; ')}`
      );
    }
  }
};
