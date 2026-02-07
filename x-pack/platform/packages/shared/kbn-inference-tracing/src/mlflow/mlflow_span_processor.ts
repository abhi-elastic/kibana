/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { tracing } from '@elastic/opentelemetry-node/sdk';
import type { InferenceTracingMlflowExportConfig } from '@kbn/inference-tracing-config';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { omit, partition } from 'lodash';
import { diag } from '@opentelemetry/api';
import { BaseInferenceSpanProcessor } from '../base_inference_span_processor';
import { ElasticGenAIAttributes } from '../types';
import { unflattenAttributes } from '../util/unflatten_attributes';

export class MlflowSpanProcessor extends BaseInferenceSpanProcessor {
  constructor(private readonly config: InferenceTracingMlflowExportConfig) {
    const trackingUri = config.tracking_uri.replace(/\/+$/, '');

    const exporter = new OTLPTraceExporter({
      url: `${trackingUri}/v1/traces`,
      headers: {
        'x-mlflow-experiment-id': config.experiment_id,
      },
    });

    super(exporter, config.scheduled_delay);
  }

  override processInferenceSpan(span: tracing.ReadableSpan): tracing.ReadableSpan {
    const operationName = span.attributes['gen_ai.operation.name'];

    if (operationName === 'chat') {
      const [inputEvents, outputEvents] = partition(
        span.events,
        (event) => event.name !== 'gen_ai.choice'
      );

      span.attributes['input.value'] = JSON.stringify(
        inputEvents.map((event) => {
          return unflattenAttributes(event.attributes ?? {});
        })
      );

      span.attributes['output.value'] = JSON.stringify(
        outputEvents.map((event) => {
          const { message, ...rest } = unflattenAttributes(event.attributes ?? {});
          return {
            ...omit(rest, 'finish_reason', 'index'),
            ...message,
          };
        })[0]
      );
    } else if (operationName === 'execute_tool') {
      span.attributes['input.value'] =
        span.attributes[ElasticGenAIAttributes.ToolParameters] ?? '';
      span.attributes['output.value'] = span.attributes['output.value'] ?? '';
    }

    if (!span.parentSpanContext) {
      const trackingUri = this.config.tracking_uri.replace(/\/+$/, '');
      const experimentId = encodeURIComponent(this.config.experiment_id);
      const url = `${trackingUri}/#/experiments/${experimentId}`;
      diag.info(`View trace at ${url}`);
    }

    return span;
  }
}
