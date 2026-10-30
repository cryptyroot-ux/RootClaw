// Side-effect import that scrubs ambient ROOTCLAW env before a module snapshots it (scripts/mcp-server.ts reads
// ROOTCLAW_URL / ROOTCLAW_PORT at evaluation). Import order is the contract: keep it above the module under test.
import { isAmbientOmbKey } from "./rootclaw-env.ts";

for (const key of Object.keys(process.env)) {
  if (isAmbientOmbKey(key)) delete process.env[key];
}
