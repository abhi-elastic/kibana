/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  MAX_KI_ATTRIBUTE_ARRAY_VALUES,
  MAX_KI_ATTRIBUTE_KEY_LENGTH,
  MAX_KI_ATTRIBUTE_VALUE_LENGTH,
  MAX_KI_ATTRIBUTES,
  MAX_KI_CONTENT_LENGTH,
  MAX_KI_DESCRIPTION_LENGTH,
  MAX_KI_TAG_LENGTH,
  MAX_KI_TAGS,
  MAX_KI_TITLE_LENGTH,
  MAX_KI_TYPE_LENGTH,
} from '../../../common/step_types/ki';
import type { KiVerifier, KnowledgeIndicator } from '../types';
import { ESQL_ATTRIBUTE_KEY } from './esql_valid_syntax';
import { FINDING_ID_ATTRIBUTE_KEY } from './provenance_present';

export const SCHEMA_SHAPE_VERIFIER_ID = 'schema-shape';

export const CONFIDENCE_ATTRIBUTE_KEY = 'confidence';
export const EXPIRES_AT_ATTRIBUTE_KEY = 'expires_at';

/** KI types authored from a finding; each needs the finding it answers and non-empty content. */
export const TARGETED_KI_TYPES: readonly string[] = [
  'constraint',
  'workaround',
  'disambiguation',
  'task_recipe',
  'fact',
];

/** KI types whose value is a runnable query; each needs `attributes.esql`. */
const QUERY_KI_TYPES: readonly string[] = ['detection'];

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const checkLength = (
  failures: string[],
  field: string,
  value: unknown,
  max: number,
  { required }: { required: boolean }
): void => {
  if (value === undefined) {
    if (required) {
      failures.push(`${field} is required`);
    }
    return;
  }
  if (typeof value !== 'string') {
    failures.push(`${field} must be a string`);
    return;
  }
  if (required && value.trim().length === 0) {
    failures.push(`${field} must not be empty`);
  }
  if (value.length > max) {
    failures.push(`${field} exceeds ${max} characters`);
  }
};

const checkTags = (failures: string[], tags: unknown): void => {
  if (tags === undefined) {
    return;
  }
  if (!Array.isArray(tags)) {
    failures.push('tags must be an array of strings');
    return;
  }
  if (tags.length > MAX_KI_TAGS) {
    failures.push(`tags has ${tags.length} entries; the maximum is ${MAX_KI_TAGS}`);
  }
  const invalid = tags.filter(
    (tag) => !isNonEmptyString(tag) || tag.length > MAX_KI_TAG_LENGTH
  ).length;
  if (invalid > 0) {
    failures.push(
      `tags must contain only non-empty strings of at most ${MAX_KI_TAG_LENGTH} characters`
    );
  }
};

const isAttributeValue = (value: unknown): boolean => {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'string') {
    return value.length <= MAX_KI_ATTRIBUTE_VALUE_LENGTH;
  }
  return (
    Array.isArray(value) &&
    value.length <= MAX_KI_ATTRIBUTE_ARRAY_VALUES &&
    value.every(
      (entry) => typeof entry === 'string' && entry.length <= MAX_KI_ATTRIBUTE_VALUE_LENGTH
    )
  );
};

const checkAttributes = (failures: string[], attributes: unknown): void => {
  if (attributes === undefined) {
    return;
  }
  if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) {
    failures.push('attributes must be an object');
    return;
  }
  const entries = Object.entries(attributes as Record<string, unknown>);
  if (entries.length > MAX_KI_ATTRIBUTES) {
    failures.push(`attributes has ${entries.length} entries; the maximum is ${MAX_KI_ATTRIBUTES}`);
  }
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > MAX_KI_ATTRIBUTE_KEY_LENGTH) {
      failures.push(
        `attributes key "${key.slice(0, 40)}" must be 1-${MAX_KI_ATTRIBUTE_KEY_LENGTH} characters`
      );
    }
    if (!isAttributeValue(value)) {
      failures.push(
        `attributes.${key} must be a string, number, boolean or array of strings (nested objects are not allowed)`
      );
    }
  }

  const confidence = (attributes as Record<string, unknown>)[CONFIDENCE_ATTRIBUTE_KEY];
  if (confidence !== undefined) {
    const numeric = typeof confidence === 'string' ? Number(confidence) : confidence;
    if (typeof numeric !== 'number' || Number.isNaN(numeric) || numeric < 0 || numeric > 1) {
      failures.push(`attributes.${CONFIDENCE_ATTRIBUTE_KEY} must be a number between 0 and 1`);
    }
  }

  const expiresAt = (attributes as Record<string, unknown>)[EXPIRES_AT_ATTRIBUTE_KEY];
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
      failures.push(`attributes.${EXPIRES_AT_ATTRIBUTE_KEY} must be an ISO-8601 date string`);
    }
  }
};

const checkTypeSpecific = (failures: string[], ki: KnowledgeIndicator): void => {
  const { type, attributes, content } = ki;
  if (typeof type !== 'string') {
    return;
  }
  if (TARGETED_KI_TYPES.includes(type)) {
    if (!isNonEmptyString(content)) {
      failures.push(`a "${type}" KI must carry its answer in content`);
    }
    if (!isNonEmptyString(attributes?.[FINDING_ID_ATTRIBUTE_KEY])) {
      failures.push(
        `a "${type}" KI must name the finding it answers in attributes.${FINDING_ID_ATTRIBUTE_KEY}`
      );
    }
  }
  if (QUERY_KI_TYPES.includes(type) && attributes?.[ESQL_ATTRIBUTE_KEY] === undefined) {
    failures.push(`a "${type}" KI must carry its query in attributes.${ESQL_ATTRIBUTE_KEY}`);
  }
};

/**
 * Checks the KI against the AI index document shape: required fields, length bounds, tag and
 * attribute value types, well-formed quality fields, and the attributes each KI type needs.
 */
export const createSchemaShapeVerifier = (): KiVerifier => ({
  id: SCHEMA_SHAPE_VERIFIER_ID,
  applies: () => true,
  async verify(ki) {
    const failures: string[] = [];
    checkLength(failures, 'type', ki.type, MAX_KI_TYPE_LENGTH, { required: true });
    checkLength(failures, 'title', ki.title, MAX_KI_TITLE_LENGTH, { required: true });
    checkLength(failures, 'description', ki.description, MAX_KI_DESCRIPTION_LENGTH, {
      required: false,
    });
    checkLength(failures, 'content', ki.content, MAX_KI_CONTENT_LENGTH, { required: false });
    checkTags(failures, ki.tags);
    checkAttributes(failures, ki.attributes);
    if ('@timestamp' in ki) {
      failures.push('@timestamp must not be set on the KI; the write step sets it');
    }
    checkTypeSpecific(failures, ki);
    return failures.length > 0 ? { passed: false, reason: failures.join('\n') } : { passed: true };
  },
});
