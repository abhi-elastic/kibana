/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { tracing } from '@elastic/opentelemetry-node/sdk';
import { diag } from '@opentelemetry/api';
import type { InferenceTracingMlflowExportConfig } from '@kbn/inference-tracing-config';
import { MlflowSpanProcessor } from './mlflow_span_processor';

// Mock OTLPTraceExporter so it does not open any connection
jest.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: jest.fn().mockImplementation(() => ({
    export: jest.fn(),
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Mock the base class to avoid real batching
jest.mock('../base_inference_span_processor', () => {
  return {
    BaseInferenceSpanProcessor: class {
      constructor(_exporter: unknown, _scheduledDelay: number) {}
      processInferenceSpan(span: tracing.ReadableSpan): tracing.ReadableSpan {
        return span;
      }
    },
  };
});

const { OTLPTraceExporter } = jest.requireMock('@opentelemetry/exporter-trace-otlp-proto');

const createConfig = (
  overrides: Partial<InferenceTracingMlflowExportConfig> = {}
): InferenceTracingMlflowExportConfig => ({
  tracking_uri: 'http://localhost:5000',
  experiment_id: '42',
  scheduled_delay: 1000,
  ...overrides,
});

const createMockSpan = (
  overrides: Partial<{
    attributes: Record<string, unknown>;
    events: Array<{ name: string; attributes?: Record<string, unknown> }>;
    parentSpanContext: unknown;
    spanContext: () => { traceId: string };
  }> = {}
): tracing.ReadableSpan =>
  ({
    attributes: {},
    events: [],
    parentSpanContext: { traceId: 'parent-trace-id' },
    spanContext: () => ({ traceId: 'abc123def456' }),
    ...overrides,
  } as unknown as tracing.ReadableSpan);

describe('MlflowSpanProcessor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates an OTLPTraceExporter with the correct URL and headers', () => {
      const config = createConfig();
      new MlflowSpanProcessor(config);

      expect(OTLPTraceExporter).toHaveBeenCalledWith({
        url: 'http://localhost:5000/v1/traces',
        headers: {
          'x-mlflow-experiment-id': '42',
        },
      });
    });

    it('strips trailing slashes from tracking_uri', () => {
      const config = createConfig({ tracking_uri: 'http://localhost:5000/' });
      new MlflowSpanProcessor(config);

      expect(OTLPTraceExporter).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'http://localhost:5000/v1/traces',
        })
      );
    });
  });

  describe('processInferenceSpan', () => {
    describe('chat spans', () => {
      it('sets input.value from non-choice events and output.value from choice events', () => {
        const processor = new MlflowSpanProcessor(createConfig());
        const span = createMockSpan({
          attributes: { 'gen_ai.operation.name': 'chat' },
          events: [
            {
              name: 'gen_ai.user.message',
              attributes: { 'gen_ai.system': 'openai', role: 'user', content: 'Hello' },
            },
            {
              name: 'gen_ai.choice',
              attributes: {
                index: 0,
                finish_reason: 'stop',
                'message.role': 'assistant',
                'message.content': 'Hi there!',
              },
            },
          ],
        });

        const result = processor.processInferenceSpan(span);

        expect(result.attributes['input.value']).toBeDefined();
        expect(result.attributes['output.value']).toBeDefined();

        const input = JSON.parse(result.attributes['input.value'] as string);
        expect(input).toHaveLength(1);
        expect(input[0]).toMatchObject({ role: 'user', content: 'Hello' });

        const output = JSON.parse(result.attributes['output.value'] as string);
        expect(output).toMatchObject({ role: 'assistant', content: 'Hi there!' });
      });
    });

    describe('tool execution spans', () => {
      it('sets input.value from tool parameters and output.value', () => {
        const processor = new MlflowSpanProcessor(createConfig());
        const span = createMockSpan({
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'elastic.tool.parameters': '{"query": "test"}',
            'output.value': '{"result": "found"}',
          },
        });

        const result = processor.processInferenceSpan(span);

        expect(result.attributes['input.value']).toBe('{"query": "test"}');
        expect(result.attributes['output.value']).toBe('{"result": "found"}');
      });

      it('defaults output.value to empty string when missing', () => {
        const processor = new MlflowSpanProcessor(createConfig());
        const span = createMockSpan({
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'elastic.tool.parameters': '{"query": "test"}',
          },
        });

        const result = processor.processInferenceSpan(span);

        expect(result.attributes['input.value']).toBe('{"query": "test"}');
        expect(result.attributes['output.value']).toBe('');
      });
    });

    describe('trace URL logging', () => {
      it('logs a trace URL for root spans (no parent)', () => {
        const infoSpy = jest.spyOn(diag, 'info');
        const processor = new MlflowSpanProcessor(createConfig());
        const span = createMockSpan({
          parentSpanContext: undefined,
        });

        processor.processInferenceSpan(span);

        expect(infoSpy).toHaveBeenCalledWith(
          'View trace at http://localhost:5000/#/experiments/42'
        );
      });

      it('does not log a trace URL for child spans', () => {
        const infoSpy = jest.spyOn(diag, 'info');
        const processor = new MlflowSpanProcessor(createConfig());
        const span = createMockSpan({
          parentSpanContext: { traceId: 'parent-trace' },
        });

        processor.processInferenceSpan(span);

        expect(infoSpy).not.toHaveBeenCalled();
      });

      it('encodes the experiment_id in the URL', () => {
        const infoSpy = jest.spyOn(diag, 'info');
        const processor = new MlflowSpanProcessor(
          createConfig({ experiment_id: 'my experiment' })
        );
        const span = createMockSpan({ parentSpanContext: undefined });

        processor.processInferenceSpan(span);

        expect(infoSpy).toHaveBeenCalledWith(
          'View trace at http://localhost:5000/#/experiments/my%20experiment'
        );
      });
    });
  });
});
