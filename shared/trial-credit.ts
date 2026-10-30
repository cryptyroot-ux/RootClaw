// The free trial's Claude credit refusing a turn, in the plain English words
// the server stores in the failed turn's row: the phones read those words
// whole, and the app words them again in the reader's language.

/** Used up or no longer on this Cloud (both for good, until another token
 * comes), paused for now, or too little left for this one request. */
export type TrialCreditRefusal = "used_up" | "ended" | "paused" | "too_low";

export const TRIAL_CREDIT_REFUSED: Record<TrialCreditRefusal, string> = {
  used_up: "Your trial Claude credit is used up. To keep your bots working, add an API key, or sign in with OpenRouter or Google.",
  ended: "Trial Claude credit isn't available on My Cloud anymore. Add an API key, or sign in with OpenRouter or Google.",
  paused: "Trial Claude credit is paused for now. Try again later, or add an API key, or sign in with OpenRouter or Google.",
  too_low: "Your trial Claude credit has too little left for this chat. Start a new chat, or add an API key, or sign in with OpenRouter or Google.",
};

/** Which refusal a failed turn's cause is, or null for any other failure. */
export function trialCreditKind(cause: string): TrialCreditRefusal | null {
  return (Object.keys(TRIAL_CREDIT_REFUSED) as TrialCreditRefusal[]).find(kind => TRIAL_CREDIT_REFUSED[kind] === cause.trim()) ?? null;
}
