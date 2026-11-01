// Cut 04: what a text-only model gets in place of images, and the one resend without them when a model the catalog
// does not know refuses image input. Kept out of openai-chat.ts, which the file-size ratchet caps.
import { HttpStatusError } from "./retry.ts";
import type { OpenAIChatMessage } from "./model-adapter.ts";
import type { VisionInput } from "./model-vision.ts";

export type { VisionInput };

export const TEXT_ONLY_ATTACHMENT_NOTE = "[The person attached image(s), but this model cannot see images. Say so if the request depends on them.]";
export const TEXT_ONLY_SCREENSHOT_NOTE = "[Screenshot not shown: this model cannot see images. Read the page with a snapshot or a text tool instead.]";

/** A model that cannot read images refuses a request carrying one with a 400 (OpenRouter: 404, no endpoint for it). */
export function rejectsImageInput(error: Error): boolean {
  return error instanceof HttpStatusError && [400, 404, 422].includes(error.status) &&
    /\b(?:does not|doesn't|cannot|can't) (?:support|accept|process|handle) (?:images?|image input|vision)\b|\b(?:images?|image input|vision)(?: inputs?)? (?:is |are )?(?:not supported|unsupported)\b|\bsupport image input\b/i.test(error.message);
}

/** Strips every image part, with the note a text-only model gets in its place; false when there was none. */
export function withoutImages(messages: OpenAIChatMessage[], request: OpenAIChatMessage): boolean {
  let stripped = false;
  for (const message of messages) {
    if (!Array.isArray(message.content) || !message.content.some((part) => part.type === "image_url")) continue;
    const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
    message.content = [...text, message === request ? TEXT_ONLY_ATTACHMENT_NOTE : TEXT_ONLY_SCREENSHOT_NOTE].join("\n\n");
    stripped = true;
  }
  return stripped;
}

/** Per runtime: which models get images, and the resend after a refusal. A text-only model keeps the computer and
 * browser tools but never receives a screenshot or attachment; an unknown one (the default) gets images until it
 * refuses them, then stays text-only. */
export function createImageFallback(imageInput: ((model: string) => VisionInput) | undefined, driverKind: string, defaultModel: () => string) {
  const refused = new Set<string>();
  return {
    /** `model` is the turn's model; empty means the runtime's default. */
    sees: (model: string | undefined) => {
      const id = model || defaultModel();
      return !refused.has(id) && imageInput?.(id) !== false;
    },
    /** True when `messages` were stripped of images for one resend: only a model the catalog does not know is given
     * one, and it stays text-only after. `native` logs the refusal in the thread's native log. */
    resend(error: Error, model: string, messages: OpenAIChatMessage[], request: OpenAIChatMessage, native: (dir: "out", msg: unknown) => void): boolean {
      if (!rejectsImageInput(error) || (imageInput?.(model) ?? "unknown") !== "unknown" || !withoutImages(messages, request)) return false;
      refused.add(model);
      native("out", { refused: "image_input" });
      console.warn(`${driverKind}: ${model} refused image input; resending without images from now on`);
      return true;
    },
  };
}
