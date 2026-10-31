// Native web tools: web_fetch (HTTP GET, page text) and web_search (DuckDuckGo's free HTML results; no API key, may
// be rate-limited or change shape). Private, loopback and link-local addresses are refused, including after redirects.
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type { ChatToolDefinition, ChatToolResult } from "./chat-mcp-tools.ts";

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const SEARCH_MAX = 10;

export const WEB_TOOL_DEFINITIONS: readonly ChatToolDefinition[] = [
  { type: "function", function: { name: "web_fetch", description: "Fetch a public http(s) URL and return its text (HTML is reduced to readable text). Long pages are shortened.",
    parameters: { type: "object", properties: { url: { type: "string", description: "The http or https URL." } }, required: ["url"], additionalProperties: false } } },
  { type: "function", function: { name: "web_search", description: "Search the web (DuckDuckGo) and return up to 10 results with title, URL and snippet.",
    parameters: { type: "object", properties: { query: { type: "string", description: "The search query." } }, required: ["query"], additionalProperties: false } } },
];

/** Parses an IPv6 literal into eight 16-bit groups (an embedded dotted IPv4 tail included), or null. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().split("%")[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    if (isIP(dotted[1]!) !== 4) return null;
    const [a, b, c, d] = dotted[1]!.split(".").map(Number) as [number, number, number, number];
    text = text.slice(0, -dotted[1]!.length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((group) => /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN);
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

function privateV4(address: string): boolean {
  const [a, b, c] = address.split(".").map(Number) as [number, number, number];
  return a === 0 // "this network", 0.0.0.0/8
    || a === 10 || a === 127 // RFC 1918, loopback
    || (a === 100 && b >= 64 && b <= 127) // CGNAT 100.64/10
    || (a === 169 && b === 254) // link-local, cloud metadata
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) // RFC 1918
    || (a === 192 && b === 0 && (c === 0 || c === 2)) // IETF protocol assignments, TEST-NET-1
    || (a === 192 && b === 88 && c === 99) // 6to4 relay anycast
    || (a === 198 && (b === 18 || b === 19)) // benchmarking 198.18/15
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) // TEST-NET-2/3
    || a >= 224; // multicast 224/4, reserved 240/4, broadcast
}

/** True for every address a fetch must never reach: loopback, private, link-local, CGNAT, multicast, reserved and
 * documentation ranges, and IPv6 forms that carry one of those IPv4 addresses (mapped, compatible, NAT64, 6to4). */
export function privateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  if (isIP(bare) === 4) return privateV4(bare);
  const g = ipv6Groups(bare);
  if (!g) return true; // unparseable: refuse
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1 and IPv4-compatible ::a.b.c.d (deprecated)
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return privateV4(v4(g[6]!, g[7]!)); // ::ffff:a.b.c.d
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return privateV4(v4(g[6]!, g[7]!)); // SIIT ::ffff:0:a.b.c.d (audit N05)
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64 64:ff9b::/96 (and the local-use /48) reaches IPv4 inside
  if (g[0] === 0x2002) return privateV4(v4(g[1]!, g[2]!)); // 6to4 carries its IPv4 in bits 16-47
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo tunnels to an arbitrary IPv4
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard-only 100::/64
  const top = g[0]!;
  return (top & 0xfe00) === 0xfc00 // unique local fc00::/7
    || (top & 0xffc0) === 0xfe80 || (top & 0xffc0) === 0xfec0 // link-local, old site-local
    || (top & 0xff00) === 0xff00; // multicast
}

export interface WebOptions {
  /** Tests only: allow loopback/private targets, all or those a predicate names (the operator can also set
   * ROOTCLAW_WEB_ALLOW_PRIVATE=1 for local evals). */
  allowPrivate?: boolean | ((address: string) => boolean);
  searchUrl?: string;
  /** Tests only: resolve names with this instead of the system resolver. */
  resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
}

const allowsPrivate = (options: WebOptions) => options.allowPrivate === true || process.env.ROOTCLAW_WEB_ALLOW_PRIVATE === "1";

/** ROOTCLAW_WEB_ALLOW_PRIVATE as a comma list of IPv4 CIDRs (e.g. "198.18.0.0/15"): the operator's exceptions for a
 * network where every name resolves into a reserved range, as with a fake-IP DNS proxy (Clash, sing-box, some VPNs),
 * which would otherwise refuse every public site. "1" still allows everything (local evals only). */
export function operatorAllowsAddress(address: string, setting = process.env.ROOTCLAW_WEB_ALLOW_PRIVATE ?? ""): boolean {
  if (isIP(address) !== 4) return false;
  const value = (ip: string) => ip.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
  return setting.split(",").map((entry) => entry.trim()).some((entry) => {
    const match = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(entry);
    if (!match || isIP(match[1]!) !== 4 || Number(match[2]) > 32) return false;
    const size = 2 ** (32 - Number(match[2]));
    return Math.floor(value(address) / size) === Math.floor(value(match[1]!) / size);
  });
}
const refused = (address: string, options: WebOptions) => !allowsPrivate(options) && privateAddress(address)
  && !operatorAllowsAddress(address.replace(/^\[|\]$/g, ""))
  && !(typeof options.allowPrivate === "function" && options.allowPrivate(address.replace(/^\[|\]$/g, "")));

