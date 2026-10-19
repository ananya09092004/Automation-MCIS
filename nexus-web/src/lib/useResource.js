import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Loads data with explicit loading / error / data states. Stale responses
 * (from an earlier workspace or a superseded reload) are ignored.
 * `loader` returns a promise; pass `enabled=false` to skip loading.
 */
export function useResource(loader, deps, { enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: enabled });
  const seq = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(loader, deps);

  const run = useCallback(async (silent = false) => {
    const my = ++seq.current;
    if (!silent) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await load();
      if (my === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (my === seq.current) setState((s) => ({ data: silent ? s.data : null, error, loading: false }));
    }
  }, [load]);

  useEffect(() => {
    if (!enabled) { setState({ data: null, error: null, loading: false }); return; }
    run();
  }, [run, enabled]);

  return { ...state, reload: () => run(false), refresh: () => run(true) };
}
