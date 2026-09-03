/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  argumentDigest,
  assistantOutput,
  buildPrevalence,
  computeThreshold,
  errorClass,
  firstUserMessage,
  hasPartialError,
  isEmptyRetrieval,
  isSoftFailure,
  isUnsupportedOperation,
  median,
  parseTargetIndices,
  passesPrevalenceGate,
  percentile,
  sampleBand,
  toolSignature,
} from './analysis';

describe('sampleBand', () => {
  it('maps request counts to the three bands', () => {
    expect(sampleBand(0)).toBe('insufficient');
    expect(sampleBand(9)).toBe('insufficient');
    expect(sampleBand(10)).toBe('limited');
    expect(sampleBand(29)).toBe('limited');
    expect(sampleBand(30)).toBe('full');
  });
});

describe('computeThreshold', () => {
  const baseline = { n: 40, med: 2, mad: 1, pN: 7, mean: 2.5, sd: 1.5 };

  it('uses the percentile when it is the largest rule in the full band', () => {
    expect(computeThreshold(baseline, { madMultiplier: 3 })).toEqual({
      threshold: 7,
      rule: 'percentile',
      mean_plus_2sd: 5.5,
      band: 'full',
    });
  });

  it('ignores the percentile in the limited band', () => {
    expect(computeThreshold({ ...baseline, n: 12 }, { madMultiplier: 3 })).toMatchObject({
      threshold: 5,
      rule: 'mad',
      band: 'limited',
    });
  });

  it('falls back to med + 2 when MAD is zero', () => {
    expect(
      computeThreshold({ n: 12, med: 1, mad: 0, pN: 1, mean: 1.1, sd: 0.3 }, { madMultiplier: 3 })
    ).toMatchObject({ threshold: 3, rule: 'median_plus_2' });
  });

  it('honours the MAD multiplier override', () => {
    expect(computeThreshold({ ...baseline, n: 12 }, { madMultiplier: 5 })).toMatchObject({
      threshold: 7,
      rule: 'mad',
    });
  });
});

describe('prevalence gate', () => {
  it('requires max(3, 5%) requests and 2 conversations by default', () => {
    expect(passesPrevalenceGate(buildPrevalence(3, 20, 2))).toBe(true);
    expect(passesPrevalenceGate(buildPrevalence(2, 20, 2))).toBe(false);
    expect(passesPrevalenceGate(buildPrevalence(3, 20, 1))).toBe(false);
    // 5% of 200 = 10 outranks the floor of 3.
    expect(passesPrevalenceGate(buildPrevalence(9, 200, 5))).toBe(false);
    expect(passesPrevalenceGate(buildPrevalence(10, 200, 5))).toBe(true);
  });

  it('honours custom floors', () => {
    expect(
      passesPrevalenceGate(buildPrevalence(1, 20, 1), {
        minRequests: 1,
        minFraction: 0,
        minConversations: 1,
      })
    ).toBe(true);
  });

  it('rounds the fraction and guards a zero sample', () => {
    expect(buildPrevalence(1, 3, 1).affected_fraction).toBe(0.3333);
    expect(buildPrevalence(0, 0, 0).affected_fraction).toBe(0);
  });
});

describe('errorClass', () => {
  it('collapses ids, numbers and quoted values into one class', () => {
    expect(errorClass('Unknown column [field_1] in line 3:7')).toBe(
      errorClass('Unknown column [other_field] in line 12:1')
    );
    expect(errorClass('index "logs-2024.01.01" not found')).toBe(
      errorClass('index "logs-2024.02.02" not found')
    );
    expect(errorClass(undefined)).toBe('unknown_error');
  });
});

describe('isUnsupportedOperation', () => {
  it('matches known ES|QL limitations', () => {
    expect(isUnsupportedOperation('verification_exception: Unknown column [foo]')).toBe(true);
    expect(isUnsupportedOperation('field [tags] of type [text] is not aggregatable')).toBe(true);
    expect(isUnsupportedOperation('Unknown function [PIVOT]')).toBe(true);
    expect(isUnsupportedOperation('connect ECONNREFUSED')).toBe(false);
    expect(isUnsupportedOperation(null)).toBe(false);
  });
});

describe('content matchers', () => {
  it('detects soft failures from the phrase list', () => {
    expect(isSoftFailure("I couldn't find any records matching that host.")).toBe(true);
    expect(isSoftFailure('I was unable to retrieve the data.')).toBe(true);
    expect(isSoftFailure('No results were found for that query.')).toBe(true);
    expect(isSoftFailure('Here are the top 5 hosts by error rate.')).toBe(false);
  });

  it('detects partial errors and empty retrievals in tool results', () => {
    expect(hasPartialError('[{"type":"error","message":"boom"},{"type":"esql_results"}]')).toBe(
      true
    );
    expect(hasPartialError('{"type":"esql_results","values":[]}')).toBe(false);
    expect(isEmptyRetrieval('{"type":"esql_results","columns":[],"values":[]}')).toBe(true);
    expect(isEmptyRetrieval('{"type":"esql_results","values":[[1]]}')).toBe(false);
    expect(isEmptyRetrieval('[{"type":"error"}]')).toBe(false);
  });
});

describe('parseTargetIndices', () => {
  it('reads FROM targets out of an ES|QL query argument', () => {
    expect(
      parseTargetIndices(
        JSON.stringify({ query: 'FROM logs-app, metrics-* METADATA _id | WHERE host == "a"' })
      )
    ).toEqual(['logs-app', 'metrics-*']);
  });

  it('reads index arguments and de-duplicates', () => {
    expect(
      parseTargetIndices(JSON.stringify({ index: 'raw-cases', query: 'FROM raw-cases | LIMIT 5' }))
    ).toEqual(['raw-cases']);
    expect(parseTargetIndices(JSON.stringify({ indices: ['a', 'b,c'] }))).toEqual(['a', 'b', 'c']);
  });

  it('handles non-JSON and empty input', () => {
    expect(parseTargetIndices('FROM plain-index | LIMIT 1')).toEqual(['plain-index']);
    expect(parseTargetIndices('')).toEqual([]);
    expect(parseTargetIndices(undefined)).toEqual([]);
  });
});

describe('argumentDigest', () => {
  it('summarises tool, targets and filter fields', () => {
    expect(
      argumentDigest(
        'platform.core.execute_esql',
        JSON.stringify({ query: 'FROM logs-app | WHERE host.name == "x" AND status >= 500' })
      )
    ).toBe('platform.core.execute_esql targets=logs-app filters=host.name');
    expect(argumentDigest('search', undefined)).toBe('search');
  });
});

describe('message parsing', () => {
  const input = JSON.stringify([
    { role: 'system', parts: [{ type: 'text', content: 'You are helpful.' }] },
    { role: 'user', parts: [{ type: 'text', content: 'Which hosts failed?' }] },
  ]);
  const output = JSON.stringify([
    {
      role: 'assistant',
      parts: [{ type: 'text', content: 'I was unable to find failing hosts.' }],
      finish_reason: 'stop',
    },
  ]);

  it('extracts the first user message and the assistant output', () => {
    expect(firstUserMessage(input)).toBe('Which hosts failed?');
    expect(assistantOutput(output)).toEqual({
      text: 'I was unable to find failing hosts.',
      finishReason: 'stop',
    });
    expect(firstUserMessage('not json')).toBeUndefined();
    expect(assistantOutput(undefined)).toEqual({ text: undefined, finishReason: undefined });
  });
});

describe('numeric helpers', () => {
  it('computes signatures, percentiles and medians', () => {
    expect(toolSignature(['b', 'a', 'b'])).toBe('a,b');
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 95)).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
