# Design: Native Engine Upgrade — Capability Provider Pattern + Tool Output Shaping

**Tanggal:** 2026-11-03  
**Status:** Menunggu persetujuan pengguna  
**Repo:** /root/RootClaw (v0.1.137, +2 commits computer_exec)  
**Prioritas:** 1 (Capability provider pattern) + 2 (Tool output shaping) dari 12 area OMB-Claw

---

## 1. Intent dan Why

RootClaw Native Engine saat ini dispatch tool calls via if/else branches di `runCall()` (`openai-chat.ts`). Menambah tool baru memerlukan edit dispatch branch, tool definition registration, dan wiring manual. OMB-Claw (sibling fork) menggunakan **capability provider pattern** yang lebih modular: setiap capability (MCP, native tool, skill, browser, computer, data) di-mount → validate grant → invoke → close sebagai lifecycle terpisah. Tool baru cukup register provider, tanpa edit dispatch.

Selain itu, tool output saat ini di-offload ke file (`read_tool_output`) tanpa shaping di prompt. OMB-Claw punya **tool output shaping**: cap output di prompt (misal 4K chars) dengan marker, simpan full output per run, dan expose `tool_output_read` capability. Ini mencegah context window penuh oleh output tool besar.

Tujuan: RootClaw native engine lebih modular (capability provider) dan lebih efisien (tool output shaping), tanpa mengubah perilaku yang sudah berjalan.

---

## 2. Goals, Non-Goals, Anti-Goals

### Goals
- Refactor dispatch di `openai-chat.ts` dari if/else branches ke capability provider pattern (mount → validate → invoke → close).
- Tambah `tool_output_read` native tool dengan shaping: cap prompt output, simpan full output per run.
- Pertahankan semua perilaku yang sudah ada (approval gate, safety floor, auto-approve, multi-bot, VPS/Local VM computer_exec).
- Setiap tool baru (process_tool, package_tool, dll.) cukup register provider, tidak perlu edit dispatch.

### Non-Goals
- Tidak mengadopsi SQLite run store (tetap JSONL, migrasi terlalu besar).
- Tidak mengadopsi intelligence layer / plan generator / verifier (terlalu besar, bukan prioritas 1-2).
- Tidak mengadopsi steering antar round (RootClaw sudah punya, perlu verifikasi saja).
- Tidak mengadopsi budget caps hard (terlalu besar, bukan prioritas 1-2).
- Tidak mengadopsi native-only mode (RootClaw support CLI/ACP, itu fitur).
- Tidak mengadopsi tool search bridge (RootClaw punya deferTools).
- Tidak mengubah arsitektur multi-bot/room (sudah berjalan).

### Anti-Goals (gagal meski teknis berfungsi)
- Refactor memecahkan tool dispatch yang sudah berjalan (computer_exec, workspace tools, MCP tools).
- Output shaping kehilangan data (full output harus tetap bisa dibaca).
- Capability provider pattern menambah latency signifikan.
- Approval gate atau safety floor terlewati setelah refactor.

---

## 3. Constraints

- **Backward compatible**: semua tool yang sudah ada (shell, read_file, ..., computer_exec) harus tetap berfungsi persis sama.
- **Test coverage**: 14 unit test computer_exec + 27 test chat-tool-approval harus tetap pass.
- **No regression**: bot-level e2e test (Nemotron 3.5 Super VL) harus tetap berhasil.
- **Scope**: Hanya refactor dispatch + tool output shaping. Tidak menambah native tool baru (itu prioritas 3+).
- **Output cap**: 4K chars di prompt (configurable), full output disimpan per run.
- **Approval**: Tetap pakai `createChatToolApproval` dan `safetyFloorBlock`.

---

## 4. Approaches

### Pendekatan 1: Full Refactor ke Capability Provider (OMB-Claw Style)

Refactor seluruh `openai-chat.ts` dispatch ke capability provider pattern. Setiap tool type (workspace, computer_exec, MCP, etc.) jadi provider terpisah dengan mount/validate/invoke/close lifecycle.

- **Kelebihan:** Paling modular, menyerap pola OMB-Claw sepenuhnya
- **Kekurangan:** Refactor besar, risiko regression tinggi, butuh waktu lama
- **Cocok jika:** Anda ingin arsitektur yang bersih dan extensible

### Pendekatan 2: Incremental Provider (Rekomendasi Saya)

Buat capability provider interface dan provider untuk native tools (workspace + computer_exec) saja. MCP tools tetap pakai `ChatToolSession` yang ada. Refactor dispatch untuk menggunakan providers, tapi secara incremental — native providers dulu, MCP nanti.

- **Kelebihan:** Risiko regression lebih rendah, bisa di-test per step
- **Kekurangan:** Tidak sepenuhnya modular (MCP masih if/else)
- **Cocok jika:** Anda ingin improvement bertahap tanpa risiko besar

