import { readFileSync, statSync } from "node:fs";
import type { SendTurnInput } from "../contracts.ts";
import type { OpenAIChatMessage } from "./model-adapter.ts";

export interface ChatImagePart { type: "image_url"; image_url: { url: string } }
export interface ChatTextPart { type: "text"; text: string }
export type ChatContentPart = ChatTextPart | ChatImagePart;
const IMAGE_BYTES = 20 * 1024 * 1024;
const MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const CHAT_IMAGE_BUDGET = 32 * 1024 * 1024;
/** The strictest provider limits (Anthropic): longest side and encoded size. A larger image becomes a note. */
const IMAGE_SIDE = 2048;
const IMAGE_ENCODED = 5 * 1024 * 1024;

export interface ImageSize { width: number; height: number }

/** Width and height from a PNG, GIF, WebP or JPEG header. */
function headerSize(bytes: Buffer): ImageSize | undefined {
  const size = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined);
  if (bytes.length >= 24 && bytes.toString("ascii", 12, 16) === "IHDR") return size(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  if (bytes.length >= 10 && bytes.toString("ascii", 0, 3) === "GIF") return size(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  if (bytes.length >= 30 && bytes.toString("ascii", 8, 12) === "WEBP") {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X") return size(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1);
    if (chunk === "VP8L") { const bits = bytes.readUInt32LE(21); return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1); }
    if (chunk === "VP8 ") return size(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
    return undefined;
  }
  for (let at = 2; at + 9 <= bytes.length && bytes[at] === 0xff;) {
    const marker = bytes[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return size(bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5));
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return undefined;
}

const sizes = new WeakMap<ChatImagePart, ImageSize | null>();

/** The pixel size of an image part, read once from its header; undefined when the header does not say. */
export function chatImageSize(part: ChatImagePart): ImageSize | undefined {
  if (!sizes.has(part)) {
    const data = part.image_url.url.slice(part.image_url.url.indexOf(",") + 1);
    sizes.set(part, headerSize(Buffer.from(data, "base64")) ?? null);
  }
  return sizes.get(part) ?? undefined;
}

/** The note that replaces an image over the provider limits; undefined for one that may go as is. */
export function oversizedImageNote(part: ChatImagePart): string | undefined {
  const size = chatImageSize(part);
  if (size && Math.max(size.width, size.height) > IMAGE_SIDE) {
    return `[Image not sent: ${size.width}x${size.height} px is over the ${IMAGE_SIDE} px limit for model input.]`;
  }
  const encoded = part.image_url.url.length - part.image_url.url.indexOf(",") - 1;
  return encoded > IMAGE_ENCODED ? `[Image not sent: ${(encoded / 1024 / 1024).toFixed(1)} MB encoded is over the 5 MB limit for model input.]` : undefined;
}

/** Bound retained base64 before JSON serialization or another model call. */
export function chatImageBudget() {
  let used = 0;
  return (parts: string | ChatContentPart[] | null) => {
    if (!Array.isArray(parts)) return;
    const added = parts.reduce((total, part) => total + (part.type === "image_url" ? part.image_url.url.length : 0), 0);
    if (used + added > CHAT_IMAGE_BUDGET) throw new Error("Turn image budget exceeded (32 MiB encoded); screenshot cannot be retained. An operation may already have taken effect; inspect its state before retrying.");
    used += added;
  };
}

export function assertImageTransport(url: string) {
  const endpoint = new URL(url);
  const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("Images and computer tools require HTTPS for remote API endpoints; HTTP is supported only on loopback.");
  }
}

export function chatImage(item: { mimeType?: unknown; data?: unknown }): ChatImagePart {
  const { mimeType, data } = item;
  if (typeof mimeType !== "string" || !MIME.has(mimeType) || typeof data !== "string" ||
      !data.length || data.length > Math.ceil(IMAGE_BYTES / 3) * 4 || data.length % 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error("Invalid or oversized MCP image");
  }
  const bytes = Buffer.from(data, "base64");
  const matches = mimeType === "image/png" ? bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) && bytes.toString("ascii", 12, 16) === "IHDR"
    : mimeType === "image/jpeg" ? bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mimeType === "image/gif" ? bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))
    : bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (bytes.length > IMAGE_BYTES || bytes.toString("base64") !== data || !matches) throw new Error("Image bytes do not match the declared MIME type");
  return { type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } };
}

export function chatUserContent(turn: SendTurnInput): string | ChatContentPart[] {
  if (!turn.images?.length) return turn.text;
  const budget = chatImageBudget();
  return [{ type: "text", text: turn.text }, ...turn.images.map((image): ChatContentPart => {
    if (statSync(image.path).size > IMAGE_BYTES) throw new Error("Image exceeds 20 MB");
    const part = chatImage({ mimeType: image.mime, data: readFileSync(image.path).toString("base64") });
    const note = oversizedImageNote(part);
    if (note) return { type: "text", text: note };
    budget([part]);
    return part;
  })];
}

export function chatToolImages(callId: string, images?: ChatImagePart[]): ChatContentPart[] {
  return images?.length ? [{ type: "text", text: `Screenshot result from tool call ${callId}:` }, ...images] : [];
}

const KEPT_SCREENSHOTS = 3;

/** Only the newest three tool screenshots of a turn keep their images; older ones become a note. Attachments stay. */
export function pruneScreenshots(messages: OpenAIChatMessage[]) {
  let kept = 0;
  for (const message of [...messages].reverse()) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const groups: Array<{ id?: string; parts: ChatContentPart[] }> = [];
    for (const part of message.content) {
      const id = part.type === "text" ? /^Screenshot result from tool call (.+):$/.exec(part.text)?.[1] : undefined;
      if (id !== undefined || !groups.length) groups.push({ id, parts: [part] });
      else groups.at(-1)!.parts.push(part);
    }
    let pruned = false;
    for (const group of [...groups].reverse()) {
      if (group.id === undefined || !group.parts.some((part) => part.type === "image_url") || ++kept <= KEPT_SCREENSHOTS) continue;
      group.parts = [{ type: "text", text: `[Screenshot from tool call ${group.id} removed to save context; take a new one if needed.]` }];
      pruned = true;
    }
    if (pruned) message.content = groups.flatMap((group) => group.parts);
  }
}
