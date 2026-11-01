// A forged UNTRUSTED TOOL OUTPUT marker inside tool output could close the fence early (audit N16, N16r). Matching
// the marker's words lost to every new spelling (small caps, Cherokee, "." or ":" separators, partial markers, long
// gaps), so the fence's own shape is what gets defused: any run that reads as three or more "<" (or ">") in a row,
// counting look-alike brackets, spaces and invisible characters between them, has every third bracket replaced by
// "·". The words around it stay as they were, and no run that reads as a fence edge is left, however it is spelled.

/** Brackets that read as one "<", two ("«", "≪", "《") or three ("⋘"); NFKC is applied first, which folds "＜" and "﹤". */
const OPEN = "<\uFE64\uFF1C\u02C2\u1438\u276E\u27E8\u3008\u2329\u276C\u29FC\u2039\u2770\u00AB\u226A\u300A\u22D8";
/** The same for ">". */
const CLOSE = ">\uFE65\uFF1E\u02C3\u1433\u276F\u27E9\u3009\u232A\u276D\u29FD\u203A\u2771\u00BB\u226B\u300B\u22D9";
const DOUBLE = "\u00AB\u226A\u300A\u00BB\u226B\u300B";
const TRIPLE = "\u22D8\u22D9";
/** Spaces, format characters (zero-width, joiners, BOM, soft hyphen, bidi controls), combining marks and invisible fillers. */
const IGNORABLE = /^[\s\p{Cf}\p{M}\u115F\u1160\u3164\uFFA0]$/u;
const DEFUSED = "\u00B7";

const weight = (char: string) => (TRIPLE.includes(char) ? 3 : DOUBLE.includes(char) ? 2 : 1);
/** The bracket direction a character reads as once folded, or undefined. */
function direction(char: string): typeof OPEN | typeof CLOSE | undefined {
  const folded = char.normalize("NFKC");
  if (folded.length !== 1) return undefined;
  return OPEN.includes(folded) ? OPEN : CLOSE.includes(folded) ? CLOSE : undefined;
}

/** Replaces every third bracket of each run that reads as "<<<" or ">>>" with "·"; linear and idempotent. */
export function defuseFenceMarkers(text: string): string {
  // Fast path: no character that can start a run.
  if (!/[<>\uFE64\uFE65\uFF1C\uFF1E\u02C2\u02C3\u1438\u1433\u276C-\u2771\u27E8\u27E9\u3008-\u300B\u2329\u232A\u29FC\u29FD\u2039\u203A\u00AB\u00BB\u226A\u226B\u22D8\u22D9]/u.test(text)) return text;
  let out = "", run = 0, side: string | undefined;
  for (const char of text) {
    const dir = direction(char);
    if (dir === undefined) {
      if (!IGNORABLE.test(char)) run = 0;
      out += char;
      continue;
    }
    if (dir !== side) { side = dir; run = 0; }
    run += weight(char.normalize("NFKC"));
    if (run >= 3) { out += DEFUSED; run = 0; } else out += char;
  }
  return out;
}
