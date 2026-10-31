import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { executeWebTool, operatorAllowsAddress, privateAddress, type WebOptions } from "./web-tools.ts";

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve(); server = undefined; }));
/** A loopback server; each test lets exactly 127.0.0.1 through, so every other private address stays refused. */
async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
const onlyLoopback = (address: string) => address === "127.0.0.1";
const fetchText = async (url: string, options: WebOptions) => executeWebTool("web_fetch", { url }, new AbortController().signal, options);

describe("privateAddress", () => {
  it.each([
    "127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.64.0.1", "100.127.255.255",
    "0.0.0.0", "0.1.2.3", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "192.0.0.8", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
    "::", "::1", "[::1]", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1", "::127.0.0.1",
    "64:ff9b::7f00:1", "64:ff9b::808:808", "2002:7f00:1::", "2002:c0a8:101::1", "2001::1", "2001:db8::1", "100::1", "not-an-address",
  ])("refuses %s", (address) => expect(privateAddress(address)).toBe(true));

  it.each(["93.184.216.34", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "169.255.0.1",
    "2606:4700::1111", "::ffff:8.8.8.8", "2002:808:808::1", "2a00:1450:4001::200e"])("lets %s through", (address) => expect(privateAddress(address)).toBe(false));
});

describe("web_fetch's network guard", () => {
  it("refuses numeric, octal and hex spellings of a private host, which the URL parser normalizes", async () => {
    for (const url of ["http://2130706433/", "http://0x7f.0.0.1/", "http://0177.0.0.1/", "http://127.1/", "http://[::ffff:7f00:1]/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/"]) {
      const result = await fetchText(url, {});
      expect(result, url).toMatchObject({ ok: false });
      expect(result.text, url).toMatch(/private or local address/);
    }
    expect((await fetchText("http://user:pw@example.com/", {})).text).toMatch(/credentials/);
  });

  it("resolves once, refuses a name if any address is private, and connects to the address it checked", async () => {
    const port = await serve((req, res) => res.end(`host=${req.headers.host}`));
    let lookups = 0;
    const resolve = async (host: string) => { lookups++; return host === "mixed.test" ? [{ address: "127.0.0.1", family: 4 }, { address: "10.0.0.5", family: 4 }]
      : [{ address: "127.0.0.1", family: 4 }]; };
    const ok = await fetchText(`http://pinned.test:${port}/`, { resolve, allowPrivate: onlyLoopback });
    expect(ok).toMatchObject({ ok: true });
    expect(ok.text).toContain(`host=pinned.test:${port}`); // the Host header keeps the name; the socket went to the checked IP
    expect(lookups).toBe(1);
    expect((await fetchText(`http://mixed.test:${port}/`, { resolve, allowPrivate: onlyLoopback })).text).toMatch(/private or local address/);
  });

  it("refuses a rebinding name whose answer turns private, since the answer checked is the one connected to", async () => {
    const port = await serve((_req, res) => res.end("served"));
    let calls = 0;
    // A rebinding server: an allowed answer first (loopback stands in for a public host), a private one after.
    const resolve = async () => [{ address: calls++ === 0 ? "127.0.0.1" : "10.0.0.7", family: 4 }];
    const first = await fetchText(`http://rebind.test:${port}/`, { resolve, allowPrivate: onlyLoopback });
    expect(first.text).toContain("served");
    expect(calls).toBe(1); // no second lookup between the check and the connect
    const second = await fetchText(`http://rebind.test:${port}/`, { resolve, allowPrivate: onlyLoopback });
    expect(second).toMatchObject({ ok: false });
    expect(second.text).toMatch(/private or local address/);
  });

  it("checks every redirect hop and stops after five", async () => {
    let hops = 0;
    const port = await serve((req, res) => {
      if (req.url === "/to-metadata") { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); res.end(); return; }
      if (req.url === "/to-name") { res.writeHead(302, { location: `http://internal.test:${(server!.address() as { port: number }).port}/` }); res.end(); return; }
      if (req.url === "/loop") { hops++; res.writeHead(302, { location: "/loop" }); res.end(); return; }
      res.end("landed");
    });
    const resolve = async (host: string) => [{ address: host === "internal.test" ? "10.0.0.9" : "127.0.0.1", family: 4 }];
    const options = { resolve, allowPrivate: onlyLoopback };
    expect((await fetchText(`http://127.0.0.1:${port}/to-metadata`, options)).text).toMatch(/169\.254\.169\.254 is a private or local address/);
    expect((await fetchText(`http://127.0.0.1:${port}/to-name`, options)).text).toMatch(/internal\.test is a private or local address/);
    expect((await fetchText(`http://127.0.0.1:${port}/loop`, options)).text).toMatch(/too many redirects/);
    expect(hops).toBe(6);
  });
});

describe("operator CIDR exceptions (fake-IP DNS)", () => {
  it("allows only addresses inside the listed IPv4 ranges, and ignores junk entries", () => {
    expect(operatorAllowsAddress("198.18.0.1", "198.18.0.0/15")).toBe(true);
    expect(operatorAllowsAddress("198.19.255.254", "198.18.0.0/15")).toBe(true);
    expect(operatorAllowsAddress("198.20.0.1", "198.18.0.0/15")).toBe(false);
    expect(operatorAllowsAddress("127.0.0.1", "198.18.0.0/15, nonsense, 10.0.0.0/99")).toBe(false);
    expect(operatorAllowsAddress("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(operatorAllowsAddress("::1", "0.0.0.0/0")).toBe(false);
    expect(operatorAllowsAddress("198.18.0.1", "")).toBe(false);
  });
});
