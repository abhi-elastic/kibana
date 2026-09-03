/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createKiVerifierRegistry } from './create_registry';
import {
  ESQL_EXECUTES_VERIFIER_ID,
  ESQL_VALID_SYNTAX_VERIFIER_ID,
  INDEX_EXISTS_VERIFIER_ID,
  PROVENANCE_PRESENT_VERIFIER_ID,
  SCHEMA_SHAPE_VERIFIER_ID,
} from './verifiers';

describe('createKiVerifierRegistry', () => {
  it('registers the built-in verifiers, cheapest first', () => {
    const registry = createKiVerifierRegistry();
    expect(registry.getAll().map(({ id }) => id)).toEqual([
      SCHEMA_SHAPE_VERIFIER_ID,
      PROVENANCE_PRESENT_VERIFIER_ID,
      ESQL_VALID_SYNTAX_VERIFIER_ID,
      INDEX_EXISTS_VERIFIER_ID,
      ESQL_EXECUTES_VERIFIER_ID,
    ]);
  });
});
