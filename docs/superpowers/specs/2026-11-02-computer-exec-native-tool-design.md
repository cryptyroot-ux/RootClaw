# Design: computer_exec (tool native engine) — RootClaw

**Tanggal:** 2026-11-02  
**Versi:** 1.0  
**Status:** Menunggu persetujuan pengguna  
**Repo:** /root/RootClaw (v0.1.137)

---

## 1. Intent dan why

Bot yang bekerja di VPS (`my-vps`, Docker-over-SSH) dan Local VM (container Cua di host ini) saat ini hanya bisa berinteraksi dengan desktop lewat klik, ketik, dan screenshot. Tidak ada cara untuk menjalankan perintah terminal langsung dan menerima teks hasilnya. Bot harus mengetik perintah karakter per karakter lalu membaca screenshot — lambat dan rawan kesalahan.

Tujuan: tambah tool `computer_exec` sebagai **tool native engine** di RootClaw, sehingga bot bisa menjalankan perintah terminal di dalam container Cua miliknya (VPS atau Local VM) dan menerima output teks (exit code, stdout, stderr), mengganti alur ketik-terminal + baca-screenshot.

---

## 2. Goals, non-goals, anti-goals

### Goals
- Tool `computer_exec` tersedia untuk engine native RootClaw (hanya OpenAI-chat native loop, tidak untuk Claude Code/Codex CLI driver).
- Tersedia di VPS dan Local VM (scope yang dipilih pengguna).
- Perintah dijalankan sebagai user `cua` di dalam container Cua milik bot.
- Output: exit code + stdout + stderr, dalam teks.
- Default timeout 60 detik, maksimal 120 detik, output maksimal 128 KiB total (64 KiB per stream).
- Gunakan alur approval dan safety floor yang sama dengan tool komputer lain.

### Non-goals
- Tidak untuk host "this computer" (sudah punya shell native bwrap).
- Tidak untuk cloud/Boat (sudah punya `exec`).
- Tidak untuk engine non-native (Claude Code, Codex CLI, dll.).
- Tidak mengubah image Cua atau rebuild container.
- Tidak menyimpan kredensial atau menambah endpoint baru.

### Anti-goals (gagal meski teknis berfungsi)
- Tool muncul untuk bot yang tidak punya komputer ter-mount (VPS/Local VM).
- Perintah berjalan sebagai root di host (tidak ada escape container).
- Output tidak terbatas membanjiri konteks model.
- Tool bisa dipanggil saat komputer sedang diambil alih orang (gate komputer harus tetap).

---

## 3. Constraints

- **Scope:** VPS + Local VM saja.
- **Limits:** default timeout 60s, max 120s, output 128 KiB total (64 KiB stdout + 64 KiB stderr).
- **Command:** maksimal 4000 karakter, wajib.
- **cwd:** default `/home/cua/workspace`, opsional.
- **User:** `cua` di dalam container; `sudo` tersedia di dalam container untuk perintah butuh root.
- **Gate:** tool hanya muncul saat komputer (VPS atau Local VM) sudah di-mount untuk turn itu. Orang yang sedang mengambil alih komputer → tool ditunda/di-block sama seperti tool komputer lain.
- **Engine:** hanya native engine (`openai-chat.ts`). Model API driver (Claude, Codex) tidak mendapat tool ini otomatis.
- **Tidak ada perubahan image Cua.** Eksekusi lewat `docker exec` (VPS: `docker -H ssh://my-vps exec`, Local VM: `docker exec` atau `podman exec`).

---

## 4. Approaches (yang sudah dipilih dalam obrolan)

| Opsi | Cara | Kelebihan | Kekurangan | Status |
|---|---|---|---|---|
| **A. Bridge-injected** | Tambah `computer_exec` di MCP bridge VPS/Local VM | Semua engine, gate reuse, perubahan kecil | Perlu ubah `mcp-bridge.ts`; nama jadi `mcp__computer__computer_exec` | Ditolak pengguna |
| **B. MCP server terpisah** | Mount server `computer-exec` sendiri | Pemisahan rapi | Wiring lebih banyak, nama tool berubah | Ditolak pengguna |
| **C. Tool native engine** | Tambah tool di engine native (`openai-chat.ts`) | Ikut approval native, nama `computer_exec` sama | Hanya engine native, routing per komputer lebih rumit | **Dipilih pengguna** |

Pilihan pengguna: **C (tool native engine)**. Alasan: tool hanya untuk native API driver, routing VPS/Local VM sudah diketahui RootCwal di waktu dispatch, dan nama tool tetap `computer_exec`.

---

## 5. Bagaimana dibangun (keputusan desain)

### 5.1 Deskriptor di `SendTurnInput.integrations` (`server/contracts.ts`)

Tambah field `computerExec` di samping `localComputer`:

```ts
computerExec?: {
  /** "vps" atau "local-vm" */
  kind: "vps" | "local-vm";
  /** Alias SSH VPS (hanya kind === "vps") */
  sshAlias?: string;
  /** Nama container Cua */
  containerName: string;
  /** Runtime: "docker", "podman", atau "container" (hanya kind === "local-vm") */
  runtime?: Runtime;
  /** Socket Cua di dalam container (hanya kind === "local-vm") */
  socket?: string;
};
```

Hanya satu yang aktif per turn (yang komputernya di-mount). RootClaw sudah tahu container dan alias di waktu mount, jadi deskriptor dibangun saat `integrations.localComputer` di-set.

### 5.2 Definisi tool dan eksekusi (`server/drivers/`)

Buat file baru `server/drivers/computer-exec-tools.ts` (polanya mirip `workspace-tools.ts`):

