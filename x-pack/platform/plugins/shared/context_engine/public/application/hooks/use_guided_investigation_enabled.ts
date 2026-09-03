/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useEffect, useState } from 'react';
import { CONTEXT_ENGINE_GUIDED_INVESTIGATION_ENABLED_SETTING_ID } from '../../../common/constants';
import { useKibana } from './use_kibana';

/**
 * Reactively reads the global `contextEngine:guidedInvestigationEnabled` advanced setting
 * (default false). The Overview page swaps the plain Sources panel for the investigation scope
 * panel when it is on.
 */
export const useGuidedInvestigationEnabled = (): boolean => {
  const {
    services: { settings },
  } = useKibana();

  const [enabled, setEnabled] = useState<boolean>(() =>
    settings.globalClient.get<boolean>(
      CONTEXT_ENGINE_GUIDED_INVESTIGATION_ENABLED_SETTING_ID,
      false
    )
  );

  useEffect(() => {
    const subscription = settings.globalClient
      .get$<boolean>(CONTEXT_ENGINE_GUIDED_INVESTIGATION_ENABLED_SETTING_ID, false)
      .subscribe(setEnabled);
    return () => subscription.unsubscribe();
  }, [settings]);

  return enabled;
};
