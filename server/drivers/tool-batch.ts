// Runs one model response's tool calls: consecutive read-only calls concurrently (bounded), every other call alone and
// in order. Results are committed strictly in call order, so the model reads them as it asked for them.

export const DEFAULT_TOOL_CONCURRENCY = 4;

export function toolConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const value = Math.floor(Number(env.ROOTCLAW_TOOL_CONCURRENCY));
  return Number.isFinite(value) && value >= 1 ? Math.min(16, value) : DEFAULT_TOOL_CONCURRENCY;
}

export async function runToolBatch<Call, Result>(calls: readonly Call[], options: {
  readOnly(call: Call): boolean;
  run(call: Call): Promise<Result>;
  /** In call order; a throw stops the batch (a fatal tool error or an abort). */
  commit(result: Result, call: Call): void;
  signal: AbortSignal;
  concurrency?: number;
}): Promise<void> {
  const limit = Math.max(1, options.concurrency ?? toolConcurrency());
  for (let index = 0; index < calls.length;) {
    options.signal.throwIfAborted();
    if (!options.readOnly(calls[index]!)) {
      const call = calls[index++]!;
      options.commit(await options.run(call), call);
      continue;
    }
    let end = index;
    while (end < calls.length && options.readOnly(calls[end]!)) end++;
    const group = calls.slice(index, end);
    index = end;
    const results = new Array<Result>(group.length);
    let next = 0;
    const worker = async () => {
      while (next < group.length && !options.signal.aborted) {
        const at = next++;
        results[at] = await options.run(group[at]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, group.length) }, worker));
    options.signal.throwIfAborted();
    group.forEach((call, at) => options.commit(results[at]!, call));
  }
}