- `COMPUTER_EXEC_TOOL = "computer_exec"`
- `computerExecDefinitions()`: ChatToolDefinition dengan schema:
  - `command`: string, required, max 4000 chars
  - `cwd`: string, optional, default `/home/cua/workspace`
  - `timeout_ms`: number, optional, default 60000, min 1000, max 120000
- `computerExecToolView(name, args)`: ChatToolCallView untuk kartu approval (title, input, ask = true).
- `executeComputerExec(args, connection, signal)`: jalankan perintah, kembalikan `ChatToolResult`:
  - VPS: spawn `docker -H ssh://<alias> exec -u cua -e HOME=/home/cua -e DISPLAY=:1 -w <cwd> <container> /usr/bin/timeout -k 2s <secs> /bin/bash -lc '<command>'`
  - Local VM: spawn `<runtime> exec -u cua -e HOME=/home/cua -e DISPLAY=:1 -w <cwd> <container> /usr/bin/timeout -k 2s <secs> /bin/bash -lc '<command>'`
  - Output: `{ ok, text }` dengan exit code, stdout, stderr. Cap 64 KiB per stream (128 KiB total) dengan penanda truncation. `isError` true jika exit code ≠ 0.
  - `timeout_ms` menjadi `-k 2s <secs>` dari `/usr/bin/timeout`.

### 5.3 Dispatch branch di `openai-chat.ts`

Tambah branch di samping `workspace && workspaceNames.has(...)` (sekitar baris 1113):

```ts
} else if (computerExec && call.function.name === COMPUTER_EXEC_TOOL) {
  validateComputerExecArgs(args);
  const shown = computerExecToolView(call.function.name, args); title = shown.title;
  const full = ... === "full";
  const floored = approval.floored({ full, threadId, botId, shown, summary: inputPreview });
  const allowed = !floored && (full || !shown.ask || await approval.ask(shown.title, shownPreview, shown.grant, computerExecCommandScope(args)));
  if (allowed) result = await executeComputerExec(args, computerExecConnection, abort.signal);
  else { ... denial ... }
```

Tambah `computerExecCommandScope(args)` yang mengembalikan `{ command, cwd }` untuk safety floor (mirip `shellCommandScope`).

### 5.4 Wiring di `server/index.ts`

Di setiap tempat di mana `integrations.localComputer` di-set untuk VPS atau Local VM (baris ~5815 `mountBotVps`, ~8131, ~8160, ~10142), juga set `integrations.computerExec` dengan deskriptor yang sama (container/alias yang sudah diketahui). Tidak ada proses baru yang di-start; deskriptor hanya berisi informasi yang cukup untuk `docker exec` nanti.

### 5.5 Safety floor

Perintah dicek dengan `safetyFloorBlock(command)` sebelum dieksekusi (sama seperti shell workspace). Jika floor block → ditolak tanpa kartu orang. Floor off by default; dinyalakan via `config.json` `safetyFloor.enabled` atau `ROOTCLAW_SAFETY_FLOOR=1`.

### 5.6 Approval

Pakai `createChatToolApproval` yang sama dengan workspace tools. Kartu permission ditampilkan kecuali `full` access atau session grant sudah mencakup. `grant` di-hash dari deskriptor (tidak ada kredensial yang disimpan).

### 5.7 Output capping

- stdout cap 64 KiB, stderr cap 64 KiB (total 128 KiB).
- Jika terpotong, tambahkan penanda `[dipotong]` di akhir teks.
- Exit code, stdout, stderr selalu termasuk (termasuk jika exit code ≠ 0).

---

## 6. File yang disentuh

| File | Perubahan |
|---|---|
| `server/contracts.ts` | Tambah `computerExec` di `SendTurnInput.integrations` |
| `server/drivers/computer-exec-tools.ts` | Baru: definisi tool, view, executor |
| `server/drivers/openai-chat.ts` | Tambah import, definisi, branch dispatch, scope helper |
| `server/index.ts` | Set `integrations.computerExec` di mount VPS + Local VM |
| `server/safety-floor-gate.ts` | Tidak perlu perubahan (pakai `safetyFloorBlock` yang ada) |
| `server/drivers/chat-tool-approval.ts` | Tidak perlu perubahan (pakai approval yang ada) |

---

## 7. Test

- Unit test: schema validasi (`command` wajib, max 4000 char; `timeout_ms` 1000–120000; `cwd` default).
- Unit test: output capping 64 KiB per stream.
- Isolated Cua container verification: jalankan `docker exec` ke container Cua sementara, verifikasi stdout/stderr/exit code.
- Tidak ada end-to-end bot test (belum ada model provider terpasang).

---

## 8. Yang masih tertangani builder

1. Lokasi file executor: satu file baru `computer-exec-tools.ts` atau masukkan ke `workspace-tools.ts`? (Saya pilih file baru untuk pemisahan clearly.)
2. Nama field di deskriptor: `kind: "vps" \| "local-vm"` vs. dua field terpisah `vpsExec` / `localVmExec`? (Saya pilih `kind` untuk kepararan.)
3. Apakah `cwd` default harus `/home/cua/workspace` atau boleh dikonfigurasi per bot? (Saya pilih default tetap, opsional diubah per panggilan.)
4. Apakah tool juga muncul untuk turn tanpa computer (hanya `computerExec` tanpa `localComputer`)? (Saya pilih tidak — tool hanya aktif saat komputer ter-mount.)

Silakan koreksi atau terima. Setelah disetujui, saya akan invoke `writing-plans` dan mulai implementasi.