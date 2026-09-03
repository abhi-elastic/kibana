/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  buildDetailSearch,
  buildRequestCountQuery,
  buildRequestSampleQuery,
  buildToolArgumentsSearch,
  buildToolRepeatsQuery,
  escapeEsqlString,
  resolveTracesIndex,
  type TraceScopeSelector,
} from './queries';

const agentScope: TraceScopeSelector = {
  kind: 'agent',
  tracesIndex: 'traces-agent_builder.otel-default',
  agentId: 'support-agent',
  range: { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z' },
};

describe('scope queries', () => {
  it('scopes the request count by agent, range and the CHAIN invoke_agent span', () => {
    const query = buildRequestCountQuery(agentScope);
    expect(query).toContain('FROM traces-agent_builder.otel-default');
    expect(query).toContain('attributes.gen_ai.agent.id == "support-agent"');
    expect(query).toContain('@timestamp >= "2026-08-01T00:00:00Z"');
    expect(query).toContain('attributes.gen_ai.operation.name == "invoke_agent"');
    expect(query).toContain('attributes.elastic.inference.span.kind == "CHAIN"');
    expect(query).toContain('STATS n = COUNT(*)');
  });

  it('uses a custom ES|QL scope verbatim', () => {
    const query = buildRequestCountQuery({
      kind: 'custom',
      esql: 'FROM traces-custom | WHERE attributes.user.hash == "abc"',
    });
    expect(query.startsWith('FROM traces-custom | WHERE attributes.user.hash == "abc"')).toBe(true);
    expect(resolveTracesIndex({ kind: 'custom', esql: 'FROM x' }, 'fallback')).toBe('fallback');
    expect(resolveTracesIndex(agentScope, 'fallback')).toBe(agentScope.tracesIndex);
  });

  it('escapes quotes in the agent id', () => {
    expect(escapeEsqlString('a"b\\c')).toBe('a\\"b\\\\c');
    expect(buildRequestCountQuery({ ...agentScope, agentId: 'x"y' })).toContain('== "x\\"y"');
  });
});

describe('buildRequestSampleQuery', () => {
  it('takes every request when the scope fits under the cap', () => {
    const query = buildRequestSampleQuery(agentScope, { totalRequests: 800, cap: 1000 });
    expect(query).not.toContain('SAMPLE');
    expect(query).toContain('KEEP trace_id, attributes.gen_ai.conversation.id, duration');
    expect(query).toContain('LIMIT 1000');
  });

  it('samples at request level above the cap, over-sampling slightly', () => {
    const query = buildRequestSampleQuery(agentScope, { totalRequests: 4000, cap: 1000 });
    expect(query).toContain('| SAMPLE 0.275000');
    expect(query).toContain('LIMIT 1000');
  });

  it('never exceeds probability 1', () => {
    expect(buildRequestSampleQuery(agentScope, { totalRequests: 1050, cap: 1000 })).toContain(
      '| SAMPLE 1.000000'
    );
  });
});

describe('sampled queries', () => {
  it('scope every later query by the sampled trace ids', () => {
    const query = buildToolRepeatsQuery('traces-x', ['t1', 't2'], {
      toolName: 'platform.core.execute_esql',
      threshold: 3.5,
    });
    expect(query).toContain('WHERE trace_id IN ("t1", "t2")');
    expect(query).toContain('attributes.gen_ai.tool.name == "platform.core.execute_esql"');
    expect(query).toContain('WHERE calls > 3.5 AND calls >= 2');
  });
});

describe('_search bodies', () => {
  it('bounds the detail fetch to the given ids and span kinds, oldest first', () => {
    const body = buildDetailSearch('traces-x', ['t1'], { size: 500 });
    expect(body).toMatchObject({
      index: 'traces-x',
      size: 500,
      sort: [{ '@timestamp': 'asc' }],
    });
    expect(body.query.bool.filter).toEqual([
      { terms: { trace_id: ['t1'] } },
      { terms: { 'attributes.gen_ai.operation.name': ['execute_tool', 'chat'] } },
    ]);
    expect(body._source).toContain('attributes.gen_ai.tool.call.result');
    expect(body._source).toContain('attributes.gen_ai.output.messages');
  });

  it('reads only tool arguments for T13, most recent first', () => {
    const body = buildToolArgumentsSearch('traces-x', ['t1', 't2'], { size: 2000 });
    expect(body.sort).toEqual([{ '@timestamp': 'desc' }]);
    expect(body._source).toEqual([
      'trace_id',
      'attributes.gen_ai.tool.name',
      'attributes.gen_ai.tool.call.arguments',
    ]);
    expect(body.query.bool.filter[1]).toEqual({
      term: { 'attributes.gen_ai.operation.name': 'execute_tool' },
    });
  });
});
