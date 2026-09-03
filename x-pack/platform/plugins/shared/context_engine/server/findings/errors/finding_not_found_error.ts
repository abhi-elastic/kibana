/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export class FindingNotFoundError extends Error {
  constructor(findingIds: string[]) {
    super(`Finding(s) not found: ${findingIds.join(', ')}`);
    this.name = 'FindingNotFoundError';
  }
}
