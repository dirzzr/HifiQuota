# HifiQuota 📡

Bot Telegram untuk cek kuota **HiFi Air Indosat** (wifi wireless berbasis kartu SIM) — dengan dashboard visual, grafik PNG, riwayat, prediksi, dan notifikasi pintar. Dibangun dengan Bun + Telegraf, zero-dependency berat, aman jalan di VPS 128MB.

> By **ridhz** (dirzzr) • MIT License

---

## 📖 Definisi Project

**HifiQuota** adalah bot Telegram self-hosted untuk memantau sisa kuota internet **Indosat HiFi Air** — layanan wifi wireless yang menggunakan kartu SIM. Bot mengambil data langsung dari API resmi `hifi.ioh.co.id` (alur 4 langkah: guest token → checkaltno → validatecallplan → quota/details), menyimpan snapshot harian ke SQLite, lalu menyajikannya sebagai dashboard teks visual + grafik PNG.

Target pengguna: pelanggan HiFi Air yang ingin tahu **sisa kuota, pemakaian harian, rata-rata, dan prediksi kapan kuota habis** — tanpa buka dashboard web Indosat.

---

## ✨ Fitur

| Fitur | Command / Tombol | Deskripsi |
|---|---|---|
| Dashboard visual | `/dashboard` | Ringkasan lengkap: quota, pakai hari ini, trend 7 hari, breakdown paket, prediksi, sparkline 30 hari |
| Cek kuota | `/cekkuota` | Sisa kuota akumulasi (MB+GB auto) + bar visual + status |
| Cek paket | `/cekpaket` | Detail semua paket aktif/kadaluarsa (sisa, expiry, period, quota detail) |
| Riwayat | `/riwayat [7\|14\|28\|30]` | Tabel pemakaian harian + grafik ASCII + statistik |
| Grafik PNG | `/grafik [7\|14\|30]` | Gambar chart PNG: bar pemakaian harian, garis rata-rata & limit, kartu ringkasan |
| Prediksi | `/prediksi` | Estimasi kapan kuota habis (avg 7 hari), trend naik/turun, banding minggu lalu vs ini |
| Summary | `/summary` | Ringkasan mingguan singkat |
| Set limit | `/setlimit 10gb` | Limit harian custom (100mb, 10gb, 1.5gb) |
| Status | `/status` | MSISDN, limit, pemakaian hari ini, sisa, expiry |
| Ganti nomor | `/gantimsisdn` | Ganti hash customerid / nomor 628... |
| Headers manager | `/setheaders`, `/viewheaders` | Update headers API manual jika 401/403 (3 langkah interaktif) |
| Menu button | `/menu` | Keyboard inline interaktif semua fitur |
| Help | `/help` | Panduan lengkap semua command |

### Otomatis (Scheduler)

| Fitur | Jadwal | Deskripsi |
|---|---|---|
| Snapshot harian | 00:00 WIB | Simpan sisa kuota ke DB → basis riwayat & "pakai hari ini" |
| Cek limit | tiap 30 menit | Notif 🔵 50% / 🟡 90% / 🔴 100% limit (sekali per level per hari) |
| Prediksi notif | tiap 30 menit | Warning kalau kuota prediksi habis <3 hari / habis sebelum expiry |
| Cleanup core dump | tiap jam | Hapus core dump agar VPS 128MB tidak penuh |

### Teknis

- **Zero native dependency** — PNG chart dirender pure JS (encoder PNG + font bitmap 5x7 + `Bun.deflateSync`), tanpa canvas/Puppeteer
- **Anti-ban** — rate limit + jitter 120-400ms per request, UA pool rotasi, guest token di-cache 30 menit, cookie Imperva auto-refresh
- **Auto token refresh** — token dari response header di-update otomatis ke config
- **Snapshot 0-fix** — auto-repair snapshot 0 akibat `isMigratedUser` false
- **Retry sendPhoto** — 3x retry saat `ECONNRESET` (umum di VPS murah)
- **Callback anti-timeout** — `answerCbQuery` instan + `setImmediate` untuk proses berat

