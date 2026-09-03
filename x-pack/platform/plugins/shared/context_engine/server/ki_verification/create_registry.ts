/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { KiVerifierRegistry } from './registry';
import {
  createEsqlExecutesVerifier,
  createEsqlValidSyntaxVerifier,
  createIndexExistsVerifier,
  createProvenancePresentVerifier,
  createSchemaShapeVerifier,
} from './verifiers';

/**
 * Creates a registry with all built-in KI verifiers registered, cheapest first: shape and
 * provenance are pure, the syntax check parses, the index and execution checks call the cluster.
 */
export const createKiVerifierRegistry = (): KiVerifierRegistry => {
  const registry = new KiVerifierRegistry();
  registry.register(createSchemaShapeVerifier());
  registry.register(createProvenancePresentVerifier());
  registry.register(createEsqlValidSyntaxVerifier());
  registry.register(createIndexExistsVerifier());
  registry.register(createEsqlExecutesVerifier());
  return registry;
};
