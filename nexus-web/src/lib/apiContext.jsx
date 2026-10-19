import { createContext, useContext, useMemo } from 'react';
import { createApi } from './api.js';
import { useAuth } from './auth.jsx';
import { API_URL } from '../config.js';

const ApiContext = createContext(null);

/** Provides the API client; tests may pass a fake `api` directly. */
export function ApiProvider({ api: injected, baseUrl = API_URL, children }) {
  const { getToken } = useAuth();
  const api = useMemo(() => injected || createApi({ baseUrl, getToken }), [injected, baseUrl, getToken]);
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi() {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi must be used inside <ApiProvider>');
  return api;
}
