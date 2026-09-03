/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, KibanaRequest } from '@kbn/core/server';
import type { Logger } from '@kbn/logging';
import { ExecutionError } from '@kbn/workflows/server';
import { CONTEXT_ENGINE_ENABLED_SETTING_ID } from '@kbn/management-settings-ids';
import { isIndexPattern, validateAiIndexId } from '../../common/ai_index_dest';
import type { AiIndexDest } from '../../common/http_api/ai_indices';
import { AiIndexAlreadyExistsError, AiIndexNotFoundError } from '../ai_indices/errors';
import type { AiIndexService } from '../ai_indices/service';
import type { KiVerificationSummary } from '../ki_verification';
import type { ContextEngineAnalyticsService, KiWriteAction } from '../telemetry';
import { errorTypeForTelemetry, isAbortError } from '../telemetry';

/** Dependencies injected into the KI step definition factories. */
export interface KiStepDependencies {
  getAiIndexService: () => AiIndexService;
  /** Whether the Context Engine advanced setting is on in the request's space. */
  isContextEngineEnabled: (request: KibanaRequest) => Promise<boolean>;
  /** Whether the request has the Context Engine write API privilege. */
  checkWritePrivilege: (request: KibanaRequest) => Promise<boolean>;
  analyticsService: ContextEngineAnalyticsService;
  logger: Logger;
}

/** The AI index attributes KI steps need: the write target and whether the index is managed. */
export interface ResolvedAiIndex {
  dest: AiIndexDest;
  managed: boolean;
}

const KI_WRITE_SUCCESS_VERB: Record<KiWriteAction, string> = {
  create: 'created in',
  update: 'updated in',
  delete: 'deleted from',
};

/**
 * Runs a KI write step body, reporting the outcome (success, failure, or
 * aborted) to EBT and the logs. The body receives a callback to record the
 * AI index's managed state once resolved, and returns the step output whose
 * `id` is the KI id.
 */
export const withKiWriteTelemetry = async <Output extends { id: string }>({
  action,
  aiIndexId,
  analyticsService,
  logger,
  run,
}: {
  action: KiWriteAction;
  aiIndexId: string;
  analyticsService: ContextEngineAnalyticsService;
  logger: Logger;
  run: (setManaged: (managed: boolean) => void) => Promise<{ output: Output }>;
}): Promise<{ output: Output }> => {
  let managed: boolean | undefined;
  try {
    const result = await run((resolvedManaged) => {
      managed = resolvedManaged;
    });
    analyticsService.reportKiWrite({ action, aiIndexId, managed, outcome: 'success' });
    logger.debug(
      `KI '${result.output.id}' ${KI_WRITE_SUCCESS_VERB[action]} AI index '${aiIndexId}'`
    );
    return result;
  } catch (error) {
    // A cancelled run is not a write failure; report it as aborted.
    const aborted = isAbortError(error);
    const errorType = aborted ? undefined : errorTypeForTelemetry(error);
    analyticsService.reportKiWrite({
      action,
      aiIndexId,
      managed,
      outcome: aborted ? 'aborted' : 'failure',
      errorType,
    });
    logger.debug(
      aborted
        ? `KI ${action} aborted in AI index '${aiIndexId}'`
        : `KI ${action} failed in AI index '${aiIndexId}': ${errorType}`
    );
    throw error;
  }
};

/**
 * Runs the verify step body, reporting the outcome (success, failure, or
 * aborted) to EBT and the logs.
 */
export const withKiVerificationTelemetry = async ({
  analyticsService,
  logger,
  run,
}: {
  analyticsService: ContextEngineAnalyticsService;
  logger: Logger;
  run: () => Promise<KiVerificationSummary>;
}): Promise<KiVerificationSummary> => {
  try {
    const summary = await run();
    const failures = summary.results.filter((result) => !result.passed);
    analyticsService.reportKiVerification({
      outcome: 'success',
      passed: summary.passed,
      verifiersRun: summary.results.length,
      failedVerifierIds: failures.map(({ verifier }) => verifier),
    });
    if (summary.passed) {
      logger.debug(`KI verification passed (verifiers run: ${summary.results.length})`);
    } else {
      logger.debug(
        `KI verification failed: ${failures.map(({ verifier }) => verifier).join(', ')}`
      );
    }
    return summary;
  } catch (error) {
    const aborted = isAbortError(error);
    const errorType = aborted ? undefined : errorTypeForTelemetry(error);
    analyticsService.reportKiVerification({
      outcome: aborted ? 'aborted' : 'failure',
      errorType,
    });
    logger.debug(aborted ? 'KI verification aborted' : `KI verification errored: ${errorType}`);
    throw error;
  }
};

