/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Configuration schema for the Langfuse exporter.
 */
export interface InferenceTracingLangfuseExportConfig {
  /**
   * The URL for Langfuse server and Langfuse UI.
   */
  base_url: string;
  /**
   * The public key for API requests to Langfuse server.
   */
  public_key: string;
  /**
   * The secret key for API requests to Langfuse server.
   */
  secret_key: string;
  /**
   * The delay in milliseconds before the exporter sends another
   * batch of spans.
   */
  scheduled_delay: number;
}

/**
 * Configuration schema for the Phoenix exporter.
 */
export interface InferenceTracingPhoenixExportConfig {
  /**
   * The URL for Phoenix server.
   */
  base_url: string;
  /**
   * The URL for Phoenix UI.
   */
  public_url?: string;
  /**
   * The project in which traces are stored. Used for
   * generating links to Phoenix UI.
   */
  project_name?: string;
  /**
   * The API key for API requests to Phoenix server.
   */
  api_key?: string;
  /**
   * The delay in milliseconds before the exporter sends another
   * batch of spans.
   */
  scheduled_delay: number;
}

/**
 * Configuration schema for the Opik exporter (Comet Opik Cloud).
 */
export interface InferenceTracingOpikExportConfig {
  /**
   * The API key for Comet Opik Cloud.
   */
  api_key: string;
  /**
   * The Comet workspace name.
   */
  workspace_name: string;
  /**
   * The project name in Opik.
   */
  project_name: string;
  /**
   * The delay in milliseconds before the exporter sends another
   * batch of spans.
   */
  scheduled_delay: number;
}

/**
 * Configuration schema for the MLflow exporter.
 */
export interface InferenceTracingMlflowExportConfig {
  /**
   * The MLflow tracking server URL (e.g. http://localhost:5000).
   */
  tracking_uri: string;
  /**
   * The MLflow experiment ID. Required by the OTLP endpoint
   * via the `x-mlflow-experiment-id` header.
   */
  experiment_id: string;
  /**
   * Optional experiment name, used for trace URL logging.
   */
  experiment_name?: string;
  /**
   * The delay in milliseconds before the exporter sends another
   * batch of spans.
   */
  scheduled_delay: number;
}

/**
 * Configuration schema for inference tracing exporters.
 *
 * @internal
 */
export type InferenceTracingExportConfig =
  | { langfuse: InferenceTracingLangfuseExportConfig }
  | { phoenix: InferenceTracingPhoenixExportConfig }
  | { opik: InferenceTracingOpikExportConfig }
  | { mlflow: InferenceTracingMlflowExportConfig };
