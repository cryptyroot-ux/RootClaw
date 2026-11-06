import { dirname, isAbsolute } from "node:path";

export function skillReadRoots(...texts: Array<string | undefined>): string[] {
  const roots = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(/Read ("(?:[^"\\]|\\.)*(?:\/|\\\\)SKILL\.md")/g)) {
      try {
        const file = JSON.parse(match[1]!) as string;
        if (isAbsolute(file)) roots.add(dirname(file));
      } catch {}
    }
  }
  return [...roots];
}