---

## 🚀 Instalasi & Menjalankan

```bash
# 1. Install Bun (kalau belum)
# Windows: powershell -c "irm bun.sh/install.ps1 | iex"
# Linux:   curl -fsSL https://bun.sh/install | bash

# 2. Clone & install
git clone https://github.com/dirzzr/HifiQuota.git
cd HifiQuota
bun install

# 3. Konfigurasi — isi BOT_TOKEN dari @BotFather
cp config.example.json config.json   # atau edit langsung config.json

# 4. Jalankan
bun run src/index.ts          # production
bun run src/index.ts --check  # self-check (validasi parse, PNG, dll)
bun run dev                   # dev mode --watch
```

Deploy 24 jam dengan pm2 / systemd / panel Ptero:
```bash
pm2 start "bun run src/index.ts" --name hifiquota
```
atau pakai `start.sh` (sudah termasuk disable core dump untuk VPS 128MB).

---

## ⚙️ Konfigurasi

Konfigurasi via `config.json` (utama, ramah file manager Ptero) atau `.env` (fallback):

| Key | Wajib? | Deskripsi |
|---|---|---|
| `BOT_TOKEN` | ✅ | Token dari @BotFather |
| `HIFI_AUTH` | — | Header Authorization API (default ada, auto-generate jika kosong) |
| `HIFI_TOKENID` | — | JWT token API, auto-refresh dari response header |
| `HIFI_OAUTH` | — | Hash oauth untuk header `x-imi-oauth` |
| `HIFI_UID` | — | UID lama (opsional, auto-regenerate tiap request) |
| `TZ` | — | Timezone, default `Asia/Jakarta` |

Semua key `HIFI_*` opsional — bot punya flow 4-langkah otomatis untuk guest token. Isi manual hanya jika API balas 401/403 terus (ambil via DevTools → Network → `quota/details`).

### Apa itu hash MSISDN?

Di API Indosat, body `msisdn` bukan nomor HP, tapi **hash `customerid` 32 hex** (contoh `7caa857288fcee5e8befab21e729`). Hash ini = claim `customerid` di JWT `X-IMI-TOKENID`, tidak bisa diderive dari nomor HP. Ambil via DevTools: buka https://hifi.ioh.co.id/topup-hifiair → Network → cari `quota/details/v8` → Payload → `msisdn`. Bot juga menerima nomor `628...` dan meng-enkripsi RC4 otomatis.

---

## 🗄️ Database

`data.db` (SQLite via `bun:sqlite`, auto-create):

- **users** — `chat_id, msisdn, limit_mb, last_50_date, last_90_date, last_100_date, last_prediksi_date, created_at`
- **snapshots** — `chat_id, date, remaining_mb, created_at` (PK gabungan, upsert harian)

Multi-user: tiap chat Telegram punya baris MSISDN + limit sendiri.

---

## 📁 Struktur

```
HifiQuota/
├── src/
│   └── index.ts          # Semua logika bot (1 file: bot + db + hifi client + PNG + scheduler)
├── config.json           # Konfigurasi (BOT_TOKEN di sini) — jangan commit token asli
├── data.db               # SQLite database (auto-create)
├── start.sh              # Start script VPS (disable core dump)
├── package.json
└── README.md
```

---

## 🧪 Self-Check

```bash
bun run src/index.ts --check
```
Validasi: parse limit (`10gb`, `100mb`, `1.5gb`), format GB, konversi MB/GB, render PNG chart (signature buffer + ukuran).

---

## 🤝 Kontribusi

Issue & PR terbuka. Untuk bug API (401/403), sertakan log `[hifi]` dan header yang dipakai.

## 📜 License

MIT — lihat [LICENSE](LICENSE). © 2026 dirzzr
