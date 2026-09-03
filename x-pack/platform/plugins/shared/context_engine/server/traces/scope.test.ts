/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { errors } from '@elastic/elasticsearch';
import type { DiagnosticResult } from '@elastic/elasticsearch';
import { elasticsearchServiceMock, loggingSystemMock } from '@kbn/core/server/mocks';
import {
  buildAgentListEsql,
  buildCustomScopeCountEsql,
  buildRequestCountEsql,
  buildToolCountEsql,
  listTraceAgents,
  previewTraceScope,
  resolveTimeRange,
} from './scope';

const createEsError = (statusCode: number, type = 'exception', reason = 'boom') =>
  new errors.ResponseError({
    statusCode,
    body: { error: { type, reason } },
    warnings: null,
    headers: {},
    meta: {} as DiagnosticResult['meta'],
  } as DiagnosticResult);

const range = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' };
const tracesIndex = 'traces-agent_builder.otel-default';

// Fixtures mirror the local `traces-agent_builder.otel-default` data stream (12 requests, 5
// conversations, one agent).
const requestCountResult = {
  columns: [{ name: 'requests' }, { name: 'conversations' }],
  values: [[12, ['conv-1', 'conv-2', 'conv-3', 'conv-4', 'conv-5']]],
};
const toolCountResult = {
  columns: [{ name: 'tool_calls' }, { name: 'failed_tool_calls' }],
  values: [[26, 3]],
};

describe('resolveTimeRange', () => {
  it('resolves ISO dates unchanged and rounds date math up for `to`', () => {
    const resolved = resolveTimeRange({ from: range.from, to: 'now/d' });
    expect(resolved.from).toBe(range.from);
    // Rounded up to the end of the current day (in the server's zone), so it ends on .999.
    expect(resolved.to).toMatch(/:59:59\.999Z$/);
    expect(new Date(resolved.to).getTime()).toBeGreaterThan(Date.now());
  });

  it('throws on garbage', () => {
    expect(() => resolveTimeRange({ from: 'now-x', to: 'now' })).toThrow(/Invalid time range/);
  });
});

describe('ES|QL builders', () => {
  it('scopes the request count to invoke_agent CHAIN spans of one agent', () => {
    const query = buildRequestCountEsql(tracesIndex, 'support"agent', range);
    expect(query).toContain(`FROM ${tracesIndex}`);
    expect(query).toContain('attributes.gen_ai.operation.name == "invoke_agent"');
    expect(query).toContain('attributes.elastic.inference.span.kind == "CHAIN"');
    expect(query).toContain('attributes.gen_ai.agent.id == "support\\"agent"');
    expect(query).toContain('VALUES(attributes.gen_ai.conversation.id)');
  });

  it('counts tool spans in the given conversations and their errors', () => {
    const query = buildToolCountEsql(tracesIndex, ['a', 'b'], range);
    expect(query).toContain('attributes.gen_ai.operation.name == "execute_tool"');
    expect(query).toContain('attributes.gen_ai.conversation.id IN ("a", "b")');
    expect(query).toContain('COUNT(CASE(status.code == "Error", 1, NULL))');
  });

  it('lists agents by request count with a bounded LIMIT', () => {
    const query = buildAgentListEsql(tracesIndex, range);
    expect(query).toContain('STATS requests = COUNT(*) BY attributes.gen_ai.agent.id');
    expect(query).toContain('LIMIT 200');
  });

  it('appends one STATS to a custom scope', () => {
    const query = buildCustomScopeCountEsql(`FROM ${tracesIndex} | WHERE true `);
    expect(query.startsWith(`FROM ${tracesIndex} | WHERE true\n| STATS requests`)).toBe(true);
  });
});

