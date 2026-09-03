/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EuiProvider } from '@elastic/eui';
import { coreMock } from '@kbn/core/public/mocks';
import { I18nProvider } from '@kbn/i18n-react';
import { KibanaContextProvider } from '@kbn/kibana-react-plugin/public';
import { QueryClient, QueryClientProvider } from '@kbn/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { GetAiIndexResponse } from '../../../../common/http_api/ai_indices';
import { StorageTypePanel } from './storage_type_panel';

const aiIndex: GetAiIndexResponse = {
  id: 'my-ai-index',
  managed: false,
  dest: { type: 'index', value: 'ai-index-idx-my-ai-index' },
  automations: [],
  sources: [{ type: 'esql', value: 'FROM logs-*' }],
  date_created: '2026-01-01T00:00:00.000Z',
  date_modified: '2026-01-01T00:00:00.000Z',
};

const renderWithProviders = (
  ui: React.ReactElement,
  services: ReturnType<typeof coreMock.createStart> = coreMock.createStart()
) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider>
      <EuiProvider>
        <KibanaContextProvider services={services}>
          <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
        </KibanaContextProvider>
      </EuiProvider>
    </I18nProvider>
  );
};

describe('StorageTypePanel', () => {
  it('shows the current storage type and backing store', () => {
    renderWithProviders(
      <StorageTypePanel
        isLoading={false}
        aiIndex={aiIndex}
        hasKis={false}
        onSaved={jest.fn()}
        isManaged={false}
      />
    );

    expect(screen.getByTestId('contextStorageTypeValue')).toHaveTextContent('Index');
    expect(screen.getByText('ai-index-idx-my-ai-index')).toBeInTheDocument();
    expect(screen.getByTestId('contextEditStorageTypeButton')).toBeEnabled();
  });

  it('switches to a data stream, carrying every other property through the PUT', async () => {
    const services = coreMock.createStart();
    services.http.put.mockResolvedValue({ status: 'updated' });
    const onSaved = jest.fn();

    renderWithProviders(
      <StorageTypePanel
        isLoading={false}
        aiIndex={aiIndex}
        hasKis={false}
        onSaved={onSaved}
        isManaged={false}
      />,
      services
    );

    fireEvent.click(screen.getByTestId('contextEditStorageTypeButton'));
    fireEvent.click(screen.getByTestId('contextAiIndexStorageType-data_stream'));
    expect(screen.getByText('ai-index-ds-my-ai-index')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('contextStorageTypeSaveButton'));

    await waitFor(() => {
      expect(services.http.put).toHaveBeenCalledWith(
        '/api/context_engine/ai_index/my-ai-index',
        expect.objectContaining({
          body: JSON.stringify({
            dest: { type: 'data_stream', value: 'ai-index-ds-my-ai-index' },
            automations: [],
            sources: [{ type: 'esql', value: 'FROM logs-*' }],
          }),
        })
      );
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('does not write when the type is unchanged', async () => {
    const services = coreMock.createStart();

    renderWithProviders(
      <StorageTypePanel
        isLoading={false}
        aiIndex={aiIndex}
        hasKis={false}
        onSaved={jest.fn()}
        isManaged={false}
      />,
      services
    );

    fireEvent.click(screen.getByTestId('contextEditStorageTypeButton'));
    fireEvent.click(screen.getByTestId('contextStorageTypeSaveButton'));

    expect(services.http.put).not.toHaveBeenCalled();
    expect(screen.queryByTestId('contextStorageTypeSaveButton')).not.toBeInTheDocument();
  });

  it('locks editing once Knowledge Indicators exist', () => {
    renderWithProviders(
      <StorageTypePanel
        isLoading={false}
        aiIndex={aiIndex}
        hasKis
        onSaved={jest.fn()}
        isManaged={false}
      />
    );

    expect(screen.getByTestId('contextStorageTypeLocked')).toBeInTheDocument();
    expect(screen.getByTestId('contextEditStorageTypeButton')).toBeDisabled();
  });

  it('locks editing when the AI index points at a custom backing store', () => {
    renderWithProviders(
      <StorageTypePanel
        isLoading={false}
        aiIndex={{ ...aiIndex, dest: { type: 'index', value: 'ai-index-idx-custom-*' } }}
        hasKis={false}
        onSaved={jest.fn()}
        isManaged={false}
      />
    );

    expect(screen.getByTestId('contextStorageTypeLocked')).toBeInTheDocument();
    expect(screen.getByTestId('contextEditStorageTypeButton')).toBeDisabled();
  });

  it('hides the edit control for managed AI indexes', () => {
    renderWithProviders(
      <StorageTypePanel
        isLoading={false}
        aiIndex={aiIndex}
        hasKis={false}
        onSaved={jest.fn()}
        isManaged
      />
    );

    expect(screen.queryByTestId('contextEditStorageTypeButton')).not.toBeInTheDocument();
    expect(screen.getByTestId('contextStorageTypeValue')).toHaveTextContent('Index');
  });
});
