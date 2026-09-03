/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { coreMock, loggingSystemMock } from '@kbn/core/server/mocks';
import { createVerifyKiStepDefinition } from './verify_ki_step';
import {
  ESQL_EXECUTES_VERIFIER_ID,
  ESQL_VALID_SYNTAX_VERIFIER_ID,
  SCHEMA_SHAPE_VERIFIER_ID,
} from '../ki_verification';
import { mockKiStepTelemetry } from './test_utils';

type VerifyKiHandler = ReturnType<typeof createVerifyKiStepDefinition>['handler'];
type VerifyKiHandlerContext = Parameters<VerifyKiHandler>[0];

const makeHandlerContext = (
  ki: VerifyKiHandlerContext['input']['ki'],
  getScopedEsClient: () => unknown = jest.fn(),
  executeEsql?: boolean
): VerifyKiHandlerContext =>
  ({
    input: { ki, execute_esql: executeEsql },
    config: {},
    rawInput: { ki, execute_esql: executeEsql },
    contextManager: { getFakeRequest: jest.fn(), getScopedEsClient },
    logger: loggingSystemMock.createLogger(),
    abortSignal: new AbortController().signal,
    stepId: 'verify_ki',
    stepType: 'context-engine.verifyKi',
  } as unknown as VerifyKiHandlerContext);