### Pendekatan 3: Tool Output Shaping Saja (Tanpa Refactor)

Hanya tambah tool output shaping (cap prompt output + tool_output_read) tanpa refactor dispatch. Lebih cepat, risiko rendah, tapi tidak menyelesaikan masalah modularitas.

- **Kelebihan:** Cepat, risiko rendah
- **Kekurangan:** Tidak menyelesaikan masalah if/else dispatch
- **Cocok jika:** Anda hanya ingin tool output shaping

---

## Rekomendasi: Pendekatan 2 (Incremental Provider)

Saya merekomendasikan Pendekatan 2 karena:
1. Risiko regression lebih rendah (native tools dulu, MCP tetap if/else)
2. Bisa di-test per step (unit test + e2e test per provider)
3. Menyiapkan fondasi untuk menambah tool baru dengan mudah (process_tool, package_tool, dll.)
4. Tidak memerlukan refactor besar yang bisa memecahkan perilaku yang sudah berjalan

---

## 5. Design Detail

### 5.1 Capability Provider Interface

Buat file baru `server/drivers/capability-provider.ts`:

```typescript
export interface CapabilityProvider {
  /** Unique ID for this provider (e.g., "native-workspace", "native-computer-exec", "mcp-computer") */
  id: string;
  /** Mount the provider: validate, set up, return available tool definitions */
  mount(scope: ToolScope | undefined): Promise<ChatToolDefinition[]>;
  /** Validate arguments against the tool's schema */
  validate(name: string, args: unknown): void;
  /** Show the approval card view for this tool call */
  view(name: string, args: Record<string, unknown>): ChatToolCallView;
  /** Execute the tool call */
  execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ChatToolResult>;
  /** Close the provider (cleanup) */
  close(): Promise<void>;
}
```

### 5.2 Native Workspace Provider

Refactor `workspace-tools.ts` exports ke capability provider:

```typescript
export function createWorkspaceProvider(config: WorkspaceToolsConfig, scope: ToolScope | undefined): CapabilityProvider {
  return {
    id: "native-workspace",
    async mount(scope) { /* return WORKSPACE_TOOL_DEFINITIONS filtered by scope */ },
    validate(name, args) { validateWorkspaceArgs(name, args); },
    view(name, args) { return workspaceToolView(name, args); },
    execute(name, args, signal) { return executeWorkspaceTool(name, args, config, signal); },
    async close() { stopBackgroundJobs(config.jobScope ?? "default"); },
  };
}
```

### 5.3 Native Computer Exec Provider

```typescript
export function createComputerExecProvider(connection: ComputerExecConnection, scope: ToolScope | undefined): CapabilityProvider {
  return {
    id: "native-computer-exec",
    async mount(scope) { /* return computerExecDefinitions() filtered by scope */ },
    validate(name, args) { validateComputerExecArgs(args); },
    view(name, args) { return computerExecToolView(name, args); },
    execute(name, args, signal) { return executeComputerExec(args, connection, signal); },
    async close() { /* no cleanup needed */ },
  };
}
```

### 5.4 Tool Output Shaping

Buat file baru `server/drivers/tool-output-shaping.ts`:

```typescript
const PROMPT_CAP_CHARS = 4_000; // configurable

export function shapeToolOutput(text: string, callId: string, runId: string): { shaped: string; stored: boolean; callId: string } {
  if (text.length <= PROMPT_CAP_CHARS) {
    return { shaped: text, stored: false, callId };
  }
  // Store full output, return shaped version with marker
  storeToolOutput(runId, callId, text);
  return {
    shaped: text.slice(0, PROMPT_CAP_CHARS) + `\n\n[output truncated at ${PROMPT_CAP_CHARS} chars; use tool_output_read with callId "${callId}" to read the full output]`,
    stored: true,
    callId,
  };
}
```

Tambah `tool_output_read` native tool definition:

```typescript
export const TOOL_OUTPUT_READ_TOOL = "tool_output_read";
export const toolOutputReadDefinitions = (): ChatToolDefinition[] => [
  {
    type: "function",
    function: {
      name: TOOL_OUTPUT_READ_TOOL,
      description: "Read the full output of a tool call that was truncated. Use the callId from the truncated output.",
      parameters: {
        type: "object",
        properties: {
          callId: { type: "string", description: "The callId from the truncated output marker." },
          offset: { type: "integer", minimum: 0, description: "Character offset to start reading from (default 0)." },
          limit: { type: "integer", minimum: 1, maximum: 20_000, description: "Maximum characters to read (default 4000)." },
        },
        required: ["callId"],
        additionalProperties: false,
      },
    },
  },
];
```

### 5.5 Refactor openai-chat.ts Dispatch

