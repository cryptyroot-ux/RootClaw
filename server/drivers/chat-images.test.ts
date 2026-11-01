import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SendTurnInput } from "../contracts.ts";
import { assertImageTransport, CHAT_IMAGE_BUDGET, chatImageBudget, chatImage, chatImageSize, chatUserContent } from "./chat-images.ts";

describe("chat image transport and retained budget", () => {
  it("rejects encoded text and mismatched MIME claims while preserving a PNG", () => {
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBv0AAAAASUVORK5CYII=";
    expect(chatImage({ mimeType: "image/png", data }).image_url.url).toBe(`data:image/png;base64,${data}`);
    expect(() => chatImage({ mimeType: "image/jpeg", data })).toThrow("MIME");
    expect(() => chatImage({ mimeType: "image/png", data: Buffer.from("not an image").toString("base64") })).toThrow("MIME");
  });
  it("counts input and successive screenshot batches against one budget", () => {
    const retain = chatImageBudget();
    const part = { type: "image_url" as const, image_url: { url: "x".repeat(CHAT_IMAGE_BUDGET / 2) } };
    retain([part]);
    retain("ordinary text");
    retain([part]);
    expect(() => retain([{ type: "image_url", image_url: { url: "x" } }])).toThrow("cannot be retained");
    expect(() => chatImageBudget()([part])).not.toThrow();
  });
  it.each(["https://api.example.com/v1", "http://localhost:8000/v1", "http://127.0.0.1:8000/v1", "http://[::1]:8000/v1"])("allows encrypted or loopback transport: %s", url => {
    expect(() => assertImageTransport(url)).not.toThrow();
  });
  it.each(["http://api.example.com/v1", "http://localhost.example.com/v1", "http://192.168.1.4/v1", "ftp://localhost/v1"])("refuses remote cleartext or unsupported transport: %s", url => {
    expect(() => assertImageTransport(url)).toThrow("require HTTPS");
  });
});

/** A 1×1 PNG whose IHDR claims `width`×`height`: the header is all the size check reads. */
function pngSized(width: number, height: number, padding = 0): Buffer {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBv0AAAAASUVORK5CYII=", "base64");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return Buffer.concat([png, Buffer.alloc(padding)]);
}

const FIXTURE = join(import.meta.dirname, "../../evals/fixtures/multimodal/rootclaw-04.png");
const part = (mime: string, bytes: Buffer) => ({ type: "image_url" as const, image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } });

describe("image size from the file header", () => {
  it.each([
    ["image/png", pngSized(4000, 3000), 4000, 3000],
    ["image/gif", Buffer.concat([Buffer.from("GIF89a"), Buffer.from([0xa0, 0x0f, 0xb8, 0x0b]), Buffer.alloc(8)]), 4000, 3000],
    ["image/jpeg", Buffer.from("ffd8ffe000104a46494600010100000100010000ffc0001108043800780303012200021101031101ffd9", "hex"), 120, 1080],
    ["image/webp", Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8X"), Buffer.alloc(8), Buffer.from([0x9f, 0x0f, 0x00, 0xb7, 0x0b, 0x00])]), 4000, 3000],
    ["image/webp", Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8L"), Buffer.alloc(4), Buffer.from([0x2f, 0x7f, 0xc7, 0x0d, 0x01]), Buffer.alloc(8)]), 1920, 1080],
    ["image/webp", Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8 "), Buffer.alloc(10), Buffer.from([0x80, 0x07, 0x38, 0x04])]), 1920, 1080],
  ])("reads %s dimensions", (mime, bytes, width, height) => {
    expect(chatImageSize(part(mime, bytes))).toEqual({ width, height });
  });

  it("knows the fixture's size and has none for bytes it cannot read", () => {
    expect(chatImageSize(part("image/png", readFileSync(FIXTURE)))).toEqual({ width: 320, height: 160 });
    expect(chatImageSize(part("image/jpeg", Buffer.from("ffd8ffd9", "hex")))).toBeUndefined();
  });
});

describe("attachments over the provider limits", () => {
  const turn = (...files: Buffer[]): SendTurnInput => {
    const dir = mkdtempSync(join(tmpdir(), "chat-images-"));
    return { threadId: "t", text: "Look.", images: files.map((bytes, index) => {
      const path = join(dir, `${index}.png`);
      writeFileSync(path, bytes);
      return { path, mime: "image/png" as const, bytes: bytes.length };
    }) } as SendTurnInput;
  };

  it("replaces a 4000x3000 image with a note and keeps a small one byte for byte", () => {
    const fixture = readFileSync(FIXTURE);
    const content = chatUserContent(turn(pngSized(4000, 3000), fixture)) as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(content.filter((entry) => entry.type === "image_url")).toEqual([part("image/png", fixture)]);
    expect(content[1]).toEqual({ type: "text", text: expect.stringContaining("4000x3000") });
  });

  it("replaces an image over 5 MB encoded with a note instead of failing the turn", () => {
    const content = chatUserContent(turn(pngSized(2048, 2048, 4 * 1024 * 1024))) as Array<{ type: string; text?: string }>;
    expect(content.map((entry) => entry.type)).toEqual(["text", "text"]);
    expect(content[1]!.text).toContain("5 MB");
  });

  it("sends an image of exactly 2048 px", () => {
    const content = chatUserContent(turn(pngSized(2048, 1536))) as Array<{ type: string }>;
    expect(content.map((entry) => entry.type)).toEqual(["text", "image_url"]);
  });
});
