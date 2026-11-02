# Design: SQLite Run Store for RootClaw Native Engine

**Tanggal:** 2026-11-03  
**Status:** Eksekusi dimulai  
**Repo:** /root/RootClaw (v0.1.137, +5 commits)  
**Prioritas:** 5 dari 12 area OMB-Claw (kedua dari 5 area berdampak sedang)

---

## 1. Intent dan Why

RootClaw Native Engine saat ini menyimpan run records di file JSONL (`runs/runs.jsonl`). Setiap perubahan state run di-append sebagai baris baru, dan file di-compact (rewrite) ketika melebihi kapasitas. OMB-Claw menggunakan SQLite (`node:sqlite` / `DatabaseSync`) untuk run store, capability calls, compactions, dan tool outputs — lebih robust untuk recovery dan query.

Tujuan: migrasi run store dari JSONL ke SQLite, meningkatkan reliability dan recovery, tanpa mengubah interface `RunStore` yang sudah ada.

---

## 2. Goals, Non-Goals, Anti-Goals

### Goals
- Migrasi run store dari JSONL ke SQLite (`node:sqlite` / `DatabaseSync`)
- Schema: tabel `runs` dengan semua field `RunRecord`
- Migrasi data existing dari `runs.jsonl` ke SQLite (sekali, pada startup)
- Pertahankan interface `RunStore` yang sama (`begin`, `observe`, `get`, `list`, `retry`, `interruptedAtBoot`)
- Recovery dari restart: mark interrupted runs, retry logic
- Non-blocking writes (try/catch, tidak memblokir turn)

### Non-Goals
- Tidak migrasi capability calls / compactions / tool outputs ke SQLite (itu bisa nanti)
- Tidak mengubah interface `RunStore`
- Tidak mengadopsi OMB-Claw's full capability journal (terlalu besar)

### Anti-Goals
- Migrasi memecahkan existing runs (data loss)
- SQLite write memblokir turn
- Database corrupt menyebabkan server crash

---

## 3. Constraints

- **SQLite library:** `node:sqlite` (DatabaseSync) — built-in Node 22.5+, tersedia di Node 24.21.0
- **Database file:** `/root/.rootclaw/runs.db` (satu file SQLite)
- **Migration:** Sekali, pada startup, dari `runs/runs.jsonl` ke `runs.db`. Setelah migrasi, JSONL tidak lagi ditulis.
- **Backward compat:** `RunStore` interface tidak berubah. Semua caller (openai-chat.ts, index.ts) tetap sama.
- **Recovery:** Interrupted runs ditandai pada boot (sama seperti sekarang).
- **Cap:** 500 runs default (sama seperti sekarang).

---

## 4. Design Detail

### 4.1 SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  bot_id TEXT,
  instance_id TEXT,
  driver TEXT,
  model TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT '[]',  -- JSON array
  failover_from TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  rounds INTEGER NOT NULL DEFAULT 0,
  tools TEXT NOT NULL DEFAULT '[]',  -- JSON array of RunTool
  usage TEXT,  -- JSON object
  stop_reason TEXT,
  errors TEXT NOT NULL DEFAULT '[]',  -- JSON array
  notices INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER,
  first_output_ms INTEGER,
  failover INTEGER NOT NULL DEFAULT 0,
  retried_at INTEGER,
  cost_source TEXT,
  plan TEXT,  -- JSON object
  verify TEXT,  -- JSON object
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id);
CREATE INDEX IF NOT EXISTS idx_runs_bot ON runs(bot_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
```

### 4.2 RunStore Implementation

Ganti `createRunStore` di `run-store.ts` untuk menggunakan SQLite:

- `begin()`: INSERT OR REPLACE into runs
- `observe()`: UPDATE runs SET ... WHERE id = ?
- `get()`: SELECT * FROM runs WHERE id = ?
- `list()`: SELECT * FROM runs WHERE ... ORDER BY started_at DESC LIMIT ?
- `retry()`: UPDATE runs SET retried_at = ? WHERE id = ?
- `interruptedAtBoot`: SELECT * FROM runs WHERE status = 'running'

### 4.3 Migration from JSONL

Pada startup, jika `runs/runs.jsonl` ada dan `runs.db` belum ada:
1. Baca semua entries dari JSONL
2. Fold ke last snapshot per runId
3. INSERT ke SQLite
4. Rename JSONL ke `runs.jsonl.migrated` (backup)

### 4.4 Non-Blocking Writes

Semua SQLite writes dibungkus try/catch. Jika write gagal, log error tapi jangan throw. Turn tetap berjalan.

### 4.5 Thread Safety

SQLite dengan WAL mode untuk concurrent reads. Single writer (Node.js single-threaded). WAL mode: `PRAGMA journal_mode = WAL;`

---

## 5. File yang Disentuh

| File | Perubahan |
|------|-----------|
| `server/run-store.ts` | Rewrite: SQLite backend, migration from JSONL, same RunStore interface |
| `server/message-db.ts` | Tambah run-related tables (atau buat `server/run-db.ts` baru) |

---

## 6. Test

- Unit test: begin/observe/get/list/retry/interruptedAtBoot
- Unit test: migration from JSONL to SQLite
- Unit test: corrupt JSONL lines skipped during migration
- Unit test: interrupted runs marked on boot
- Regression: existing run-store tests still pass

---

## Self-Review

1. **Spec coverage**: SQLite run store covered. Migration, recovery, backward compat.
2. **Step scan**: Setiap step menghasilkan satu hal yang bisa dicek.
3. **Type consistency**: RunStore interface tidak berubah. RunRecord fields sama.
4. **Review focus**:
   - Migration tidak kehilangan data (backup JSONL)
   - SQLite write tidak memblokir turn (try/catch)
   - Database corrupt tidak crash server (try/catch pada open)
   - WAL mode untuk concurrent reads
   - Interrupted runs ditandai pada boot
5. **Proportion**: Design doc sesuai ukuran project.

---

**Apakah design doc ini akurat dan siap untuk implementasi?** Silakan koreksi atau setujui. Setelah disetujui, saya akan invoke `writing-plans` dan mulai implementasi. Silakan review juga apakah ada hal yang perlu ditambahkan atau diubah sebelum kita lanjut. Silakan koreksi atau setujui. Setelah disetujui, saya akan invoke `writing-plans` dan mulai implementasi.