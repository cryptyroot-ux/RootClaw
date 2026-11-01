// SuperGrok device sign-in (admin scope, behind the auth gate):
//   POST /api/oauth/xai/start       → { url, code, expiresIn } for xAI's own page
//   GET  /api/oauth/xai/status      → { state: idle | pending | signed-in | failed, error? }
//   POST /api/oauth/xai/cancel
//   POST /api/oauth/xai/disconnect  → deletes the stored tokens
import { GrokLogin } from "../grok-login.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createGrokLoginRoutes(login: GrokLogin = new GrokLogin()): RouteHandler {
  return async ({ res, path, method, json }) => {
    const match = /^\/api\/oauth\/xai\/(start|status|cancel|disconnect)$/.exec(path);
    if (!match) return PASS;
    const action = match[1];
    if (action === "status") {
      if (method !== "GET") return json(res, 405, { error: "GET only" });
      return json(res, 200, login.status());
    }
    if (method !== "POST") return json(res, 405, { error: "POST only" });
    if (action === "cancel") {
      await login.cancel();
      return json(res, 200, login.status());
    }
    if (action === "disconnect") {
      await login.disconnect();
      return json(res, 200, login.status());
    }
    try {
      return json(res, 200, await login.start());
    } catch (error) {
      return json(res, 409, { error: error instanceof Error ? error.message : "SuperGrok sign-in failed." });
    }
  };
}
