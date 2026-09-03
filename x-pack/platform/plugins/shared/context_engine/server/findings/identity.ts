/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash } from 'crypto';
import type { FindingKind } from '../../common/http_api/findings';

/** 128 bits of SHA-256, hex-encoded; same width as improvement ids. */
const FINDING_ID_LENGTH = 32;

/** Case- and whitespace-insensitive so agent rewording of the subject does not fork a lineage. */
const normalizeSubject = (subject: string): string =>
  subject.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Stable identity of a finding: `hash(ai_index_id + kind + subject)`. The title and summary are
 * deliberately excluded because the agent rewords them between runs.
 */
export const buildFindingId = ({
  aiIndexId,
  kind,
  subject,
}: {
  aiIndexId: string;
  kind: FindingKind;
  subject: string;
}): string =>
  createHash('sha256')
    .update(`${aiIndexId}\u0000${kind}\u0000${normalizeSubject(subject)}`)
    .digest('hex')
    .slice(0, FINDING_ID_LENGTH);