describe('verify_ki workflow step', () => {
  let coreSetup: ReturnType<typeof coreMock.createSetup>;
  let uiSettingsGet: jest.Mock;
  let telemetry: ReturnType<typeof mockKiStepTelemetry>;

  const setContextEngineEnabled = (isEnabled: boolean) => {
    uiSettingsGet.mockResolvedValue(isEnabled);
  };

  beforeEach(() => {
    coreSetup = coreMock.createSetup();
    const startServices = coreMock.createStart();
    uiSettingsGet = jest.fn();
    startServices.uiSettings.asScopedToClient.mockReturnValue({
      get: uiSettingsGet,
    } as unknown as ReturnType<typeof startServices.uiSettings.asScopedToClient>);
    coreSetup.getStartServices.mockResolvedValue([startServices, {}, undefined]);
    telemetry = mockKiStepTelemetry();
  });

  const makeDefinition = () =>
    createVerifyKiStepDefinition(coreSetup, telemetry.logger, telemetry.analyticsService);

  const runHandler = async (ki: VerifyKiHandlerContext['input']['ki']) => {
    const { output } = await makeDefinition().handler(makeHandlerContext(ki));
    if (!output) {
      throw new Error('step returned no output');
    }
    return output;
  };

  it('passes a KI with valid ES|QL', async () => {
    setContextEngineEnabled(true);

    const output = await runHandler({
      type: 'detection',
      title: 'Failed logins',
      attributes: { esql: 'FROM logs-* | WHERE event.outcome == "failure" | LIMIT 10' },
    });

    expect(output.passed).toBe(true);
    expect(output.results).toEqual([
      { verifier: SCHEMA_SHAPE_VERIFIER_ID, passed: true },
      { verifier: ESQL_VALID_SYNTAX_VERIFIER_ID, passed: true },
    ]);
  });

  it('fails a KI with invalid ES|QL and reports the reason', async () => {
    setContextEngineEnabled(true);

    const output = await runHandler({
      type: 'detection',
      title: 'Broken',
      attributes: { esql: 'FROM logs-* | EVAL x = NOT_A_FUNCTION(1)' },
    });

    expect(output.passed).toBe(false);
    expect(output.results).toEqual([
      { verifier: SCHEMA_SHAPE_VERIFIER_ID, passed: true },
      {
        verifier: ESQL_VALID_SYNTAX_VERIFIER_ID,
        passed: false,
        reason: expect.stringContaining('NOT_A_FUNCTION'),
      },
    ]);
  });

  it('runs only the shape check when no other verifier applies', async () => {
    setContextEngineEnabled(true);

    const output = await runHandler({ type: 'index_metadata', title: 'no esql here' });

    expect(output).toEqual({
      passed: true,
      results: [{ verifier: SCHEMA_SHAPE_VERIFIER_ID, passed: true }],
    });
  });

  it('fails a partial KI that lacks the required fields', async () => {
    setContextEngineEnabled(true);

    const output = await runHandler({ title: 'no type' });

    expect(output.passed).toBe(false);
    expect(output.results).toEqual([
      {
        verifier: SCHEMA_SHAPE_VERIFIER_ID,
        passed: false,
        reason: expect.stringContaining('type is required'),
      },
    ]);
  });

  it('runs the execution check only when execute_esql is set', async () => {
    setContextEngineEnabled(true);
    const esClient = { esql: { query: jest.fn().mockResolvedValue({ columns: [], values: [] }) } };
    const ki = { type: 'detection', title: 'Failed logins', attributes: { esql: 'FROM logs-*' } };

    const { output: withoutFlag } = await makeDefinition().handler(
      makeHandlerContext(ki, () => esClient)
    );
    expect(withoutFlag?.results.map(({ verifier }) => verifier)).not.toContain(
      ESQL_EXECUTES_VERIFIER_ID
    );
    expect(esClient.esql.query).not.toHaveBeenCalled();

    const { output: withFlag } = await makeDefinition().handler(
      makeHandlerContext(ki, () => esClient, true)
    );
    expect(withFlag?.results).toContainEqual({ verifier: ESQL_EXECUTES_VERIFIER_ID, passed: true });
    expect(esClient.esql.query).toHaveBeenCalledWith(
      { query: 'FROM logs-* | LIMIT 0', format: 'json' },
      expect.anything()
    );
  });

  it('throws when the Context Engine setting is off', async () => {
    setContextEngineEnabled(false);

    await expect(
      runHandler({ attributes: { esql: 'FROM logs-* | EVAL x = NOT_A_FUNCTION(1)' } })
    ).rejects.toThrow('Context Engine is disabled');
  });

  describe('input shape repair', () => {
    const asKi = (value: unknown) => value as VerifyKiHandlerContext['input']['ki'];

    it('parses a KI that arrived as a JSON string (rendered with `| json`)', async () => {
      setContextEngineEnabled(true);

      const output = await runHandler(
        asKi(JSON.stringify({ type: 'index_profile', title: 'Burst' }))
      );

      expect(output.passed).toBe(true);
      expect(output.results).toEqual([{ verifier: SCHEMA_SHAPE_VERIFIER_ID, passed: true }]);
    });

    it('fails with the typed-expression hint when ki is a non-JSON string', async () => {
      setContextEngineEnabled(true);

      await expect(runHandler(asKi('[object Object]'))).rejects.toThrow(
        /`ki` arrived as a string .*\$\{\{ steps\.build_ki\.output\.ki \}\}/
      );
    });

    it('fails with a scope hint when ki is undefined', async () => {
      setContextEngineEnabled(true);

      await expect(runHandler(asKi(undefined))).rejects.toThrow(
        /`ki` is undefined.*data\.set.*variables\.<key>/
      );
    });

    it('treats execute_esql rendered as the string "true" as true', async () => {
      setContextEngineEnabled(true);
      const esClient = {
        esql: { query: jest.fn().mockResolvedValue({ columns: [], values: [] }) },
      };
      const ki = { type: 'detection', title: 'Failed logins', attributes: { esql: 'FROM logs-*' } };

      const { output } = await makeDefinition().handler(
        makeHandlerContext(ki, () => esClient, 'true' as unknown as boolean)
      );

      expect(output?.results).toContainEqual({ verifier: ESQL_EXECUTES_VERIFIER_ID, passed: true });
    });
  });

  it('reports a passed verification', async () => {
    setContextEngineEnabled(true);

    await runHandler({
      type: 'detection',
      title: 'Failed logins',
      attributes: { esql: 'FROM logs-* | WHERE event.outcome == "failure" | LIMIT 10' },
    });

    expect(telemetry.analyticsService.reportKiVerification).toHaveBeenCalledTimes(1);
    expect(telemetry.analyticsService.reportKiVerification).toHaveBeenCalledWith({
      outcome: 'success',
      passed: true,
      verifiersRun: 2,
      failedVerifierIds: [],
    });
    expect(telemetry.logger.debug).toHaveBeenCalledTimes(1);
    expect(telemetry.logger.debug).toHaveBeenCalledWith(
      'KI verification passed (verifiers run: 2)'
    );
  });

  it('reports failed verifier ids on failure', async () => {
    setContextEngineEnabled(true);

    await runHandler({
      type: 'detection',
      title: 'Broken',
      attributes: { esql: 'FROM logs-* | EVAL x = NOT_A_FUNCTION(1)' },
    });

    expect(telemetry.analyticsService.reportKiVerification).toHaveBeenCalledTimes(1);
    expect(telemetry.analyticsService.reportKiVerification).toHaveBeenCalledWith({
      outcome: 'success',
      passed: false,
      verifiersRun: 2,
      failedVerifierIds: [ESQL_VALID_SYNTAX_VERIFIER_ID],
    });
  });

  it('logs failing verifier ids on failure', async () => {
    setContextEngineEnabled(true);

    await runHandler({ attributes: { esql: 'FROM logs-* | EVAL x = NOT_A_FUNCTION(1)' } });

    expect(telemetry.logger.debug).toHaveBeenCalledTimes(1);
    const [message] = (telemetry.logger.debug as jest.Mock).mock.calls[0];
    expect(message).toContain(ESQL_VALID_SYNTAX_VERIFIER_ID);
    expect(message).not.toContain('NOT_A_FUNCTION');
  });

  it('reports the shape check alone when no other verifier applied', async () => {
    setContextEngineEnabled(true);

    await runHandler({ type: 'index_metadata', title: 'no esql here' });

    expect(telemetry.analyticsService.reportKiVerification).toHaveBeenCalledWith({
      outcome: 'success',
      passed: true,
      verifiersRun: 1,
      failedVerifierIds: [],
    });
  });

  it('reports an aborted run when cancelled', async () => {
    setContextEngineEnabled(true);
    const abortError = new Error('Request aborted');
    abortError.name = 'AbortError';
    const context = makeHandlerContext({ attributes: { esql: 'FROM logs-*' } }, () => {
      throw abortError;
    });

    await expect(makeDefinition().handler(context)).rejects.toThrow(abortError);

    expect(telemetry.analyticsService.reportKiVerification).toHaveBeenCalledWith({
      outcome: 'aborted',
      errorType: undefined,
    });
    expect(telemetry.logger.debug).toHaveBeenCalledWith('KI verification aborted');
  });

  it('reports a failure when the run errors', async () => {
    setContextEngineEnabled(true);
    const context = makeHandlerContext({ attributes: { esql: 'FROM logs-*' } }, () => {
      throw new TypeError('boom');
    });

    await expect(makeDefinition().handler(context)).rejects.toThrow('boom');

    expect(telemetry.analyticsService.reportKiVerification).toHaveBeenCalledWith({
      outcome: 'failure',
      errorType: 'TypeError',
    });
    expect(telemetry.logger.debug).toHaveBeenCalledWith('KI verification errored: TypeError');
  });

  it('reports no event when the setting is off', async () => {
    setContextEngineEnabled(false);

    await expect(runHandler({ attributes: { esql: 'FROM logs-*' } })).rejects.toThrow();

    expect(telemetry.analyticsService.reportKiVerification).not.toHaveBeenCalled();
  });
});
