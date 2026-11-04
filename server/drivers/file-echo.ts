// Line-diff echo helpers for workspace tool output: numbered lines around changed ranges.
// Extracted from server/drivers/workspace-tools.ts to keep that file under 1,000 lines.
const ECHO_LINES = 40;
const ECHO_BYTES = 2_048;
const ECHO_CONTEXT = 3;
export const WRITE_ECHO_LINES = 20;
export const WRITE_ECHO_MAX_LINES = 200;

/** Numbered lines of `text` around the changed line ranges (0-based, inclusive), so the model need not read it back.
 * At most `maxLines` lines and 2 KB; a cut ends in "[…]", a skipped stretch between changes shows as "…". */
export function changeEcho(text: string, changed: Array<[number, number]>, context = ECHO_CONTEXT, maxLines = ECHO_LINES): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const shown = new Set<number>();
  for (const [start, end] of changed) {
    for (let at = Math.max(0, start - context); at <= Math.min(lines.length - 1, end + context); at++) shown.add(at);
  }
  const order = [...shown].sort((a, b) => a - b);
  const width = String((order.at(-1) ?? 0) + 1).length;
  const out: string[] = [];
  let bytes = 0;
  let count = 0;
  for (const [index, at] of order.entries()) {
    const line = `${index && at > order[index - 1]! + 1 ? "…\n" : ""}${String(at + 1).padStart(width)}\t${lines[at]}`;
    if (count === maxLines || bytes + Buffer.byteLength(line) + 1 > ECHO_BYTES - 4) return [...out, "[…]"].join("\n");
    out.push(line);
    bytes += Buffer.byteLength(line) + 1;
    count++;
  }
  return out.join("\n");
}

export function countOf(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
}

export const lineOf = (text: string, index: number) => countOf(text.slice(0, index), "\n");