const KI_OBJECT_HINT =
  'Pass the KI as a typed object: `ki: "${{ steps.build_ki.output.ki }}"` (or `"${{ foreach.item.ki }}"`), not `{{ ... }}` or `{{ ... | json }}`, which render it as text.';

const BOOLEAN_STRINGS: Record<string, boolean> = { true: true, false: false };

/**
 * The workflow engine renders `with` values without validating them against the step schema, so
 * a `ki` written with `{{ }}` arrives as a string and a boolean written with `{{ }}` arrives as
 * `"true"`. This repairs what can be repaired (a JSON string, a boolean string) and fails with a
 * message that names the fix for everything else, instead of letting a TypeError surface from
 * inside a verifier.
 */
export const normalizeKiStepInput = <Input extends { ki?: unknown }>(
  input: Input,
  { stepTypeId, booleanFields = [] }: { stepTypeId: string; booleanFields?: (keyof Input)[] }
): Input => {
  const normalized: Record<string, unknown> = { ...input };
  const { ki } = input;

  if (typeof ki === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ki);
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ExecutionError({
        type: 'ValidationError',
        message: `${stepTypeId}: \`ki\` arrived as a string ("${ki.slice(0, 60)}${
          ki.length > 60 ? '…' : ''
        }"), not an object. ${KI_OBJECT_HINT}`,
        details: { stepTypeId, receivedType: 'string' },
      });
    }
    normalized.ki = parsed;
  } else if (ki === undefined || ki === null) {
    throw new ExecutionError({
      type: 'ValidationError',
      message: `${stepTypeId}: \`ki\` is ${
        ki === null ? 'null' : 'undefined'
      }. The expression it points to resolved to nothing; check the step or variable name (\`data.set\` keys live directly under \`with\` and are read as \`variables.<key>\`). ${KI_OBJECT_HINT}`,
      details: { stepTypeId, receivedType: ki === null ? 'null' : 'undefined' },
    });
  } else if (typeof ki !== 'object' || Array.isArray(ki)) {
    throw new ExecutionError({
      type: 'ValidationError',
      message: `${stepTypeId}: \`ki\` must be an object, received ${
        Array.isArray(ki) ? 'an array' : typeof ki
      }. ${KI_OBJECT_HINT}`,
      details: { stepTypeId, receivedType: Array.isArray(ki) ? 'array' : typeof ki },
    });
  }

  for (const field of booleanFields) {
    const value = normalized[field as string];
    if (typeof value === 'string' && value.trim().toLowerCase() in BOOLEAN_STRINGS) {
      normalized[field as string] = BOOLEAN_STRINGS[value.trim().toLowerCase()];
    }
  }

  return normalized as Input;
};

/** Fails the step when the workflow user lacks the Context Engine write API privilege. */
export const assertKiWritePrivilege = async (
  checkWritePrivilege: (request: KibanaRequest) => Promise<boolean>,
  request: KibanaRequest
): Promise<void> => {
  if (!(await checkWritePrivilege(request))) {
    throw new ExecutionError({
      type: 'PermissionError',
      message: 'Insufficient privileges to modify knowledge indicators in AI indices',
    });
  }
};

/** Fails the step when the Context Engine setting is off in the request's space. */
export const assertContextEngineEnabled = async (
  isContextEngineEnabled: (request: KibanaRequest) => Promise<boolean>,
  request: KibanaRequest
): Promise<void> => {
  if (!(await isContextEngineEnabled(request))) {
    throw new ExecutionError({
      type: 'FeatureDisabledError',
      message: `Context Engine is disabled. Enable the '${CONTEXT_ENGINE_ENABLED_SETTING_ID}' advanced setting to use this step.`,
    });
  }
};

