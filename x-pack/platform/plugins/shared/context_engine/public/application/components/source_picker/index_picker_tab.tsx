/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EuiComboBox, EuiFormRow, EuiText } from '@elastic/eui';
import type { EuiComboBoxOptionOption } from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import { FormattedMessage } from '@kbn/i18n-react';
import React, { useEffect, useMemo, useState } from 'react';
import type { IndexSuggestionKind } from '../../hooks/use_index_suggestions';
import { useIndexSuggestions } from '../../hooks/use_index_suggestions';

const SEARCH_DEBOUNCE_MS = 250;

const KIND_LABELS: Record<IndexSuggestionKind, string> = {
  index: i18n.translate('xpack.contextEngine.sourcePicker.indices.kind.index', {
    defaultMessage: 'Indices',
  }),
  data_stream: i18n.translate('xpack.contextEngine.sourcePicker.indices.kind.dataStream', {
    defaultMessage: 'Data streams',
  }),
  alias: i18n.translate('xpack.contextEngine.sourcePicker.indices.kind.alias', {
    defaultMessage: 'Aliases',
  }),
};

const KIND_ORDER: IndexSuggestionKind[] = ['data_stream', 'index', 'alias'];

/** Guided picker output: a pattern becomes a plain `FROM` query so downstream code is unchanged. */
export const indexPatternToEsqlSource = (pattern: string): string => `FROM ${pattern.trim()}`;

const isValidPattern = (pattern: string): boolean =>
  pattern.trim().length > 0 && !/[\s|"]/.test(pattern.trim());

interface IndexPickerTabProps {
  onAdd: (query: string) => void;
}

/**
 * Typed-prefix lookup over indices, data streams and aliases. Nothing is fetched until the user
 * types; picking an entry (or a custom wildcard pattern) adds `FROM <pattern>` as a source.
 */
export const IndexPickerTab = ({ onAdd }: IndexPickerTabProps) => {
  const [searchValue, setSearchValue] = useState('');
  const [debouncedPrefix, setDebouncedPrefix] = useState('');

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedPrefix(searchValue), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchValue]);

  const { suggestions, isLoading, isError } = useIndexSuggestions(debouncedPrefix);

  const options = useMemo<Array<EuiComboBoxOptionOption<string>>>(
    () =>
      KIND_ORDER.flatMap((kind) => {
        const entries = suggestions.filter((suggestion) => suggestion.kind === kind);
        if (entries.length === 0) {
          return [];
        }
        return [
          {
            label: KIND_LABELS[kind],
            options: entries.map((entry) => ({ label: entry.name, value: entry.name })),
          },
        ];
      }),
    [suggestions]
  );

  const add = (pattern: string) => {
    if (!isValidPattern(pattern)) {
      return;
    }
    onAdd(indexPatternToEsqlSource(pattern));
    setSearchValue('');
    setDebouncedPrefix('');
  };

  return (
    <div data-test-subj="contextIndexPickerTab">
      <EuiFormRow
        fullWidth
        label={i18n.translate('xpack.contextEngine.sourcePicker.indices.label', {
          defaultMessage: 'Index, data stream or alias',
        })}
        helpText={i18n.translate('xpack.contextEngine.sourcePicker.indices.help', {
          defaultMessage:
            'Start typing to search. Press Enter to add a wildcard pattern such as logs-*.',
        })}
        isInvalid={isError}
        error={
          isError
            ? i18n.translate('xpack.contextEngine.sourcePicker.indices.lookupFailed', {
                defaultMessage: 'Index lookup failed. You can still add a pattern by hand.',
              })
            : undefined
        }
      >
        <EuiComboBox<string>
          isInvalid={isError}
          fullWidth
          async
          singleSelection={{ asPlainText: true }}
          placeholder={i18n.translate('xpack.contextEngine.sourcePicker.indices.placeholder', {
            defaultMessage: 'e.g. logs-nginx or logs-*',
          })}
          options={options}
          selectedOptions={[]}
          isLoading={isLoading}
          onSearchChange={setSearchValue}
          onChange={(selected) => {
            const chosen = selected[0]?.value;
            if (chosen) {
              add(chosen);
            }
          }}
          onCreateOption={(value) => add(value)}
          customOptionText={i18n.translate(
            'xpack.contextEngine.sourcePicker.indices.customOption',
            {
              defaultMessage: 'Add {searchValue} as a pattern',
              // EuiComboBox substitutes its own `{searchValue}` token at render time.
              values: { searchValue: '{searchValue}' },
            }
          )}
          noSuggestions={debouncedPrefix.trim().length === 0}
          data-test-subj="contextIndexPickerCombo"
        />
      </EuiFormRow>
      {debouncedPrefix.trim().length > 0 && !isLoading && suggestions.length === 0 && !isError && (
        <EuiText size="xs" color="subdued" data-test-subj="contextIndexPickerNoMatches">
          <p>
            <FormattedMessage
              id="xpack.contextEngine.sourcePicker.indices.noMatches"
              defaultMessage="No indices match {prefix}. Hidden and system indices are not listed."
              values={{ prefix: <code>{debouncedPrefix.trim()}</code> }}
            />
          </p>
        </EuiText>
      )}
    </div>
  );
};
