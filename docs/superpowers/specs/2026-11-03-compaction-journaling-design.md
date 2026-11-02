# Design: Compaction Journaling for RootClaw Native Engine

**Tanggal:** 2026-11-03  
**Status:** Menunggu persetujuan pengguna  
**Repo:** /root/RootClaw (v0.1.137, +4 commits)  
**Prioritas:** 3 dari 12 area OMB-Claw (pertama dari 5 area berdampak sedang)

---

## 1. Intent dan Why

RootClaw Native Engine sudah punya compaction (overflow recovery + turn context offload) di `turn-context.ts` dan `openai-chat.ts`. Namun compaction decisions tidak di-journal — tidak ada catatan persistent tentang apa yang di-compact, kapan, berapa token yang dihemat. OMB-Claw punya `compaction.ts` + `agent_compactions` journal (SQLite) yang mencatat setiap compaction.

Tujuan: tambah compaction journaling ke RootClaw agar setiap compaction decision tercatat persistent, bisa di-audit, dan bisa di-replay. Tanpa mengubah perilaku compaction yang sudah ada.

---

## 2. Goals, Non-Goals, Anti-Goals

### Goals
- Setiap compaction event (overflow recovery, turn context fold) dicatat ke journal persistent
- Journal menyimpan: runId, threadId, botId, round, reason, messagesBefore, messagesAfter, tokensSaved, timestamp
- Journal bisa dibaca kembali untuk audit/replay
- Tidak mengubah perilaku compaction yang sudah ada
- Format: NDJSON (konsisten dengan RootClaw's existing runs.jsonl pattern), bukan SQLite (migrasi terlalu besar untuk prioritas ini)

### Non-Goals
- Tidak migrasi ke SQLite (tetap JSONL/NDJSON)
- Tidak mengubah algoritma compaction (hanya journaling)
- Tidak menambah steering antar round (sudah ada)
- Tidak menambah budget caps hard (sudah ada)

### Anti-Goals
- Journaling menambah latency signifikan ke compaction
- Journal file corrupt menyebabkan turn gagal
- Journal tidak bisa dibaca kembali (format tidak konsisten)

---

## 3. Constraints

- **Format:** NDJSON (satu baris JSON per event), konsisten dengan `runs.jsonl` dan native log
- **Lokasi:** `/root/.rootclaw/compactions/compactions.jsonl` (per data dir)
- **Append-only:** Tidak boleh overwrite existing entries
- **Non-blocking:** Journal write tidak boleh memblokir turn
- **Recovery:** Jika file corrupt, skip entries yang tidak valid, jangan crash
- **Backward compatible:** Tidak mengubah perilaku compaction yang sudah ada

---

## 4. Design Detail

### 4.1 Compaction Journal Entry

```typescript
export interface CompactionEntry {
  id: string;           // unique ID per compaction event
  runId: string;        // turn ID
  threadId: string;
  botId?: string;
  round: number;        // which round triggered compaction
  reason: "overflow" | "budget" | "context";  // why compaction happened
  messagesBefore: number;  // message count before
  messagesAfter: number;   // message count after
  tokensBefore: number;   // estimated tokens before
  tokensAfter: number;    // estimated tokens after
  tokensSaved: number;    // tokensBefore - tokensAfter
  summary?: string;      // compaction summary text (if any)
  timestamp: number;     // Date.now()
}
```

### 4.2 Journal Module

Buat file baru `server/drivers/compaction-journal.ts`:

```typescript
export const COMPACTIONS_FILE = join("compactions", "compactions.jsonl");

export function appendCompaction(dataDir: string, entry: CompactionEntry): void {
  // Append-only write, non-blocking, fire-and-forget
  const file = join(dataDir, COMPACTIONS_FILE);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

export function readCompactions(dataDir: string, filter?: { runId?: string; threadId?: string; botId?: string }): CompactionEntry[] {
  // Read and filter, skip corrupt lines
}

export function foldCompactions(entries: CompactionEntry[]): Map<string, CompactionEntry> {
  // Fold to last entry per runId (like runs.jsonl)
}
```

### 4.3 Integration Points in openai-chat.ts

Compaction happens in two places:

1. **Overflow recovery** (line ~640): When provider returns "request too large", compaction runs
2. **Turn context fold** (line ~630): When turn nears budget, older steps are folded

In both places, after compaction completes, call:
```typescript
appendCompaction(DATA_DIR, {
  id: newId(),
  runId: turnId,
  threadId: turn.threadId,
  botId: turn.botId,
  round,
  reason: "overflow" | "budget",
  messagesBefore: messages.length before,
  messagesAfter: messages.length after,
  tokensBefore: estimated before,
  tokensAfter: estimated after,
  tokensSaved: tokensBefore - tokensAfter,
  summary: compactionSummary,
  timestamp: Date.now(),
});
```

### 4.4 Non-Blocking Write

Journal write uses `appendFileSync` but wrapped in try/catch. If write fails, log error but don't throw. This ensures turn continues even if journal fails.

### 4.5 Read API

Add `GET /api/compactions` or integrate into existing run store read API. For now, just a read function that can be used by other modules.

---

## 5. File yang Disentuh

| File | Perubahan |
|------|-----------|
| `server/drivers/compaction-journal.ts` | Baru: CompactionEntry type, appendCompaction, readCompactions, foldCompactions |
| `server/drivers/openai-chat.ts` | Tambah journal call di 2 compaction points |
| `server/drivers/turn-context.ts` | Export compaction metadata (tokens before/after) |

---

## 6. Test

- Unit test: appendCompaction writes valid NDJSON
- Unit test: readCompactions filters by runId/threadId/botId
- Unit test: foldCompactions folds to last per runId
- Unit test: corrupt lines are skipped, valid lines returned
- Regression: existing compaction tests still pass

---

## Self-Review

1. **Spec coverage**: Compaction journaling covered. Non-blocking write, recovery from corrupt lines, backward compatible.
2. **Step scan**: Setiap step menghasilkan satu hal yang bisa dicek.
3. **Type consistency**: `CompactionEntry` type konsisten. `appendCompaction` dan `readCompactions` signatures jelas.
4. **Review focus**: 
   - Journal write tidak memblokir turn (try/catch)
   - Corrupt lines di-skip (tidak crash)
   - Format NDJSON konsisten dengan runs.jsonl
5. **Proportion**: Design doc sesuai ukuran project.

---

**Apakah design doc ini akurat dan siap untuk implementasi?** Silakan koreksi atau setujui. Setelah disetujui, saya akan invoke `writing-plans` dan mulai implementasi. Silakan review juga apakah ada hal yang perlu ditambahkan atau diubah sebelum kita lanjut. Silakan koreksi atau setujui. Setelah disetujui, saya akan invoke `writing-plans` dan mulai implementasi.