/** Resolves an AI index id to its backing store, failing the step when the id is unknown. */
export const resolveAiIndex = async (
  getAiIndexService: () => AiIndexService,
  aiIndexId: string
): Promise<ResolvedAiIndex> => {
  try {
    const { dest, managed } = await getAiIndexService().get(aiIndexId);
    return { dest, managed };
  } catch (error) {
    if (error instanceof AiIndexNotFoundError) {
      throw new ExecutionError({
        type: 'NotFoundError',
        message: `AI index '${aiIndexId}' not found`,
      });
    }
    throw error;
  }
};

/**
 * Resolves an AI index id to its backing store, lazily creating the AI index
 * when it does not exist yet with the index dest derived from the id (the UI
 * create flow's default).
 */
export const resolveOrCreateAiIndex = async (
  getAiIndexService: () => AiIndexService,
  aiIndexId: string
): Promise<ResolvedAiIndex> => {
  const service = getAiIndexService();

  try {
    const { dest, managed } = await service.get(aiIndexId);
    return { dest, managed };
  } catch (error) {
    if (!(error instanceof AiIndexNotFoundError)) {
      throw error;
    }
  }

  const { dest, error: idError } = validateAiIndexId('index', aiIndexId);
  if (idError !== undefined || dest === undefined) {
    throw new ExecutionError({
      type: 'ValidationError',
      message: `Cannot create AI index '${aiIndexId}': ${idError}`,
    });
  }

  try {
    await service.create(aiIndexId, { dest, automations: [], sources: [] });
  } catch (error) {
    if (error instanceof AiIndexAlreadyExistsError) {
      // Lost a concurrent creation race; the AI index exists now.
      const { dest: existingDest, managed } = await service.get(aiIndexId);
      return { dest: existingDest, managed };
    }
    throw error;
  }

  return { dest, managed: false };
};

/** Fails the step when the dest is an index pattern, which cannot be a write target. */
export const assertWritableDest = (aiIndexId: string, dest: AiIndexDest): void => {
  if (isIndexPattern(dest.value)) {
    throw new ExecutionError({
      type: 'ValidationError',
      message: `Cannot create a KI in AI index '${aiIndexId}': its dest is an index pattern, not a single write target`,
    });
  }
};

/** The typed error for a KI that does not exist in the given AI index. */
export const kiNotFoundError = (aiIndexId: string, kiId: string): ExecutionError =>
  new ExecutionError({
    type: 'NotFoundError',
    message: `KI '${kiId}' not found in AI index '${aiIndexId}'`,
  });

/**
 * Finds the concrete index holding a KI document. Update and delete must target
 * the backing index directly since the dest may be a data stream or a pattern.
 */
export const findKiBackingIndex = async ({
  esClient,
  aiIndexId,
  destValue,
  kiId,
  abortSignal,
}: {
  esClient: ElasticsearchClient;
  aiIndexId: string;
  destValue: string;
  kiId: string;
  abortSignal: AbortSignal;
}): Promise<string> => {
  // A dest with no physical backing index yet must resolve to empty hits, not an error.
  const response = await esClient.search(
    {
      index: destValue,
      ignore_unavailable: true,
      allow_no_indices: true,
      query: { ids: { values: [kiId] } },
      size: 2,
      _source: false,
    },
    { signal: abortSignal }
  );

  const { hits } = response.hits;
  // A pattern dest can hold the same _id in multiple indices; refuse to pick one arbitrarily.
  if (hits.length > 1) {
    const indices = hits.flatMap((hit) => (hit._index ? [hit._index] : []));
    throw new ExecutionError({
      type: 'ValidationError',
      message: `KI '${kiId}' is ambiguous in AI index '${aiIndexId}': it exists in multiple backing indices`,
      details: { indices },
    });
  }

  const backingIndex = hits[0]?._index;
  if (!backingIndex) {
    throw kiNotFoundError(aiIndexId, kiId);
  }
  return backingIndex;
};
