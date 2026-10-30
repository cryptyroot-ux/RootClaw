import { readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";

/**
 * Host-memory budget for the native engine's helpers: the bot browser and MCP servers. The engine itself runs in this
 * server's process (the native OpenAI-compatible loop), so there are no engine processes to admit, queue or stop; what
 * is left is how much memory the host has to spare, which scales how long idle sessions and browsers are kept.
 */
const MB = 1024 * 1024;

/** What one bot's browser is budgeted (Chrome with a few tabs). */
export const BROWSER_BYTES = 400 * MB;
/** What one session's MCP servers are budgeted. */
export const SESSION_BYTES = 200 * MB;

export interface HostMemory { totalBytes: number; availableBytes: number; swapFreeBytes: number }

/** /proc/meminfo; null where there is no /proc (not Linux). */
export function readHostMemory(read: (path: string) => string = (path) => readFileSync(path, "utf8")): HostMemory | null {
  let meminfo: string;
  try { meminfo = read("/proc/meminfo"); } catch { return null; }
  const field = (name: string) => { const found = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(meminfo); return found ? Number(found[1]) * 1024 : null; };
  const totalBytes = field("MemTotal"), availableBytes = field("MemAvailable");
  if (totalBytes === null || availableBytes === null) return null;
  return { totalBytes, availableBytes, swapFreeBytes: field("SwapFree") ?? 0 };
}

export interface EngineBrowsers {
  /** Whether this thread's bot may browse and its browser is not running yet. */
  starts(threadId: string): boolean;
  /** This thread's work was stopped: its browser can close too once no turn holds it. */
  stopped(threadId: string): void;
}

export interface EngineMemoryOptions { enabled: boolean; read?: () => HostMemory | null }

export class EngineMemory {
  readonly enabled: boolean;
  private readonly read: () => HostMemory | null;
  private browsers: EngineBrowsers | null = null;

  constructor(options: EngineMemoryOptions) {
    this.enabled = options.enabled;
    this.read = options.read ?? (() => readHostMemory());
  }

  useBrowsers(browsers: EngineBrowsers): void { this.browsers = browsers; }

  /** Whether a turn on this thread would start a browser and the host can't spare its budget. */
  browserTight(threadId: string): boolean {
    const memory = this.enabled ? this.read() : null;
    return Boolean(memory && this.browsers?.starts(threadId) && this.spare(memory) < BROWSER_BYTES + SESSION_BYTES);
  }

  /** Spawned helper processes are no longer tracked one by one; kept so callers need not know. */
  track(_child: ChildProcess): void {}

  /** A stalled turn's cause; memory is no longer a reason given. */
  stallCause(_threadId: string, cause: string): string { return cause; }

  /** 1 with half the machine to spare, down to a tenth as it runs out; 1 where memory can't be read or the budget is off. */
  headroom(): number {
    const memory = this.enabled ? this.read() : null;
    if (!memory) return 1;
    return Math.min(1, Math.max(0.1, this.spare(memory) / (memory.totalBytes / 2)));
  }

  /** Free memory above the floor the server and page cache keep. */
  private spare(memory: HostMemory): number {
    return memory.availableBytes + memory.swapFreeBytes / 2 - Math.max(320 * MB, memory.totalBytes * 0.1);
  }
}

export const engineMemory = new EngineMemory({ enabled: (process.env.ROOTCLAW_CLOUD_ROLE === "home" || process.env.ROOTCLAW_CLOUD_ROLE === "team") && process.platform === "linux" });
