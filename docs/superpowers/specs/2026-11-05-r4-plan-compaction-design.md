# Design: Preserve the live plan across compaction

- **Tanggal:** 2026-11-05
- **Status:** Disetujui pengguna
- **Repo:** `/root/RootClaw`
- **Scope:** Perbaikan regresi R4 pada native chat driver

## Intent

Compaction dalam satu turn harus mempertahankan plan terbaru, bukan menghapusnya atau memasang kembali plan/hint dari awal turn.

`openai-chat.ts` membuat `ChatContext` sebelum putaran model pertama. Nilai `plan` dan `planHint` saat itu dikirim sebagai properti biasa. Loop kemudian dapat mengganti keduanya—misalnya `plan` berubah dari `null` menjadi objek revisi baru—tetapi `ChatContext` tetap membaca snapshot awal. Pada akhir `ChatContext.compact()`, `finally` dapat mem-pin snapshot itu di atas plan terbaru. Ketiga pemanggil (`budget`, `overflow`, dan pemulihan `RequestTooLargeError`) memakai metode compaction yang sama.

## Goals

- Setelah compaction, pesan plan yang dipasang tetap mencerminkan plan dan hint terkini pada turn tersebut.
- Plan tetap terjaga jika compaction gagal atau tidak menghasilkan fold, karena blok `finally` tetap berjalan.
- Logika planning dan compaction selain pembacaan state tidak berubah.

## Non-goals

- Mengubah format atau aturan update plan.
- Mengubah kapan compaction dijalankan atau algoritma ringkasan.
- Mengubah API publik, konfigurasi, atau format pesan.
- Mengerjakan temuan audit lain atau tugas native-tool-safety.

## Constraints

- Perbaikan harus sempit pada wiring state turn ke `ChatContext`.
- Regresi diuji melalui driver dan server lokal palsu; jangan memakai provider atau data live.
- Sebelum klaim berhasil, ikuti fixture terisolasi dalam `docs/verification/README.md`.

## Approaches considered

1. **Getter closure pada deps — dipilih.** Properti `plan` dan `planHint` pada objek yang diberikan ke `ChatContext` menjadi getter yang membaca variabel loop saat ini. Ini mempertahankan antarmuka deps dan memperbaiki seluruh jalur yang memakai `compact()` dengan perubahan terkecil.
2. **Objek state mutable bersama.** Jadikan satu objek sebagai sumber kebenaran untuk loop dan `ChatContext`. Lebih eksplisit, tetapi memerlukan refactor referensi plan sepanjang loop.
3. **Snapshot state per pemanggilan `compact()`.** Teruskan state terbaru di setiap call site. Ini eksplisit, tetapi menambah parameter dan harus dipasang benar di ketiga call site.

## Design

Pada konstruksi `ChatContext`, gunakan getter closure untuk `plan` dan `planHint`; jangan menyimpan snapshot keduanya. Getter `ChatContext` yang sudah ada akan membaca state loop terbaru, termasuk pada `finally` saat plan dipasang kembali. Pertahankan `planning` sebagai flag konfigurasi untuk penanganan plan. Saat re-plan mengubahnya dari `false` ke `true`, loop sudah mem-pin plan terbaru sebelum compaction; pesan plan yang trailing tetap berada di tail compaction. Tidak ada bukti bahwa snapshot flag itu menyebabkan R4, jadi jangan perluas perbaikan untuk flag tersebut tanpa regresi yang membuktikannya. Tidak perlu mengubah ketiga call site karena semuanya melalui metode yang sama.

## Regression test and acceptance

Perluas `server/drivers/openai-chat-plan-verify.test.ts` dengan turn scripted yang memperbarui plan setelah `ChatContext` dibuat, lalu memaksa pemanggilan compaction sebelum permintaan model berikutnya. Pastikan pesan plan pada permintaan berikutnya muncul tepat sekali, berada di posisi trailing, dan berisi status serta hint terbaru—bukan snapshot awal. Tes harus membuktikan bahwa `compact()` benar-benar dipanggil; hasil fold tidak wajib karena state dipasang ulang di `finally` baik saat fold berhasil maupun saat hasilnya `null`.

Jalankan tes baru terlebih dahulu dan amati kegagalan pada kode lama. Setelah implementasi, jalankan tes tersebut, tes planner/compaction terkait, typecheck dan lint yang relevan, lalu verifikasi server dengan fixture terisolasi. Laporkan cakupan dan hasil aktual, bukan asumsi.
