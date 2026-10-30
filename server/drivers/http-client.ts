// Model-call HTTP for every native adapter (openai-chat and the adapters/ protocols). A pooled keep-alive socket can
// be dropped by the server or a proxy in front of it after a short idle time it never advertised (no Keep-Alive
// hint), so the client reuses a dead socket and the request dies with ECONNRESET / UND_ERR_SOCKET before any
// response byte. That failure is retried once at once on a brand-new connection: no backoff wait, outside the turn's
// retry budget, and never after a response started (body/stream errors happen after fetch resolves, not here).
import { Agent, fetch as undiciFetch } from "undici";

const STALE_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);

/** A request that died on its socket before any response: what a reused, already-dropped keep-alive socket gives. */
export function isStaleSocketError(error: unknown): boolean {
  if (!(error instanceof TypeError) || error.message !== "fetch failed") return false;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === "string" && STALE_CODES.has(cause.code);
}

/** Origins that answered before: only those can have a pooled keep-alive socket to go stale. */
const answered = new Set<string>();
const originOf = (url: string) => { try { return new URL(url).origin; } catch { return url; } };

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export interface FreshOptions { headersTimeout?: number; bodyTimeout?: number; onStale?: (error: unknown) => void }

/** fetch, plus one immediate resend on a fresh connection when a stale pooled socket failed it before any response. */
export async function fetchFresh(url: string, init: RequestInit, send: Fetch = fetch, options: FreshOptions = {}): Promise<Response> {
  const origin = originOf(url);
  try {
    const response = await send(url, init);
    answered.add(origin);
    return response;
  } catch (error) {
    // Only where a pooled socket can exist (the origin answered before), only a body that can be sent again (our
    // JSON strings), and never once the caller gave up. A server that resets every connection gets no extra send.
    if (!answered.has(origin) || !isStaleSocketError(error) || init.signal?.aborted || (init.body != null && typeof init.body !== "string")) throw error;
    options.onStale?.(error);
    // A one-off pool holds exactly this request's connection; it closes once the response (stream included) is done.
    const agent = new Agent({ connections: 1, keepAliveTimeout: 1,
      ...(options.headersTimeout !== undefined ? { headersTimeout: options.headersTimeout } : {}),
      ...(options.bodyTimeout !== undefined ? { bodyTimeout: options.bodyTimeout } : {}) });
    try {
      return await undiciFetch(url, { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
    } finally {
      void agent.close().catch(() => undefined);
    }
  }
}
