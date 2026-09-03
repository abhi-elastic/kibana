/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  EuiButton,
  EuiCallOut,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiSpacer,
} from '@elastic/eui';
import type { AggregateQuery } from '@kbn/es-query';
import { ESQLLangEditor } from '@kbn/esql/public';
import { i18n } from '@kbn/i18n';
import { FormattedMessage } from '@kbn/i18n-react';
import React, { useEffect, useRef, useState } from 'react';
import type { EsqlSourceValidationError } from '../../../../common/http_api/investigation_scope';
import { validateEsqlSource } from '../../api/investigation_scope';
import { useKibana } from '../../hooks/use_kibana';

interface EsqlTabProps {
  onAdd: (query: string) => void;
}

// Reserved up front so the Add button does not jump while ESQLLangEditor mounts.
const EDITOR_INLINE_MIN_HEIGHT = 180;

const getEsqlQuery = (query: AggregateQuery): string => ('esql' in query ? query.esql : '');

const formatValidationError = (error: EsqlSourceValidationError): string =>
  error.position
    ? i18n.translate('xpack.contextEngine.sourcePicker.esql.errorWithPosition', {
        defaultMessage: '{message} (at {position})',
        values: { message: error.message, position: error.position.min },
      })
    : error.message;

/**
 * Lets the user author a raw ES|QL query in the shared ES|QL editor and add it as a source. The
 * query is validated server-side (parser + `LIMIT 0` execution as the current user) before it is
 * added; only a query passing both layers reaches `sources[]`.
 */
export const EsqlTab = ({ onAdd }: EsqlTabProps) => {
  const {
    services: { http },
  } = useKibana();
  const [query, setQuery] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [errors, setErrors] = useState<EsqlSourceValidationError[]>([]);
  const trimmedQuery = query.trim();
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => abortRef.current?.abort(), []);

  const handleQueryChange = (next: AggregateQuery) => {
    setQuery(getEsqlQuery(next));
    if (errors.length > 0) {
      setErrors([]);
    }
  };

  const handleAdd = async () => {
    if (!trimmedQuery || isValidating) {
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsValidating(true);
    setErrors([]);
    try {
      const result = await validateEsqlSource(http, {
        esql: trimmedQuery,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        return;
      }
      if (!result.valid) {
        setErrors(result.errors);
        return;
      }
      onAdd(trimmedQuery);
      setQuery('');
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      setErrors([
        {
          type: 'request_failed',
          message:
            error instanceof Error
              ? error.message
              : i18n.translate('xpack.contextEngine.sourcePicker.esql.validationFailed', {
                  defaultMessage: 'Validation request failed',
                }),
        },
      ]);
    } finally {
      if (!controller.signal.aborted) {
        setIsValidating(false);
      }
    }
  };

  return (
    <div data-test-subj="contextEsqlTab">
      <EuiFormRow fullWidth>
        <div css={{ minHeight: EDITOR_INLINE_MIN_HEIGHT }}>
          <ESQLLangEditor
            query={{ esql: query }}
            onTextLangQueryChange={handleQueryChange}
            onTextLangQuerySubmit={async () => {}}
            editorIsInline
            hasOutline
            hideRunQueryButton
            hideQueryHistory
            expandToFitQueryOnMount
            enableResourceBrowser
            isLoading={false}
          />
        </div>
      </EuiFormRow>
      {errors.length > 0 && (
        <>
          <EuiSpacer size="s" />
          <EuiCallOut
            announceOnMount
            color="danger"
            size="s"
            title={i18n.translate('xpack.contextEngine.sourcePicker.esql.invalidTitle', {
              defaultMessage: 'This query cannot run as written',
            })}
            data-test-subj="contextEsqlSourceInvalid"
          >
            <ul>
              {errors.map((error, index) => (
                <li key={index}>{formatValidationError(error)}</li>
              ))}
            </ul>
          </EuiCallOut>
        </>
      )}
      <EuiSpacer size="s" />
      <EuiFlexGroup justifyContent="flexEnd" gutterSize="none">
        <EuiFlexItem grow={false}>
          <EuiButton
            iconType="plusCircle"
            onClick={handleAdd}
            isLoading={isValidating}
            isDisabled={!trimmedQuery || errors.length > 0}
            data-test-subj="contextAddEsqlSourceButton"
          >
            <FormattedMessage
              id="xpack.contextEngine.sourcePicker.esql.addButton"
              defaultMessage="Add ES|QL source"
            />
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
    </div>
  );
};
