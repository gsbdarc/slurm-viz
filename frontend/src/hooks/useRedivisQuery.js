import { useState, useEffect, useRef } from "react";

const cache = new Map();

export function useRedivisQuery(queryFn, cacheKey) {
  const queryFnRef = useRef(queryFn);
  queryFnRef.current = queryFn;

  const cached = cacheKey ? cache.get(cacheKey) : null;
  const [state, setState] = useState({
    data: cached ?? null,
    loading: cacheKey ? !cached : false,
    error: null,
    forKey: cacheKey,
  });

  useEffect(() => {
    if (!cacheKey || !queryFnRef.current) {
      setState({ data: null, loading: false, error: null, forKey: null });
      return;
    }

    let cancelled = false;

    if (cache.has(cacheKey)) {
      setState({
        data: cache.get(cacheKey),
        loading: false,
        error: null,
        forKey: cacheKey,
      });
    } else {
      setState({ data: null, loading: true, error: null, forKey: cacheKey });
    }

    queryFnRef
      .current()
      .then((result) => {
        cache.set(cacheKey, result);
        if (!cancelled) {
          setState({
            data: result,
            loading: false,
            error: null,
            forKey: cacheKey,
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            error: err.message,
            loading: false,
          }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey]);

  if (state.forKey !== cacheKey) {
    if (!cacheKey) return { data: null, loading: false, error: null };
    const newCached = cache.get(cacheKey);
    if (newCached) return { data: newCached, loading: false, error: null };
    return { data: null, loading: true, error: null };
  }

  return { data: state.data, loading: state.loading, error: state.error };
}