/** Checks what can be checked before connecting: the scheme, and a literal IP host. The URL parser has already turned
 * numeric, octal and hex host spellings (2130706433, 0x7f.1, 0177.0.0.1) into a dotted address, so they land here. */
function guard(url: URL, options: WebOptions): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https URLs are allowed");
  if (url.username || url.password) throw new Error("URLs with credentials are not fetched");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && refused(host, options)) throw new Error(`${url.hostname} is a private or local address`);
}

/** A dispatcher whose connections resolve the name once, refuse it unless every address is public, and connect to the
 * address just checked: no second lookup a rebinding DNS server could answer differently. TLS still verifies, and
 * sends SNI for, the URL's own host name. */
function pinnedDispatcher(options: WebOptions): Agent {
  const resolve = options.resolve ?? ((host: string) => lookup(host, { all: true, verbatim: true }));
  const pinned: LookupFunction = (hostname, lookupOptions, callback) => {
    resolve(hostname).then((entries) => {
      if (!entries.length) throw new Error(`${hostname} did not resolve`);
      if (entries.some((entry) => refused(entry.address, options))) throw new Error(`${hostname} is a private or local address`);
      if (lookupOptions.all) callback(null, entries.map((entry) => ({ address: entry.address, family: entry.family })));
      else callback(null, entries[0]!.address, entries[0]!.family);
    }).catch((error: Error) => callback(Object.assign(error, { code: "EADDRNOTALLOWED" }) as NodeJS.ErrnoException, "", 0));
  };
  return new Agent({ connect: { lookup: pinned }, pipelining: 0 });
}

async function get(raw: string, signal: AbortSignal, options: WebOptions): Promise<{ url: string; status: number; type: string; body: string; cut: boolean }> {
  let url = new URL(raw);
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
  const dispatcher = pinnedDispatcher(options);
  try {
    for (let hop = 0; ; hop++) {
      guard(url, options);
      let response: Awaited<ReturnType<typeof undiciFetch>>;
      try {
        response = await undiciFetch(url, { redirect: "manual", signal: timeout, dispatcher,
          headers: { "user-agent": "Mozilla/5.0 (compatible; RootClaw)", accept: "text/html,text/plain,application/json,*/*" } });
      } catch (error) {
        const cause = (error as { cause?: unknown }).cause;
        throw cause instanceof Error && /private or local|did not resolve/.test(cause.message) ? cause : error;
      }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
        url = new URL(location, url);
        continue;
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0; let cut = false;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); size += value.length;
        if (size > FETCH_MAX_BYTES) { cut = true; await reader.cancel(); break; }
      }
      return { url: url.href, status: response.status, type: response.headers.get("content-type") ?? "", body: Buffer.concat(chunks).subarray(0, FETCH_MAX_BYTES).toString("utf8"), cut };
    }
  } finally {
    await dispatcher.close().catch(() => {});
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'", nbsp: " " };
/** A numeric entity outside Unicode (or a surrogate) decodes to U+FFFD instead of throwing (audit N04). */
const codePoint = (n: number) => Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "\uFFFD";
const decode = (text: string) => text.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (whole, code: string) =>
  ENTITIES[code.toLowerCase()] ?? (code.toLowerCase().startsWith("#x") ? codePoint(parseInt(code.slice(2), 16)) : code.startsWith("#") ? codePoint(Number(code.slice(1))) : whole));

export function htmlToText(html: string): string {
  return decode(html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function executeWebTool(name: string, args: Record<string, unknown>, signal: AbortSignal, options: WebOptions = {}): Promise<ChatToolResult> {
  try {
    if (name === "web_fetch") {
      const page = await get(String(args.url ?? "").trim(), signal, options);
      const text = /html|xml/i.test(page.type) || /^\s*<(!doctype|html)/i.test(page.body) ? htmlToText(page.body) : page.body;
      return { ok: page.status < 400, text: `[${page.status} ${page.url}${page.cut ? "; shortened" : ""}]\n${text}` };
    }
    if (name === "web_search") {
      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, text: "web_search needs a query." };
      const page = await get(`${options.searchUrl ?? "https://html.duckduckgo.com/html/"}?q=${encodeURIComponent(query)}`, signal, options);
      if (page.status >= 400) return { ok: false, text: `Search failed: HTTP ${page.status}.` };
      const links = [...page.body.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
      const snippets = [...page.body.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)];
      const rows = links.slice(0, SEARCH_MAX).map((link, index) => {
        let href = decode(link[1]!);
        const target = /[?&]uddg=([^&]+)/.exec(href)?.[1];
        if (target) try { href = decodeURIComponent(target); } catch {}
        return `${index + 1}. ${htmlToText(link[2]!)}\n   ${href}\n   ${htmlToText(snippets[index]?.[1] ?? "")}`;
      });
      return { ok: true, text: rows.length ? rows.join("\n\n") : "No results (the free search may be rate-limited; try web_fetch on a known page)." };
    }
    return { ok: false, text: `Unknown web tool ${name}.` };
  } catch (error) {
    signal.throwIfAborted();
    return { ok: false, text: `${name} failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