Ganti if/else branches dengan provider-based dispatch:

```typescript
// Before:
} else if (workspace && workspaceNames.has(call.function.name)) {
  // workspace tool handling
} else if (computerExec && call.function.name === COMPUTER_EXEC_TOOL) {
  // computer_exec handling
} else if (planning && call.function.name === UPDATE_PLAN_TOOL) {
  // plan handling
} else if (offloadOn && call.function.name === READ_TOOL_OUTPUT_TOOL) {
  // read output handling
} else {
  // MCP session handling
}

// After (incremental):
const provider = providers.find(p => p.definitions.some(d => d.function.name === call.function.name));
if (provider) {
  provider.validate(call.function.name, args);
  const shown = provider.view(call.function.name, args); title = shown.title;
  const full = (turn.approvalModeNow?.() ?? turn.approvalMode) === "full";
  const floored = approval.floored({ full, threadId: turn.threadId, botId: turn.botId, shown, summary: inputPreview });
  const allowed = !floored && (full || !shown.ask || await approval.ask(shown.title, inputPreview ?? "This tool has no arguments.", shown.grant));
  abort.signal.throwIfAborted();
  emit({ ...base(...), type: "item.started", itemType: "tool", itemId: call.id, ...commandSummary(), title: shown.title, ... });
  started = true;
  if (allowed) {
    result = await provider.execute(call.function.name, args, abort.signal);
    // Apply tool output shaping
    if (result.text.length > PROMPT_CAP_CHARS) {
      const shaped = shapeToolOutput(result.text, call.id, turnId);
      result = { ...result, text: shaped.shaped };
    }
  } else {
    loopGuard.deny(call.id);
    denials.push(shown.title);
    result = { ok: false, text: refusal(floored, ...) };
  }
} else if (planning && call.function.name === UPDATE_PLAN_TOOL) {
  // plan handling (stays as-is)
} else if (offloadOn && call.function.name === READ_TOOL_OUTPUT_TOOL) {
  // read output handling (stays as-is)
} else {
  // MCP session handling (stays as-is for now)
}
```

---

## 6. File yang Disentuh

| File | Perubahan |
|------|-----------|
| `server/drivers/capability-provider.ts` | Baru: CapabilityProvider interface |
| `server/drivers/tool-output-shaping.ts` | Baru: shapeToolOutput + tool_output_read native tool |
| `server/drivers/workspace-tools.ts` | Tambah `createWorkspaceProvider()` export |
| `server/drivers/computer-exec-tools.ts` | Tambah `createComputerExecProvider()` export |
| `server/drivers/openai-chat.ts` | Refactor dispatch dari if/else ke provider-based |
| `server/drivers/chat-mcp-tools.ts` | Tambah `createMcpProvider()` export (optional, incremental) |

---

## 7. Test

- Unit test: capability provider mount/validate/view/execute/close
- Unit test: tool output shaping (cap + retain + read)
- Regression test: 14 computer_exec tests + 27 chat-tool-approval tests tetap pass
- E2E: bot-level test dengan Nemotron 3.5 Super VL (sudah terverifikasi)

---

## 8. Yang Ditinggalkan ke Builder

1. Apakah `CapabilityProvider` interface harus di file terpisah atau di `chat-mcp-tools.ts`?
2. Apakah MCP tools juga di-refactor ke provider sekarang, atau tetap if/else?
3. Apakah `tool_output_read` harus jadi native tool (seperti `read_tool_output`) atau capability?
4. Apakah output cap chars (4000) harus configurable via config.json?

---

## Self-Review

1. **Spec coverage**: Semua requirement prioritas 1-2 tercakup. Capability provider pattern (1) + tool output shaping (2).
2. **Step scan**: Setiap step menghasilkan satu hal yang bisa dicek. Tidak ada "TBD" atau baris kosong.
3. **Type consistency**: `CapabilityProvider` interface konsisten. `shapeToolOutput` dan `tool_output_read` konsisten dengan `callId` parameter.
4. **Review focus**: 
   - Refactor tidak memecahkan dispatch yang sudah berjalan
   - Output shaping tidak kehilangan data (full output tetap bisa dibaca)
   - Capability provider pattern tidak menambah latency signifikan
   - Approval gate dan safety floor tetap berlaku setelah refactor
5. **Proportion**: Design doc ~2x spec length, wajar untuk project size.

---

**Apakah design doc ini akurat dan siap untuk implementasi?** Silakan koreksi atau setujui. Setelah disetujui, saya akan invoke `writing-plans` dan mulai implementasi. Silakan review juga apakah ada hal yang perlu ditambahkan atau diubah sebelum kita lanjut. Silakan koreksi atau setujui. Setelah disetujui, saya akan invoke `writing-plans` dan mulai implementasi.