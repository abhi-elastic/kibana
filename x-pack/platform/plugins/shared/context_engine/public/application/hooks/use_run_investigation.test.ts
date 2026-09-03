/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { INITIAL_INVESTIGATION_STATUS, investigationStatusReducer } from './use_run_investigation';

describe('investigationStatusReducer', () => {
  it('advances the stage and records the investigation id', () => {
    const status = investigationStatusReducer(INITIAL_INVESTIGATION_STATUS, {
      type: 'stage',
      stage: 'findings_recorded',
      investigationId: 'inv-1',
    });

    expect(status).toEqual({
      stage: 'findings_recorded',
      investigationId: 'inv-1',
      savedWorkflowIds: [],
    });
  });

  it('never moves the stage backwards within a run', () => {
    const planned = investigationStatusReducer(INITIAL_INVESTIGATION_STATUS, {
      type: 'stage',
      stage: 'planned',
      investigationId: 'inv-1',
    });
    const replayed = investigationStatusReducer(planned, {
      type: 'stage',
      stage: 'findings_recorded',
    });

    expect(replayed.stage).toBe('planned');
    expect(replayed.investigationId).toBe('inv-1');
  });

  it('marks generated and dedupes saved workflow ids on automation_saved', () => {
    const once = investigationStatusReducer(INITIAL_INVESTIGATION_STATUS, {
      type: 'automation_saved',
      workflowId: 'wf-1',
    });
    const twice = investigationStatusReducer(once, {
      type: 'automation_saved',
      workflowId: 'wf-1',
    });
    const another = investigationStatusReducer(twice, {
      type: 'automation_saved',
      workflowId: 'wf-2',
    });

    expect(once.stage).toBe('generated');
    expect(twice.savedWorkflowIds).toEqual(['wf-1']);
    expect(another.savedWorkflowIds).toEqual(['wf-1', 'wf-2']);
  });
});
