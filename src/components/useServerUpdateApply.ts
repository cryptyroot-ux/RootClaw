import { useEffect, useRef, useState } from "react";

import { api } from "@/state/store";
import { APPLY_MARK, APPLY_POLL_MS, appliedAndRunning, applyActive, type ServerApplyStatus } from "@/lib/server-update-apply";

function mark(on: boolean) {
  try {
    if (on) sessionStorage.setItem(APPLY_MARK, "1");
    else sessionStorage.removeItem(APPLY_MARK);
  } catch { /* storage blocked: a reload mid-update just shows the check again */ }
}
function marked(): boolean {
  try { return sessionStorage.getItem(APPLY_MARK) === "1"; } catch { return false; }
}

/** POST /api/updates/apply, then the status every APPLY_POLL_MS through the restart; reloads once the new version answers. */
export function useServerUpdateApply(enabled: boolean) {
  const [status, setStatus] = useState<ServerApplyStatus | null>(null);
  const [lostSince, setLostSince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const watched = useRef(false);

  useEffect(() => {
    if (!enabled || !marked()) return;
    let alive = true;
    void api<ServerApplyStatus>("/api/updates/status", { timeoutMs: 10_000 })
      .then((next) => { if (alive) { watched.current = true; setStatus(next); } })
      .catch(() => mark(false));
    return () => { alive = false; };
  }, [enabled]);

  const active = applyActive(status);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const timer = setInterval(() => {
      void api<ServerApplyStatus>("/api/updates/status", { timeoutMs: 5_000 })
        .then((next) => { if (alive) { setLostSince(null); setStatus(next); } })
        .catch(() => { if (alive) { setLostSince((since) => since ?? Date.now()); setTick((n) => n + 1); } });
    }, APPLY_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [active]);

  useEffect(() => {
    if (!status || active) return;
    mark(false);
    if (!watched.current || !appliedAndRunning(status)) return;
    const timer = setTimeout(() => window.location.reload(), 1_500);
    return () => clearTimeout(timer);
  }, [status, active]);

  return {
    status,
    lostSince,
    error,
    start() {
      setError(null);
      watched.current = true;
      mark(true);
      void api<ServerApplyStatus>("/api/updates/apply", { method: "POST", body: "{}", timeoutMs: 20_000 })
        .then(setStatus)
        .catch((reason: unknown) => {
          mark(false);
          setError(reason instanceof Error ? reason.message : String(reason));
        });
    },
    clear() {
      watched.current = false;
      setStatus(null);
      setError(null);
      setLostSince(null);
    },
  };
}
