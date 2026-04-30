import { useState, useEffect } from "react";

const cache = new Map();

export function useApi(endpoint) {
  const cached = endpoint ? cache.get(endpoint) : null;
  const [state, setState] = useState({
    data: cached ?? null,
    loading: endpoint ? !cached : false,
    error: null,
    forEndpoint: endpoint,
  });

  useEffect(() => {
    if (!endpoint) {
      setState({ data: null, loading: false, error: null, forEndpoint: null });
      return;
    }

    let cancelled = false;

    if (cache.has(endpoint)) {
      setState({ data: cache.get(endpoint), loading: false, error: null, forEndpoint: endpoint });
    } else {
      setState({ data: null, loading: true, error: null, forEndpoint: endpoint });
    }

    fetch(endpoint)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text();
          try {
            const json = JSON.parse(body);
            throw new Error(json.error || `HTTP ${res.status}: ${body}`);
          } catch (e) {
            if (e.message.startsWith("HTTP")) throw e;
            throw e;
          }
        }
        return res.json();
      })
      .then((json) => {
        cache.set(endpoint, json);
        if (!cancelled) {
          setState({ data: json, loading: false, error: null, forEndpoint: endpoint });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setState((prev) => ({ ...prev, error: err.message, loading: false }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  if (state.forEndpoint !== endpoint) {
    if (!endpoint) return { data: null, loading: false, error: null };
    const newCached = cache.get(endpoint);
    if (newCached) return { data: newCached, loading: false, error: null };
    return { data: null, loading: true, error: null };
  }

  return { data: state.data, loading: state.loading, error: state.error };
}