describe('listTraceAgents', () => {
  let esClient: ReturnType<typeof elasticsearchServiceMock.createElasticsearchClient>;
  const logger = loggingSystemMock.createLogger();

  beforeEach(() => {
    esClient = elasticsearchServiceMock.createElasticsearchClient();
  });

  it('returns raw ids from terms_enum with a time-range index filter', async () => {
    esClient.termsEnum.mockResolvedValue({ terms: ['elastic-ai-agent', 'ext-agent'] } as never);

    const result = await listTraceAgents({ esClient, spaceId: 'default', range, logger });

    expect(esClient.termsEnum).toHaveBeenCalledWith({
      index: tracesIndex,
      field: 'attributes.gen_ai.agent.id',
      size: 200,
      index_filter: { range: { '@timestamp': { gte: range.from, lte: range.to } } },
    });
    expect(result).toEqual({
      agents: [{ agent_id: 'elastic-ai-agent' }, { agent_id: 'ext-agent' }],
      method: 'terms_enum',
      traces_index: tracesIndex,
    });
    expect(esClient.esql.query).not.toHaveBeenCalled();
  });

  it('returns an empty list when the traces index does not exist', async () => {
    esClient.termsEnum.mockRejectedValue(createEsError(404));

    await expect(listTraceAgents({ esClient, spaceId: 'other', range, logger })).resolves.toEqual({
      agents: [],
      method: 'terms_enum',
      traces_index: 'traces-agent_builder.otel-other',
    });
  });

  it('falls back to the ES|QL aggregation when terms_enum is rejected', async () => {
    esClient.termsEnum.mockRejectedValue(createEsError(400, 'illegal_argument_exception'));
    esClient.esql.query.mockResolvedValue({
      columns: [{ name: 'requests' }, { name: 'attributes.gen_ai.agent.id' }],
      values: [
        [12, 'elastic-ai-agent'],
        [3, 'ext-agent'],
      ],
    } as never);

    const result = await listTraceAgents({ esClient, spaceId: 'default', range, logger });

    expect(result).toEqual({
      agents: [
        { agent_id: 'elastic-ai-agent', requests: 12 },
        { agent_id: 'ext-agent', requests: 3 },
      ],
      method: 'esql',
      traces_index: tracesIndex,
    });
  });
});

describe('previewTraceScope', () => {
  let esClient: ReturnType<typeof elasticsearchServiceMock.createElasticsearchClient>;

  beforeEach(() => {
    esClient = elasticsearchServiceMock.createElasticsearchClient();
  });

  it('runs the two-step agent query and returns the counts', async () => {
    esClient.esql.query
      .mockResolvedValueOnce(requestCountResult as never)
      .mockResolvedValueOnce(toolCountResult as never);

    const result = await previewTraceScope({
      esClient,
      spaceId: 'default',
      range,
      agentId: 'elastic-ai-agent',
    });

    expect(result).toEqual({
      traces_index: tracesIndex,
      requests: 12,
      conversations: 5,
      tool_calls: 26,
      failed_tool_calls: 3,
    });
    const secondQuery = (esClient.esql.query.mock.calls[1][0] as { query: string }).query;
    expect(secondQuery).toContain('IN ("conv-1", "conv-2", "conv-3", "conv-4", "conv-5")');
  });

  it('skips the tool query when the agent has no requests in range', async () => {
    esClient.esql.query.mockResolvedValueOnce({
      columns: [{ name: 'requests' }, { name: 'conversations' }],
      values: [[0, null]],
    } as never);

    const result = await previewTraceScope({
      esClient,
      spaceId: 'default',
      range,
      agentId: 'idle-agent',
    });

    expect(result).toMatchObject({ requests: 0, conversations: 0, tool_calls: 0 });
    expect(esClient.esql.query).toHaveBeenCalledTimes(1);
  });

  it('returns zero counts when the traces index is missing', async () => {
    esClient.esql.query.mockRejectedValue(createEsError(404, 'index_not_found_exception'));

    await expect(
      previewTraceScope({ esClient, spaceId: 'default', range, agentId: 'a' })
    ).resolves.toMatchObject({ requests: 0, tool_calls: 0 });
  });

  it('validates a custom ES|QL scope and reports its errors instead of counting', async () => {
    const result = await previewTraceScope({
      esClient,
      spaceId: 'default',
      range,
      esql: 'FROM traces | WHERE',
    });

    expect(result.requests).toBe(0);
    expect(result.errors?.[0]).toMatchObject({ type: 'static' });
  });

  it('counts a valid custom ES|QL scope with a single STATS', async () => {
    esClient.esql.query
      // LIMIT 0 validation run
      .mockResolvedValueOnce({ columns: [], values: [] } as never)
      .mockResolvedValueOnce({
        columns: [
          { name: 'requests' },
          { name: 'conversations' },
          { name: 'tool_calls' },
          { name: 'failed_tool_calls' },
        ],
        values: [[12, 5, 26, 0]],
      } as never);

    const result = await previewTraceScope({
      esClient,
      spaceId: 'default',
      range,
      esql: `FROM ${tracesIndex} | WHERE attributes.gen_ai.agent.id == "elastic-ai-agent"`,
    });

    expect(result).toEqual({
      traces_index: tracesIndex,
      requests: 12,
      conversations: 5,
      tool_calls: 26,
      failed_tool_calls: 0,
    });
  });
});
