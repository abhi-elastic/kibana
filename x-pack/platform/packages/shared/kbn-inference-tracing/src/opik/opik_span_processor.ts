/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { tracing } from '@elastic/opentelemetry-node/sdk';
import type { InferenceTracingOpikExportConfig } from '@kbn/inference-tracing-config';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { omit, partition } from 'lodash';
import { diag } from '@opentelemetry/api';
import { BaseInferenceSpanProcessor } from '../base_inference_span_processor';
import { ElasticGenAIAttributes } from '../types';
import { unflattenAttributes } from '../util/unflatten_attributes';

const OPIK_CLOUD_BASE_URL = 'https://www.comet.com/opik';

export class OpikSpanProcessor extends BaseInferenceSpanProcessor {
  constructor(private readonly config: InferenceTracingOpikExportConfig) {
    const headers = {
      Authorization: config.api_key,
      projectName: config.project_name,
      'Comet-Workspace': config.workspace_name,
    };

    const exporter = new OTLPTraceExporter({
      url: `${OPIK_CLOUD_BASE_URL}/api/v1/private/otel/v1/traces`,
      headers,
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
      const traceId = span.spanContext().traceId;
      const url = `${OPIK_CLOUD_BASE_URL}/${encodeURIComponent(this.config.workspace_name)}/redirect/traces?traceId=${traceId}`;
      diag.info(`View trace at ${url}`);
    }

    return span;
  }
}
