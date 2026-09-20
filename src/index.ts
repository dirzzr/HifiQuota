// HifiQuota - Bot Telegram cek kuota HiFi Air Indosat
// ponytail: 1 file saja (bot+db+hifi+scheduler). Stdlib + bun:sqlite + telegraf + cron. No ORM, no axios.
import { Telegraf, Markup } from "telegraf";
import { Database } from "bun:sqlite";
import { CronJob } from "cron";
import fs from "fs";
// ponytail: HyeHost 128MB — matikan core dump biar nggak 1GB tiap crash, hapus core lama
try{ for(const f of fs.readdirSync(".")) if(f==="core" || f.startsWith("core.") || f.startsWith("core-")) try{ fs.unlinkSync(f); console.log(`[cleanup] hapus ${f}`);}catch{} }catch{}
try{ (await import("bun")).spawnSync?.(["bash","-c","ulimit -c 0 2>/dev/null; echo 0 > /proc/sys/kernel/core_uses_pid 2>/dev/null || true"]); }catch{}
process.on("uncaughtException", e=> console.error("[uncaught]", (e as Error).message));
process.on("unhandledRejection", e=> console.error("[unhandled]", e));

// ---- auto-update (ponytail: cek GitHub di awal run — versi baru → checkout file kode + restart; config.json/.env/data.db lokal NGGAK disentuh biar BOT_TOKEN & data user selamat. Matikan via AUTO_UPDATE=0) ----
if (!process.argv.includes("--check") && process.env.AUTO_UPDATE !== "0") {
  try {
    const { execSync } = await import("child_process");
    const UPD = ".update-sha";
    const git = Bun.which("git");
    if (git && fs.existsSync(".git")) {
      console.log("[update] cek versi terbaru dari GitHub...");
      execSync(`"${git}" fetch origin main`, { stdio: "pipe", timeout: 20000 });
      const remote = execSync(`"${git}" rev-parse origin/main`, { stdio: "pipe" }).toString().trim();
      let local = "";
      try { local = fs.readFileSync(UPD, "utf8").trim(); } catch {}
      if (!local) local = execSync(`"${git}" rev-parse HEAD`, { stdio: "pipe" }).toString().trim();
      if (local !== remote) {
        console.log(`[update] versi baru ${local.slice(0,7)} → ${remote.slice(0,7)}, updating...`);
        const lockBefore = fs.existsSync("bun.lock") ? fs.readFileSync("bun.lock").toString() : "";
        // hanya file kode — file runtime lokal (token/data) tidak di-overwrite
        execSync(`"${git}" checkout origin/main -- src package.json bun.lock README.md LICENSE start.sh .gitignore config.example.json`, { stdio: "pipe" });
        fs.writeFileSync(UPD, remote);
        const lockAfter = fs.readFileSync("bun.lock").toString();
        if (lockBefore !== lockAfter) {
          console.log("[update] deps berubah — bun install...");
          try { Bun.spawnSync(["bun", "install"], { stdout: "inherit", stderr: "inherit" }); } catch {}
        }
        console.log("[update] ✅ versi baru terpasang — restart bot...");
        // pm2 restart otomatis kalau exit — spawn child di bawah pm2 bikin bot dobel
        if (process.env.pm_id) process.exit(0);
        Bun.spawn(["bun", "run", import.meta.path, ...process.argv.slice(2)], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
        process.exit(0);
      }
      console.log(`[update] ✅ sudah versi terbaru (${local.slice(0,7)})`);
    } else if (!fs.existsSync(".git")) console.log("[update] bukan git repo — skip auto-update");
  } catch (e: any) {
    console.warn(`[update] skip: ${String(e?.message ?? e).slice(0, 100)}`);
  }
}

// ---- config (ponytail: config.json paling ramah Ptero — file manager tinggal edit JSON, .env tetap fallback) ----
function loadConfig(): any {
  try { const c = JSON.parse(fs.readFileSync("config.json","utf-8")); if(c && c.BOT_TOKEN) return c; } catch {}
  return {};
}
const _cfg = loadConfig();
const _env = (k:string)=> (process.env as any)[k] ?? (_cfg as any)[k] ?? "";
const BOT_TOKEN = _env("BOT_TOKEN");
if (!BOT_TOKEN) throw new Error("BOT_TOKEN kosong — isi di config.json atau .env (lihat config.example.json)");
let HIFI_AUTH = _env("HIFI_AUTH");
let HIFI_TOKENID = _env("HIFI_TOKENID");
let HIFI_OAUTH = _env("HIFI_OAUTH");
let HIFI_UID = _env("HIFI_UID");
const BACKUP_CHAT_ID = _env("BACKUP_CHAT_ID") || "8580882469";

// ---- db (bun:sqlite built-in) ----
const db = new Database("data.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    chat_id TEXT PRIMARY KEY,
    msisdn TEXT NOT NULL,
    limit_mb INTEGER NOT NULL DEFAULT 10240,
    last_90_date TEXT,
    last_100_date TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    chat_id TEXT NOT NULL,
    date TEXT NOT NULL,
    remaining_mb REAL NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(chat_id,date)
  );
`);

// ponytail: migrate tambah kolom prediksi & 50% kalau belum ada
try{ db.exec("ALTER TABLE users ADD COLUMN last_prediksi_date TEXT"); }catch{}
try{ db.exec("ALTER TABLE users ADD COLUMN last_50_date TEXT"); }catch{}
// helper db
const getUserStmt = db.prepare("SELECT * FROM users WHERE chat_id = ?");
const upsertUserStmt = db.prepare(`
  INSERT INTO users(chat_id, msisdn, limit_mb, created_at) VALUES(?,?,?,?)
  ON CONFLICT(chat_id) DO UPDATE SET msisdn=excluded.msisdn
`);
const updateLimitStmt = db.prepare("UPDATE users SET limit_mb=? WHERE chat_id=?");
const updateReminder50Stmt = db.prepare("UPDATE users SET last_50_date=? WHERE chat_id=?");
const updateReminder90Stmt = db.prepare("UPDATE users SET last_90_date=? WHERE chat_id=?");
const updateReminder100Stmt = db.prepare("UPDATE users SET last_100_date=? WHERE chat_id=?");
const updatePrediksiStmt = db.prepare("UPDATE users SET last_prediksi_date=? WHERE chat_id=?");
const getSnapshotStmt = db.prepare("SELECT * FROM snapshots WHERE chat_id=? AND date=?");
const upsertSnapshotStmt = db.prepare(`
  INSERT INTO snapshots(chat_id,date,remaining_mb,created_at) VALUES(?,?,?,?)
  ON CONFLICT(chat_id,date) DO UPDATE SET remaining_mb=excluded.remaining_mb
`);
const allUsersStmt = db.prepare("SELECT * FROM users");

// ---- util ----
// ponytail: parse limit paling malas, regex saja
function parseLimit(input: string): number | null {
  const m = input.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(mb|gb)$/);
  if (!m) return null;
  const val = parseFloat(m[1]);
  const unit = m[2];
  return Math.round(unit === "gb" ? val * 1024 : val);
}
function formatGB(mb: number): string {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + " GB";
  return Math.round(mb) + " MB";
}
function toMB(val: string, unit: string): number {
  const n = parseFloat(val);
  if (unit.toLowerCase() === "gb") return n * 1024;
  return n; // MB
}
function todayWIB(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" }); // YYYY-MM-DD
}
function generateUID(): string {
  // ponytail: format interceptor 54734 = yyyyMMddHHmmssSSS + 3 random, biar lolos verifikasi
  const now = new Date();
  const pad = (n: number, l=2) => String(n).padStart(l,"0");
  const y=now.getFullYear(), mo=pad(now.getMonth()+1), d=pad(now.getDate());
  const h=pad(now.getHours()), mi=pad(now.getMinutes()), s=pad(now.getSeconds());
  const ms=String(now.getMilliseconds()).padStart(3,"0");
  const rand=Math.floor(100+Math.random()*900).toString();
  return `${y}${mo}${d}${h}${mi}${s}${ms}${rand}`;
}
// ponytail: RC4 hex dari 81975:F , key ftth default — dipakai untuk encrypt msisdn & Authorization
function rc4Hex(data:any, key:string):string{
  const str = String(data ?? "");
  if(!str) return "";
  let a=key||"ftth"; const o=256; let r:number[]=[],t:number[]=[];
  for(let e=0;e<o;e++){let n=a.charCodeAt(e%a.length); t[e]=n; r[e]=e;}
  let g=0; for(let e=0;e<o;e++){g=(g+r[e]+t[e])%o; let n=r[e]; r[e]=r[g]; r[g]=n;}
  let s=""; for(var l=0,d=0,c=0,u=0;u<str.length;u++){d=(d+r[l=(l+1)%o])%o; var p=r[l]; r[l]=r[d]; r[d]=p; c=r[(r[l]+r[d])%o]; var h=str.charCodeAt(u)^c; s+=String.fromCharCode(h);}
  let f=""; for(let i=0;i<s.length;i++){let m=s.charCodeAt(i).toString(16); if(m.length==1) m="0"+m; f+=m;} return f;
}
function saltFromToken(token:string):string{
  const t=token||"012345678909876543210"; let out=""; for(let n=0;n<t.length;){out+=t[n]; n+=2;} return out;
}
async function sha512Hex(str:string):Promise<string>{
  // ponytail: pakai Web Crypto / Bun native, fallback ke crypto
  try{
    const enc=new TextEncoder().encode(str);
    const buf=await crypto.subtle.digest("SHA-512", enc);
    return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
  }catch{
    const {createHash}=await import("crypto");
    return createHash("sha512").update(str).digest("hex");
  }
}
function normalizeMsisdn(input:any):string{
  const raw = String(input ?? "").trim().replace(/[\s\-]/g,"");
  if(!raw) return "";
  // ponytail: dukung 08..., +62..., 62..., 8... semua → 62...
  if(/^0\d+/.test(raw)) return "62"+raw.slice(1);
  if(/^\+\d+/.test(raw)) return raw.slice(1);
  if(/^8\d+/.test(raw)) return "62"+raw;
  return raw;
}
function encryptMsisdn(input:any):string{
  const t=String(input ?? "").trim();
  if(!t) throw new Error("MSISDN kosong");
  // sudah hash RC4 (hex 20-64, genap) — jangan double encrypt
  if(/^[a-f0-9]{20,64}$/i.test(t) && t.length%2===0) return t.toLowerCase();
  const norm=normalizeMsisdn(t);
  if(!norm || !/^\d{8,16}$/.test(norm)) throw new Error(`MSISDN invalid: ${input} -> ${norm}`);
  return rc4Hex(norm, "ftth");
}
function expiryToStr(exp: any): string {
  const s = String(exp ?? "").trim();
  if (s.length === 8 && /^\d{8}$/.test(s)) return `${s.slice(6,8)}-${s.slice(4,6)}-${s.slice(0,4)}`;
  if (!s) return "-";
  return s;
}
function daysLeft(exp: any): number {
  const s = String(exp ?? "").trim();
  if (!s || s.length!==8 || !/^\d{8}$/.test(s)) return 0;
  const y = parseInt(s.slice(0,4)), m = parseInt(s.slice(4,6))-1, d = parseInt(s.slice(6,8));
  const expiry = new Date(y,m,d);
  if(isNaN(expiry.getTime())) return 0;
  const now = new Date(new Date().toLocaleString("en-US", {timeZone:"Asia/Jakarta"}));
  const diff = Math.ceil((expiry.getTime() - now.getTime())/86400000);
  return isNaN(diff) ? 0 : diff;
}

// ---- hifi client VPS-friendly (tanpa browser) — 4 langkah dari andrianey/hifi-air-quota ----
const BASE_URL_SALES = "https://isaleshifiapi.ioh.co.id";
const BASE_URL_HIFI = "https://hifi.ioh.co.id";
const DEFAULT_TOKEN = "012345678909876543210";
const DEVICE_ID = "werwerpoopip34i5pip353323";
const PROJECT_ID = "101";
const CAT_ID = "1";
const API_CHANNEL = "HIFI_AIR_PWA";
// ponytail: anti-ban — cache guest token & rate limit (HACS pakai tiap request, kita cache 30m biar hemat)
let cachedGuestToken: string | null = null;
let guestTokenExp = 0;
let lastRequestAt = 0;
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36",
];
function randomUA(){ return UA_POOL[Math.floor(Math.random()*UA_POOL.length)]; }

async function hifiHeaders(body: any, token?: string, xAppOs: string = "website"): Promise<Record<string,string>> {
  const t = token ?? HIFI_TOKENID ?? DEFAULT_TOKEN;
  const auth = HIFI_AUTH || rc4Hex("website|ftth", "1234");
  const salt = saltFromToken(t);
  const oauth = await sha512Hex("REQBODY="+JSON.stringify(body)+"&SALT="+salt);
  return {
    "Accept": "*/*",
    "Accept-Language": "en",
    "Authorization": auth,
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
    "Origin": BASE_URL_HIFI,
    "Referer": "https://hifi.ioh.co.id/topup-hifiair",
    "User-Agent": randomUA(),
    "X-APP-OS": xAppOs,
    "X-DEVICEID": DEVICE_ID,
    "X-IMI-APP-CHANNEL": "website",
    "X-IMI-CHANNEL": "website",
    "X-IMI-LANGUAGE": "ID",
    "X-IMI-TOKENID": t,
    "X-IMI-UID": generateUID(),
    "x-imi-oauth": oauth,
  };
}
async function hifiPost(baseUrl: string, endpoint: string, body: any, token?: string, xAppOs?: string): Promise<{data:any, headers:Headers}> {
  // ponytail: rate limit & jitter biar nggak kena WAF — jeda 120-400ms tiap request, max 1 req/500ms global
  const now = Date.now();
  const since = now - lastRequestAt;
  if(since < 500) await new Promise(r=> setTimeout(r, 500 - since + Math.random()*200));
  await new Promise(r=> setTimeout(r, 120 + Math.random()*280));
  lastRequestAt = Date.now();
  const url = baseUrl + endpoint;
  const bodyStr = JSON.stringify(body);
  const headers = await hifiHeaders(body, token, xAppOs);
  // cookie untuk lewati TS
  const cookie = await getFreshCookie();
  if(cookie) (headers as any)["Cookie"] = cookie;
  const res = await fetch(url, { method:"POST", headers, body: bodyStr });
  const text = await res.text();
  let data:any;
  try{ data = JSON.parse(text); }catch{ throw new Error(`HTTP ${res.status}: ${text.slice(0,300)}`); }
  // update token jika ada di response header (auto refresh tanpa browser)
  const newTok = res.headers.get("x-imi-tokenid") || res.headers.get("X-IMI-TOKENID");
  if(newTok && newTok.length>20 && newTok!==HIFI_TOKENID){
    HIFI_TOKENID = newTok;
    updateEnvFile({ HIFI_TOKENID: newTok });
    console.log(`[hifi] token auto-update ${mask(newTok)} dari ${endpoint}`);
  }
  return {data, headers: res.headers};
}

// ponytail: full otomatis VPS — 4 langkah tanpa browser, token di-rotate tiap request via header
async function fetchQuota(msisdnInput: string) {
  const msisdnEnc = encryptMsisdn(msisdnInput);
  console.log(`[fetch] ${new Date().toISOString()} in=${mask(msisdnInput)} enc=${mask(msisdnEnc)} VPS flow`);
  let token: string | undefined = HIFI_TOKENID || undefined;
  // Langkah 1: guest token — cache 30 menit biar hemat & anti-ban (HACS tiap poll, kita cache)
  try{
    if(cachedGuestToken && Date.now() < guestTokenExp){
      token = cachedGuestToken;
      HIFI_TOKENID = token;
      console.log(`[hifi] guest token cache ${mask(token)}`);
    } else {
      const guestBody:any = {};
      const r1 = await hifiPost(BASE_URL_SALES, "/api/v4/token/guest", guestBody, DEFAULT_TOKEN, "web");
      if(r1.data?.status==="0" && r1.data?.data?.token){
        token = r1.data.data.token;
        HIFI_TOKENID = token;
        cachedGuestToken = token;
        guestTokenExp = Date.now() + 30*60*1000; // 30m
        console.log(`[hifi] guest token baru ${mask(token)}`);
      } else {
        // fallback: pakai token dari header jika ada
        console.log("[hifi] guest token skip status", r1.data?.status);
      }
    }
  }catch(e){ console.warn("[hifi] guest token skip", (e as Error).message); }
  // Langkah 2: checkaltno — ponytail: kalau 209/10019 berarti bukan nomor HiFi Air, langsung throw biar user tau
  try{
    const r2 = await hifiPost(BASE_URL_HIFI, "/api/v4/onboarding/checkaltno", {msisdn: msisdnEnc}, token);
    const s2 = String(r2.data?.status ?? r2.data?.code ?? "");
    if(s2!=="0" && s2!=="26000"){
      const msg = r2.data?.message || r2.data?.msg || "checkaltno gagal";
      // 209 = bukan HiFi, 10019 = sementara ganggu — bedakan
      if(s2==="209" || /not for callplan/i.test(msg)) throw new Error(`Nomor bukan HiFi Air (${msg})`);
      if(s2==="10019") throw new Error(`Server Indosat sibuk (${msg}) — coba lagi 1 menit`);
      console.warn("[hifi] checkaltno", msg);
    }
  }catch(e){
    if(/bukan HiFi|sibuk/i.test((e as Error).message)) throw e;
    console.warn("[hifi] checkaltno fail", (e as Error).message);
  }
  // Langkah 3: validatecallplan
  try{
    const r3 = await hifiPost(BASE_URL_HIFI, "/api/hifiair/payment/validatecallplan", {msisdn: msisdnEnc, projectid: PROJECT_ID, catid: CAT_ID, pushnotificationid: null, api_channel: API_CHANNEL}, token);
    const s3 = String(r3.data?.status ?? "");
    if(s3!=="0" && s3!=="26000"){
      const msg = r3.data?.message || "validate gagal";
      if(/10019|sibuk/i.test(msg)) throw new Error(`Server Indosat sibuk (${msg}) — coba lagi`);
      console.warn("[hifi] validate", msg);
    }
    token = HIFI_TOKENID;
  }catch(e){
    if(/sibuk/i.test((e as Error).message)) throw e;
    console.warn("[hifi] validate fail", (e as Error).message);
  }
  // Langkah 4: quota details — coba v8 & v2, pilih yang balance >0 & paket aktif (Perdana vs 500GB)
  // ponytail: 085711813062 -> v2 35.5GB Perdana, 628956... -> v8 459GB — jangan hardcode urutan
  // ponytail: HAR 0895613315851 → isMigratedUser:true (false → 0.0 SUSPENDED), jadi coba true dulu
  const candidates: Array<{ep:string, body:any}> = [
    {ep:"/api/hifiair/payment/quota/details/v8", body:{msisdn: msisdnEnc, projectid: "102", catid: "2", isMigratedUser: true}},
    {ep:"/api/hifiair/payment/quota/details/v8", body:{msisdn: msisdnEnc, projectid: "102", catid: "2", isMigratedUser: false}},
    {ep:"/api/hifiair/payment/quota/details/v2", body:{msisdn: msisdnEnc, projectid: PROJECT_ID, catid: CAT_ID}},
  ];
  let best:any = null;
  let bestBal = -1;
  for(let retry=0; retry<2; retry++){
    for(const {ep, body} of candidates){
      try{
        const r = await hifiPost(BASE_URL_HIFI, ep, body, token);
        if(r.data?.code==="200" || r.data?.status==="0"){
          const balStr = r.data?.data?.accountInfo?.totalDataBalance ?? "0";
          const bal = parseFloat(balStr);
          const pkgs = r.data?.data?.packages ?? [];
          const hasActive = pkgs.some((p:any)=> parseFloat(p.packageRemainingQuota)>0.01);
          console.log(`[hifi] ${ep} balance=${balStr} hasActive=${hasActive} (retry ${retry})`);
          // pilih yang balance terbesar & ada paket aktif
          if((!isNaN(bal) && bal > bestBal && (hasActive || pkgs.length===0)) || (!best && bal>=0)){
            best = r.data;
            bestBal = bal;
          }
          // kalau sudah dapat yang bagus (>0 & aktif), jangan break langsung — coba semua biar dapat max
          if(r.data?.code==="200" && hasActive && bal>0) continue;
        } else {
          const code = String(r.data?.code);
          console.warn(`[hifi] quota ${ep} fail code=${code} ${r.data?.message}`);
          if(["10001","10002","401","403"].includes(code) && retry===0){
            token = HIFI_TOKENID;
            await new Promise(res=> setTimeout(res, 800));
            break;
          }
        }
      }catch(e){
        console.warn(`[hifi] quota ${ep} err`, (e as Error).message);
        if(retry===0 && /1000(1|2)/.test((e as Error).message)) break;
      }
    }
    if(best && bestBal>0) {
      console.log(`[hifi] pilih best balance=${bestBal}`);
      return best;
    }
    if(retry===0){
      await getFreshCookie();
      token = HIFI_TOKENID;
      continue;
    }
  }
  if(best) return best;
  throw new Error("quota semua endpoint gagal (auto header retry habis)");
}

function parseQuotaData(apiJson: any) {
  const info = apiJson.data.accountInfo;
  const pkgs: any[] = apiJson.data.packages ?? [];
  const todayNum = parseInt(new Date().toLocaleDateString("en-CA", {timeZone:"Asia/Jakarta"}).replace(/-/g,""));
  const isActive = (p:any) => parseFloat(p.packageRemainingQuota) > 0.01 && parseInt(p.packageExpiryDate || (p as any).expiryDate || "99999999") >= todayNum;
  let activePkgs = pkgs.filter(isActive);
  const pool = activePkgs.length ? activePkgs : pkgs;
  let main = pool.length ? pool.reduce((a,b)=> parseFloat(a.packageRemainingQuota) > parseFloat(b.packageRemainingQuota) ? a : b) : null;
  if(main && parseFloat(main.packageRemainingQuota)===0 && main.quotas?.[0]){
    const q = main.quotas[0];
    if(parseFloat(q.remainingQuota)>0) main = {...main, packageRemainingQuota: q.remainingQuota, packageRemainingQuotaUnit: q.remainingQuotaUnit};
  }
  // ponytail: akumulasi MB/GB benar — sum semua paket (handle MB+GB campur)
  let sumInitialMb = 0, sumRemainingMb = 0;
  for(const p of pkgs){
    sumInitialMb += toMB(p.packageInitialQuota ?? "0", p.packageInitialQuotaUnit || p.packageQuotaUnit || "GB");
    sumRemainingMb += toMB(p.packageRemainingQuota ?? "0", p.packageRemainingQuotaUnit || p.packageQuotaUnit || "GB");
  }
  // fallback ke quotas detail jika package level 0 tapi quotas ada
  if(sumRemainingMb===0){
    for(const p of pkgs) for(const q of (p.quotas||[])){
      sumInitialMb += toMB(q.initialQuota ?? "0", q.initialQuotaUnit || q.quotaUnit || "GB");
      sumRemainingMb += toMB(q.remainingQuota ?? "0", q.remainingQuotaUnit || q.quotaUnit || "GB");
    }
    // kalau double count, pakai yang lebih besar antara sum package vs sum quotas
    // ponytail: simple — pakai totalDataBalance dari accountInfo sebagai source of truth akumulasi
  }
  const totalMb = toMB(info.totalDataBalance, info.quotaUnit); // akumulasi resmi dari server
  const remainingMb = sumRemainingMb>0 ? sumRemainingMb : totalMb; // pakai sum paket kalau ada, fallback totalDataBalance
  const initialMb = sumInitialMb>0 ? sumInitialMb : totalMb;
  const pkgType = /perdana/i.test(main?.packageName||"") ? "Perdana" : /spesial/i.test(main?.packageName||"") ? "Bonus" : "HiFi";
  return {
    totalMb, remainingMb, initialMb,
    sumInitialMb, sumRemainingMb,
    expiry: (info.expiryDate as string) || main?.packageExpiryDate || "",
    status: info.accountStatus as string,
    packageName: main?.packageName ?? (pkgs[0]?.packageName ?? "HiFi Air"),
    packageType: pkgType,
    allPackages: pkgs,
    activePackages: activePkgs,
    mainPackage: main,
  };
}

function calcDailyUsage(chatId: string, currentRemainingMb: number): number {
  const today = todayWIB();
  const snap = getSnapshotStmt.get(chatId, today) as any;
  if (!snap) return 0;
  const used = snap.remaining_mb - currentRemainingMb;
  return used < 0 ? 0 : used;
}
// ponytail: riwayat & prediksi — pakai snapshots, akurat 7 hari, MB+GB via toMB sudah
function getRiwayat(chatId: string, days: number): Array<{date:string, remainingMb:number, usedMb:number}> {
  const rows = db.prepare("SELECT date, remaining_mb FROM snapshots WHERE chat_id=? ORDER BY date DESC LIMIT ?").all(chatId, days) as any[];
  // urut ASC biar hitung pakai = prev - curr
  rows.reverse();
  const out: Array<{date:string, remainingMb:number, usedMb:number}> = [];
  for(let i=0;i<rows.length;i++){
    const cur = rows[i];
    const prev = i>0 ? rows[i-1] : null;
    const used = prev ? Math.max(0, prev.remaining_mb - cur.remaining_mb) : 0;
    out.push({date: cur.date, remainingMb: cur.remaining_mb, usedMb: used});
  }
  return out;
}
function getPrediksi(chatId: string, remainingMb: number, expiry: string): {avg:number, daysHabis:number, daysExpiry:number, willHabisStr:string, status:string}{
  const hist = getRiwayat(chatId, 7);
  // ambil used yang valid (>0), kalau baru 1 hari pakai used hari ini dari snapshot
  const usedVals = hist.map(h=>h.usedMb).filter(v=>v>0.01);
  let avg = 0;
  if(usedVals.length>=3) avg = usedVals.slice(-7).reduce((a,b)=>a+b,0)/usedVals.length;
  else if(usedVals.length>0) avg = usedVals.reduce((a,b)=>a+b,0)/usedVals.length;
  else {
    // fallback pakai last snapshot vs current
    const today = todayWIB();
    const snap = getSnapshotStmt.get(chatId, today) as any;
    if(snap) avg = Math.max(0, snap.remaining_mb - remainingMb);
  }
  // kalau avg 0 (baru ganti paket), pakai sisa/30 sebagai estimasi
  if(avg < 1) {
    const est = remainingMb / 30;
    if(est>avg) avg = est;
  }
  const daysHabis = avg>0 ? remainingMb / avg : 999;
  const daysExpiry = daysLeft(expiry);
  let willHabisStr = "";
  let status = "";
  if(daysHabis < daysExpiry){
    const d = new Date(); d.setDate(d.getDate()+Math.ceil(daysHabis));
    willHabisStr = `${Math.ceil(daysHabis)} hari (${d.toLocaleDateString("id-ID",{timeZone:"Asia/Jakarta"})})`;
    status = daysHabis < 3 ? "🔴 Habis <3 hari!" : daysHabis < 7 ? "🟡 Habis seminggu" : "✅ Aman";
  } else {
    willHabisStr = `Expiry dulu ${daysExpiry} hari`;
    status = "✅ Expiry dulu";
  }
  return {avg, daysHabis, daysExpiry, willHabisStr, status};
}
function formatRiwayat(chatId: string, days:number): string {
  const hist = getRiwayat(chatId, days);
  if(hist.length===0) return "📭 Belum ada riwayat. Bot simpan snapshot tiap 00:00 WIB.";
  const lines: string[] = [];
  lines.push(`📜 *Riwayat ${days} hari*`);
  lines.push("");

  // Build visual chart
  const remainingVals = hist.map(h => h.remainingMb);
  const usedVals = hist.map(h => h.usedMb);
  const maxVal = Math.max(...remainingVals, ...usedVals, 1);

  lines.push("📈 *Grafik Sisa Kuota:*");
  lines.push("```");
  for (let i = 0; i < hist.length; i++) {
    const bar = asciiBar(hist[i].remainingMb, maxVal, 15);
    lines.push(`${hist[i].date} ${bar}`);
  }
  lines.push("```");

  lines.push("");
  lines.push("📊 *Detail Harian:*");
  for(const h of hist){
    const usedBar = h.usedMb > 0 ? "█".repeat(Math.max(1, Math.round((h.usedMb/maxVal)*4))) : "";
    lines.push(`${h.date} | sisa: ${formatGB(h.remainingMb).padStart(8)} | pakai: ${formatGB(h.usedMb).padStart(8)} ${usedBar}`);
  }

  const validUsed = hist.filter(h=>h.usedMb>0);
  const avg = validUsed.length ? validUsed.reduce((a,b)=>a+b.usedMb,0) / validUsed.length : 0;
  const totalUsed = hist.reduce((a,b)=>a+b.usedMb,0);
  lines.push("");
  lines.push(`📈 *Statistik ${days} hari:*`);
  lines.push(`   Total pakai: ${formatGB(totalUsed)}`);
  lines.push(`   Rata-rata/hari: ${formatGB(avg)}`);
  lines.push(`   Trend: ${hist.length >= 2 ? (hist[hist.length-1].usedMb > hist[0].usedMb ? "📈 Meningkat" : hist[hist.length-1].usedMb < hist[0].usedMb ? "📉 Menurun" : "➡️ Stabil") : "baru"}`);

  // Sparkline
  if (usedVals.length >= 2) {
    lines.push(`   Sparkline: ${miniChart(usedVals, maxVal)}`);
  }
  return lines.join("\n");
}
function formatPrediksi(parsed: ReturnType<typeof parseQuotaData>, chatId:string): string {
  const p = getPrediksi(chatId, parsed.remainingMb, parsed.expiry);
  const expStr = expiryToStr(parsed.expiry);
  const user = getUserStmt.get(chatId) as any;
  const limit = user?.limit_mb ?? 10240;
  const initialPct = parsed.initialMb ? Math.round((parsed.remainingMb / parsed.initialMb) * 100) : 0;

  let lines: string[] = [];
  lines.push(`🔮 *Prediksi Kuota*`);
  lines.push("");
  lines.push(`📦 *${parsed.packageName}* (${parsed.packageType})`);
  lines.push("");
  lines.push(asciiBar(parsed.remainingMb, parsed.initialMb, 20));
  lines.push("");
  lines.push(`📊 *Analisis:*`);
  lines.push(`   Sisa: ${formatGB(parsed.remainingMb)} / ${formatGB(parsed.initialMb)} (${initialPct}%)`);
  lines.push(`   Avg 7 hari: ${formatGB(p.avg)}/hari`);
  lines.push(`   Limit harian: ${formatGB(limit)}`);
  lines.push("");
  lines.push(`🔮 *Perkiraan:*`);
  lines.push(`   Habis kuota: ${p.willHabisStr} ${p.status}`);
  lines.push(`   Expiry: ${expStr} (${p.daysExpiry} hari)`);
  lines.push("");

  // Trend indicator
  const hist = getRiwayat(chatId, 7);
  if (hist.length >= 2) {
    const first = hist[0].usedMb;
    const last = hist[hist.length-1].usedMb;
    const trendEmoji = last > first * 1.2 ? "📈" : last < first * 0.8 ? "📉" : "➡️";
    lines.push(`   Trend penggunaan: ${trendEmoji} ${hist.length} hari data`);
    if (hist.length >= 3) {
      const recentAvg = hist.slice(-3).reduce((a,b)=>a+b.usedMb,0) / 3;
      const olderAvg = hist.slice(0,3).reduce((a,b)=>a+b.usedMb,0) / 3;
      lines.push(`   Avg minggu lalu: ${formatGB(olderAvg)}/hari | Avg minggu ini: ${formatGB(recentAvg)}/hari`);
    }
  }
  return lines.join("\n");
}
function formatSummary(chatId:string, parsed: ReturnType<typeof parseQuotaData>): string {
  const hist = getRiwayat(chatId, 7);
  const validUsed = hist.filter(h=>h.usedMb>0);
  const totalUsed7 = hist.reduce((a,b)=>a+b.usedMb,0);
  const avg = validUsed.length ? totalUsed7 / validUsed.length : 0;
  const p = getPrediksi(chatId, parsed.remainingMb, parsed.expiry);
  const user = getUserStmt.get(chatId) as any;
  const limit = user?.limit_mb ?? 10240;
  const dailyUsed = calcDailyUsage(chatId, parsed.remainingMb);
  const dailyPct = Math.round((dailyUsed / limit) * 100);

  let lines: string[] = [];
  lines.push(`📊 *Dashboard Ringkasan*`);
  lines.push("");
  lines.push(`Halo ${user?.msisdn?.slice(0,6)}… | Limit: ${formatGB(limit)}/hari`);
  lines.push("");

  // Quota bar
  const quotaPct = parsed.initialMb ? Math.round((parsed.remainingMb / parsed.initialMb) * 100) : 0;
  lines.push(asciiBar(parsed.remainingMb, parsed.initialMb, 20));
  lines.push("");

  // Daily usage
  lines.push(`📅 *Hari Ini*`);
  const dailyBar = Math.max(0, Math.min(10, Math.round((dailyUsed / limit) * 10)));
  const dailyColor = dailyUsed > limit ? "🔴" : dailyUsed >= limit*0.9 ? "🟡" : "🟢";
  lines.push(`${dailyColor} [${"▓".repeat(dailyBar)}${"░".repeat(10-dailyBar)}] ${formatGB(dailyUsed)} / ${formatGB(limit)} (${dailyPct}%)`);
  lines.push("");

  // Weekly stats
  lines.push(`📅 *Minggu Ini (7 hari)*`);
  lines.push(`   Total pakai: ${formatGB(totalUsed7)}`);
  lines.push(`   Rata-rata/hari: ${formatGB(avg)}`);
  lines.push(`   Prediksi habis: ${p.willHabisStr} ${p.status}`);
  lines.push("");
  lines.push(`📦 *${parsed.packageName}* (${parsed.packageType})`);
  lines.push(`   Expiry: ${expiryToStr(parsed.expiry)} (${p.daysExpiry} hari) | Status: ${parsed.status}`);
  return lines.join("\n");
}

function formatReply(parsed: ReturnType<typeof parseQuotaData>, dailyUsedMb: number, limitMb: number): string {
  const pct = parsed.initialMb ? Math.round((parsed.remainingMb / parsed.initialMb) * 100) : 0;
  const usedBar = dailyUsedMb > limitMb ? "🔴" : dailyUsedMb >= limitMb * 0.9 ? "🟡" : "✅";
  const expStr = expiryToStr(parsed.expiry);
  const dLeft = daysLeft(parsed.expiry);

  // ponytail: handle SUSPENDED biar jelas bukan 0MB bug
  if(parsed.status === "SUSPENDED"){
    let lines: string[] = [];
    lines.push(`⛔ *Akun SUSPENDED*`);
    lines.push("");
    lines.push(`📦 ${parsed.packageName} (${parsed.packageType})`);
    lines.push("");
    lines.push(asciiBar(parsed.remainingMb, parsed.initialMb, 20));
    lines.push("");
    lines.push(`⚠️ *Status: SUSPENDED*`);
    lines.push(`Hubungi 0815-9001515 atau cek tagihan di hifi.ioh.co.id/topup-hifiair`);
    lines.push(`Exp: ${expStr} (${dLeft} hari)`);
    lines.push(``);
    const dailyBar = Math.max(0, Math.min(10, Math.round((dailyUsedMb / limitMb) * 10)));
    lines.push(`📅 Pakai hari ini: ${formatGB(dailyUsedMb)} / ${formatGB(limitMb)} ${usedBar}`);
    lines.push(`[${"▓".repeat(dailyBar)}${"░".repeat(10-dailyBar)}]`);
    return lines.join("\n");
  }

  let lines: string[] = [];
  lines.push(`📡 *${parsed.packageName}* (${parsed.packageType})`);
  lines.push("");

  // Visual quota bar
  lines.push(asciiBar(parsed.remainingMb, parsed.initialMb, 20));
  lines.push("");

  // Daily usage with visual bar
  const dailyPct = Math.round((dailyUsedMb / limitMb) * 100);
  const dailyBar = Math.max(0, Math.min(10, Math.round((dailyUsedMb / limitMb) * 10)));
  lines.push(`📅 *Hari Ini*`);
  lines.push(`${usedBar} [${"▓".repeat(dailyBar)}${"░".repeat(10-dailyBar)}] ${formatGB(dailyUsedMb)} / ${formatGB(limitMb)} (${dailyPct}%)`);

  // Warning messages
  if (dailyUsedMb > limitMb) lines.push(`⚠️ *Over limit harian!*`);
  else if (dailyUsedMb >= limitMb*0.9) lines.push(`⚠️ *Mendekati limit (90%)*`);
  lines.push("");

  // Package info
  lines.push(`📦 *Info Paket*`);
  lines.push(`Sisa: ${formatGB(parsed.remainingMb)} / ${formatGB(parsed.initialMb)} (${pct}%)`);
  lines.push(`Exp: ${expStr} (${dLeft} hari lagi)`);
  lines.push(`Status: ${parsed.status}`);

  if (parsed.allPackages.length > 1) {
    lines.push(`📋 ${parsed.allPackages.length} paket (${parsed.activePackages.length} aktif) — /cekpaket untuk detail`);
  } else if (parsed.activePackages?.length === 0 && parsed.allPackages.length) {
    lines.push(`\n⚠️ *Tidak ada paket aktif dengan kuota >0*`);
  }

  return lines.join("\n");
}
function formatPaketList(parsed: ReturnType<typeof parseQuotaData>): string {
  const lines: string[] = [];
  lines.push(`📦 *Daftar Paket (${parsed.allPackages.length})* — ${parsed.packageName} (${parsed.packageType})`);
  lines.push("");
  lines.push(asciiBar(parsed.remainingMb, parsed.initialMb, 20));
  lines.push("");
  lines.push(`📅 Exp akun: ${expiryToStr(parsed.expiry)} (${daysLeft(parsed.expiry)} hari) | Status: ${parsed.status}`);
  lines.push("");

  for(let idx=0; idx<parsed.allPackages.length; idx++){
    const p:any = parsed.allPackages[idx];
    const rMb = toMB(p.packageRemainingQuota ?? "0", p.packageRemainingQuotaUnit || p.packageQuotaUnit || "GB");
    const tMb = toMB(p.packageInitialQuota ?? "0", p.packageInitialQuotaUnit || p.packageQuotaUnit || "GB");
    const pct = tMb? Math.round(rMb/tMb*100):0;
    const exp = expiryToStr(p.packageExpiryDate || p.expiryDate || "");
    const left = daysLeft(p.packageExpiryDate || p.expiryDate || "");
    const periodVal = (p.packagePeriod && p.packagePeriod!=="0" ? p.packagePeriod : (p.quotas?.[0]?.period || "-"));

    // Visual bar for each package
    const isActive = rMb > 0;
    const statusEmoji = isActive ? (pct > 50 ? "🟢" : pct > 20 ? "🟡" : "🔴") : "⚪";

    lines.push(`${statusEmoji} *${idx+1}. ${p.packageName}*`);
    lines.push(`   ${asciiBar(rMb, tMb, 15)}`);
    lines.push(`   Exp: ${exp} (${left} hari) | Period: ${periodVal} hari`);

    const qDetail = (p.quotas||[]).map((q:any)=>{
      const qr = toMB(q.remainingQuota ?? "0", q.remainingQuotaUnit || q.quotaUnit || "GB");
      const qt = toMB(q.initialQuota ?? "0", q.initialQuotaUnit || q.quotaUnit || "GB");
      const qPct = qt ? Math.round(qr/qt*100) : 0;
      const qEmoji = qPct > 50 ? "🟢" : qPct > 20 ? "🟡" : "🔴";
      return `   ${qEmoji} └ ${q.name}: ${formatGB(qr)}/${formatGB(qt)} (${qPct}%) exp ${expiryToStr(q.expiryDate)} (${q.period || "-"} hari)`;
    }).join("\n");
    if(qDetail) lines.push(qDetail);
    if(p.smartAlerts?.length) lines.push(`   ⚠️ ${p.smartAlerts.map((a:any)=>a.rule).join(", ")}`);
  }
  if(parsed.activePackages.length===0) lines.push("\n⚠️ *Tidak ada paket aktif dengan kuota >0*");
  return lines.join("\n");
}

// ---- header refresh helpers ----
function mask(s: string): string { if (!s) return "-"; return s.slice(0,6)+"…"+s.slice(-4); }
function updateEnvFile(updates: Record<string,string>) {
  // ponytail: tulis ke .env (fallback) + config.json (utama Ptero) biar persist
  try{
    let content = "";
    try { content = fs.readFileSync(".env", "utf-8"); } catch { content = ""; }
    for (const [k,v] of Object.entries(updates)) {
      const re = new RegExp(`^${k}=.*`, "m");
      if (re.test(content)) content = content.replace(re, `${k}=${v}`);
      else content += `\n${k}=${v}`;
    }
    fs.writeFileSync(".env", content.trim()+"\n");
  }catch{}
  try{
    if(fs.existsSync("config.json")){
      const cfg = JSON.parse(fs.readFileSync("config.json","utf-8"));
      Object.assign(cfg, updates);
      fs.writeFileSync("config.json", JSON.stringify(cfg, null, 2));
    }
  }catch{}
  if (updates.HIFI_AUTH) HIFI_AUTH = updates.HIFI_AUTH;
  if (updates.HIFI_TOKENID) HIFI_TOKENID = updates.HIFI_TOKENID;
  if (updates.HIFI_OAUTH) HIFI_OAUTH = updates.HIFI_OAUTH;
  if (updates.HIFI_UID) HIFI_UID = updates.HIFI_UID;
}
function headerExpiredError(msg: string): boolean {
  return /401|403|10001|10002|unauthorized|expired|invalid.*token|oauth|verifikasi|otentifikasi/i.test(msg);
}
// ponytail: cookie jar minimal untuk lewati Imperva TS — GET dulu ambil TS cookie, pakai di POST
let cachedCookie = "";
async function getFreshCookie(): Promise<string> {
  try {
    const r = await fetch("https://hifi.ioh.co.id/topup-hifiair", { headers: { "User-Agent": "Mozilla/5.0" } });
    const cookies = (r.headers as any).getSetCookie?.() ?? [];
    if (cookies.length) {
      cachedCookie = cookies.map((c:string)=> c.split(";")[0]).join("; ");
      return cachedCookie;
    }
    const sc = r.headers.get("set-cookie") ?? "";
    if (sc) { cachedCookie = sc.split(",").map(s=> s.split(";")[0].trim()).join("; "); return cachedCookie; }
  } catch {}
  return cachedCookie;
}
// ponytail: loading bertahap — edit pesan + bar, VPS-friendly (nggak spam)
// Rich visual progress bar with color indicators
function progressBar(pct:number): string {
  const filled = Math.round(pct/10);
  const color = pct < 30 ? "🔴" : pct < 70 ? "🟡" : "🟢";
  return `${color} ${"▓".repeat(filled)}${"░".repeat(10-filled)} ${pct}%`;
}
// ASCII bar chart untuk visualisasi MB/GB
function asciiBar(current: number, total: number, width: number = 20): string {
  const ratio = total > 0 ? current / total : 0;
  const pct = ratio * 100;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const empty = width - filled;
  const color = pct < 30 ? "🔴" : pct < 70 ? "🟡" : "🟢";
  return `${color} [${"█".repeat(filled)}${"░".repeat(empty)}] ${formatGB(current)}/${formatGB(total)} (${Math.round(pct)}%)`;
}
// Mini chart untuk riwayat harian (sparkline-style)
function miniChart(values: number[], max: number, width: number = 10): string {
  if (!values.length) return "belum ada data";
  const blocks = "▁▂▃▄▅▆▇█";
  return values.map(v => {
    const idx = Math.min(7, Math.round((v / max) * 7));
    return blocks[idx];
  }).join("");
}

// ---- PNG chart generator (ponytail: pure JS PNG encode + font 5x7 bitmap, Bun.deflateSync — zero dep baru, aman VPS 128MB) ----
type Col = [number, number, number];
const F57: Record<string, number[]> = {
  "A":[0x0E,0x11,0x11,0x1F,0x11,0x11,0x11],"B":[0x1E,0x11,0x11,0x1E,0x11,0x11,0x1E],"C":[0x0E,0x11,0x10,0x10,0x10,0x11,0x0E],
  "D":[0x1E,0x11,0x11,0x11,0x11,0x11,0x1E],"E":[0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F],"F":[0x1F,0x10,0x10,0x1E,0x10,0x10,0x10],
  "G":[0x0E,0x11,0x10,0x17,0x11,0x11,0x0F],"H":[0x11,0x11,0x11,0x1F,0x11,0x11,0x11],"I":[0x0E,0x04,0x04,0x04,0x04,0x04,0x0E],
  "J":[0x07,0x02,0x02,0x02,0x02,0x12,0x0C],"K":[0x11,0x12,0x14,0x18,0x14,0x12,0x11],"L":[0x10,0x10,0x10,0x10,0x10,0x10,0x1F],
  "M":[0x11,0x1B,0x15,0x15,0x11,0x11,0x11],"N":[0x11,0x11,0x19,0x15,0x13,0x11,0x11],"O":[0x0E,0x11,0x11,0x11,0x11,0x11,0x0E],
  "P":[0x1E,0x11,0x11,0x1E,0x10,0x10,0x10],"Q":[0x0E,0x11,0x11,0x11,0x15,0x12,0x0D],"R":[0x1E,0x11,0x11,0x1E,0x14,0x12,0x11],
  "S":[0x0F,0x10,0x10,0x0E,0x01,0x01,0x1E],"T":[0x1F,0x04,0x04,0x04,0x04,0x04,0x04],"U":[0x11,0x11,0x11,0x11,0x11,0x11,0x0E],
  "V":[0x11,0x11,0x11,0x11,0x11,0x0A,0x04],"W":[0x11,0x11,0x11,0x15,0x15,0x15,0x0A],"X":[0x11,0x11,0x0A,0x04,0x0A,0x11,0x11],
  "Y":[0x11,0x11,0x0A,0x04,0x04,0x04,0x04],"Z":[0x1F,0x01,0x02,0x04,0x08,0x10,0x1F],
  "0":[0x0E,0x11,0x13,0x15,0x19,0x11,0x0E],"1":[0x04,0x0C,0x04,0x04,0x04,0x04,0x0E],"2":[0x0E,0x11,0x01,0x02,0x04,0x08,0x1F],
  "3":[0x1F,0x02,0x04,0x02,0x01,0x11,0x0E],"4":[0x02,0x06,0x0A,0x12,0x1F,0x02,0x02],"5":[0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E],
  "6":[0x06,0x08,0x10,0x1E,0x11,0x11,0x0E],"7":[0x1F,0x01,0x02,0x04,0x08,0x08,0x08],"8":[0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E],
  "9":[0x0E,0x11,0x11,0x0F,0x01,0x02,0x0C]," ":[0,0,0,0,0,0,0],".":[0,0,0,0,0,0x0C,0x0C],",":[0,0,0,0,0x0C,0x04,0x08],
  "-":[0,0,0,0x1F,0,0,0],":":[0,0x0C,0x0C,0,0x0C,0x0C,0],"/":[0x01,0x01,0x02,0x04,0x08,0x10,0x10],
  "%":[0x19,0x1A,0x02,0x04,0x08,0x0B,0x13],"?":[0x0E,0x11,0x01,0x06,0x04,0,0x04],"!":[0x04,0x04,0x04,0x04,0x04,0,0x04],
  ">":[0x04,0x08,0x10,0x10,0x10,0x08,0x04],"(":[0x02,0x04,0x08,0x08,0x08,0x04,0x02],")":[0x08,0x04,0x02,0x02,0x02,0x04,0x08],
};
const CRC_T = (()=>{ const t=new Uint32Array(256); for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c = c&1 ? 0xEDB88320 ^ (c>>>1) : c>>>1; t[n]=c>>>0; } return t; })();
function crc32b(buf: Uint8Array, from: number, to: number): number {
  let c=0xFFFFFFFF;
  for(let i=from;i<to;i++) c = CRC_T[(c^buf[i])&0xFF] ^ (c>>>8);
  return (c^0xFFFFFFFF)>>>0;
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12+data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for(let i=0;i<4;i++) out[4+i]=type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8+data.length, crc32b(out,4,8+data.length));
  return out;
}
function pngEncode(w:number,h:number,rgba:Uint8Array): Buffer {
  const raw = new Uint8Array(h*(1+w*4));
  for(let y=0;y<h;y++){ raw[y*(1+w*4)]=0; raw.set(rgba.subarray(y*w*4,(y+1)*w*4), y*(1+w*4)+1); }
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0,w); new DataView(ihdr.buffer).setUint32(4,h);
  ihdr[8]=8; ihdr[9]=6; // 8-bit RGBA
  const parts = [
    new Uint8Array([137,80,78,71,13,10,26,10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array((Bun as any).deflateSync(raw))),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((a,p)=>a+p.length,0));
  let o=0; for(const p of parts){ out.set(p,o); o+=p.length; }
  return Buffer.from(out);
}
class MiniCanvas {
  w:number; h:number; px:Uint8Array;
  constructor(w:number,h:number,bg:Col){ this.w=w; this.h=h; this.px=new Uint8Array(w*h*4); this.fillRect(0,0,w,h,bg); }
  set(x:number,y:number,c:Col){ if(x<0||y<0||x>=this.w||y>=this.h) return; const i=(y*this.w+x)*4; this.px[i]=c[0]; this.px[i+1]=c[1]; this.px[i+2]=c[2]; this.px[i+3]=255; }
  fillRect(x:number,y:number,w:number,h:number,c:Col){ const x1=Math.max(0,Math.floor(x)), y1=Math.max(0,Math.floor(y)); const x2=Math.min(this.w,Math.ceil(x+w)), y2=Math.min(this.h,Math.ceil(y+h)); for(let yy=y1;yy<y2;yy++) for(let xx=x1;xx<x2;xx++) this.set(xx,yy,c); }
  textWidth(t:string,s:number){ return t.length*6*s - s; }
  drawText(x:number,y:number,t:string,c:Col,s:number=2){ let cx=x; for(const ch of t.toUpperCase()){ const g=F57[ch] ?? F57["?"]; for(let r=0;r<7;r++){ const bits=g[r]; if(!bits) continue; for(let col=0;col<5;col++) if((bits>>(4-col))&1) this.fillRect(cx+col*s, y+r*s, s, s, c); } cx += 6*s; } return cx-x; }
  drawTextRight(xRight:number,y:number,t:string,c:Col,s:number=2){ this.drawText(xRight-this.textWidth(t,s), y, t, c, s); }
  hline(x1:number,x2:number,y:number,c:Col,t:number=1){ for(let i=0;i<t;i++) for(let x=x1;x<x2;x++) this.set(x,y+i,c); }
  hlineDashed(x1:number,x2:number,y:number,c:Col,dash=10,gap=8,thick=2){ let x=x1; while(x<x2){ const xe=Math.min(x+dash,x2); for(let yy=0;yy<thick;yy++) for(let xx=x;xx<xe;xx++) this.set(xx,y+yy,c); x+=dash+gap; } }
  toPng(): Buffer { return pngEncode(this.w,this.h,this.px); }
}
// pure render — hist + meta in, PNG buffer out (dipakai --check juga)
function renderChartPng(hist: Array<{date:string, remainingMb:number, usedMb:number}>, meta: {
  days:number, limitMb:number, remainingMb:number, initialMb:number, packageName:string, msisdnMask:string, avgMb:number, predStr:string
}): Buffer {
  const W=880, H=620;
  const BG:Col=[11,17,32];
  const cv = new MiniCanvas(W,H,BG);
  const WHITE:Col=[241,245,249], MUTED:Col=[148,163,184], GRID:Col=[30,41,59], CARD:Col=[20,31,51],
        GREEN:Col=[52,211,153], YELLOW:Col=[251,191,36], RED:Col=[248,113,113], BLUE:Col=[96,165,250],
        ACCENT:Col=[56,189,248];
  cv.fillRect(0,0,W,3,ACCENT);
  cv.drawText(28, 28, `GRAFIK PENGGUNAAN - ${meta.days} HARI`, WHITE, 3);
  cv.drawText(28, 66, `${meta.msisdnMask}  ${meta.packageName}`, MUTED, 2);
  cv.drawTextRight(W-28, 66, `LIMIT ${formatGB(meta.limitMb)}/HARI`, MUTED, 2);
  const cx1=120, cx2=W-50, cy1=120, cy2=430;
  if(hist.length===0){
    cv.drawText((W-cv.textWidth("BELUM ADA DATA RIWAYAT",3))/2, 220, "BELUM ADA DATA RIWAYAT", WHITE, 3);
    cv.drawText((W-cv.textWidth("SNAPSHOT OTOMATIS TIAP 00:00 WIB",2))/2, 260, "SNAPSHOT OTOMATIS TIAP 00:00 WIB", MUTED, 2);
  } else {
    const raw = Math.max(...hist.map(x=>x.usedMb), meta.limitMb, 1);
    const niceMax = Math.max(1024, Math.ceil(raw/1024)*1024);
    const yOf = (v:number)=> cy2 - (v/niceMax)*(cy2-cy1);
    for(let t=0;t<=4;t++){
      const v = niceMax*t/4, y = Math.round(yOf(v));
      cv.hline(cx1, cx2, y, GRID, 1);
      cv.drawTextRight(cx1-12, y-6, formatGB(v), MUTED, 1);
    }
    const cw = cx2-cx1, slot = cw/hist.length, barW = Math.min(slot*0.6, 44);
    hist.forEach((h,i)=>{
      const r = meta.limitMb>0 ? h.usedMb/meta.limitMb : 0;
      const baseC:Col = r>=0.9 ? RED : r>=0.5 ? YELLOW : GREEN;
      const bx = cx1 + i*slot + (slot-barW)/2;
      const by = Math.round(yOf(h.usedMb));
      const bh = cy2-by;
      const bw = Math.round(barW);
      const bxp = Math.round(bx);
      for(let yy=by; yy<cy2; yy++){
        const yDist = (yy-by)/bh;
        const alpha = 1 - yDist*0.35;
        const c:Col = [
          Math.round(baseC[0]*alpha + BG[0]*(1-alpha)),
          Math.round(baseC[1]*alpha + BG[1]*(1-alpha)),
          Math.round(baseC[2]*alpha + BG[2]*(1-alpha))
        ];
        cv.fillRect(bxp, yy, bw, 1, c);
      }
      const rad = Math.min(6, bw/2, bh/2);
      for(let yy=by; yy<by+rad; yy++){
        const yOff = yy-by;
        const xOff = Math.round(Math.sqrt(rad*rad - yOff*yOff));
        cv.fillRect(bxp + xOff, yy, bw - 2*xOff, 1, baseC);
      }
      if(slot>=75) cv.drawText(Math.round(bxp+bw/2-cv.textWidth(formatGB(h.usedMb),2)/2), by-18, formatGB(h.usedMb), MUTED, 2);
    });
    const step = Math.ceil(hist.length*36/cw) || 1;
    for(let i=0;i<hist.length;i+=step){
      const bx = cx1 + i*slot + slot/2;
      cv.drawText(Math.round(bx-cv.textWidth(hist[i].date.slice(5),1)/2), cy2+12, hist[i].date.slice(5), MUTED, 1);
    }
    const yLim = Math.round(yOf(Math.min(meta.limitMb, niceMax)));
    cv.hlineDashed(cx1, cx2, yLim, RED, 12, 10, 2);
    cv.drawTextRight(cx2-6, yLim-20, `LIMIT ${formatGB(meta.limitMb)}`, RED, 2);
    const yAvg = Math.round(yOf(Math.min(meta.avgMb, niceMax)));
    cv.hline(cx1, cx2, yAvg, BLUE, 2);
    cv.drawText(cx1+8, yAvg-20, `AVG ${formatGB(meta.avgMb)}/HARI`, BLUE, 2);
    cv.hline(cx1, cx2, cy2, [51,65,85], 2);
    cv.hline(cx1, cx1+4, cy2-4, [51,65,85], 2);
  }
  const cardY=460, cardH=96, cardW=(W-2*28-3*14)/4, total = hist.reduce((a,b)=>a+b.usedMb,0);
  const remPct = meta.initialMb>0 ? meta.remainingMb/meta.initialMb : 0;
  const remCol:Col = remPct>0.3?GREEN:remPct>0.1?YELLOW:RED;
  const cards:[string,string,Col][] = [
    ["TOTAL PAKAI", formatGB(total), BLUE],
    ["RATA-RATA/HARI", formatGB(meta.avgMb), BLUE],
    ["SISA KUOTA", formatGB(meta.remainingMb), remCol],
    ["PREDIKSI HABIS", meta.predStr, remPct>0.3?GREEN:YELLOW],
  ];
  cards.forEach(([label,val,acc],i)=>{
    const x = 28 + i*(cardW+14);
    cv.fillRect(x, cardY, cardW, cardH, CARD);
    cv.fillRect(x, cardY, 4, cardH, acc);
    cv.fillRect(x, cardY+cardH-2, cardW, 2, acc);
    cv.drawText(x+16, cardY+18, label, MUTED, 1.8);
    cv.drawText(x+16, cardY+56, val, WHITE, 3.2);
  });
  cv.drawText(28, H-20, "HIFIQUOTA", [51,65,85], 1.2);
  cv.drawTextRight(W-28, H-20, new Date().toLocaleString("id-ID",{timeZone:"Asia/Jakarta"}), [51,65,85], 1);
  return cv.toPng();
}
// wrapper: ambil data user dari DB + live fetch (opsional), render PNG
function generateChartPng(chatId:string, days:number, parsed:ReturnType<typeof parseQuotaData>|null): Buffer {
  const hist = getRiwayat(chatId, days);
  const user = getUserStmt.get(chatId) as any;
  const limitMb = user?.limit_mb ?? 10240;
  const remainingMb = parsed?.remainingMb ?? (hist.length? hist[hist.length-1].remainingMb : 0);
  const initialMb = parsed?.initialMb ?? Math.max(remainingMb, hist[0]?.remainingMb ?? 0);
  const usedVals = hist.map(h=>h.usedMb).filter(v=>v>0.01);
  const avgMb = usedVals.length ? usedVals.reduce((a,b)=>a+b,0)/usedVals.length : 0;
  const pred = parsed ? getPrediksi(chatId, parsed.remainingMb, parsed.expiry) : null;
  const predStr = pred ? (pred.daysHabis<900 ? `${Math.ceil(pred.daysHabis)} HARI` : ">30 HARI") : "-";
  return renderChartPng(hist, {
    days, limitMb, remainingMb, initialMb,
    packageName: (parsed?.packageName ?? "HIFI AIR").toUpperCase(),
    msisdnMask: String(user?.msisdn ?? "-").slice(0,6)+"..."+String(user?.msisdn ?? "").slice(-4),
    avgMb, predStr
  });
}
async function startProgress(ctx:any, title:string){
  const chatId = String(ctx.chat.id);
  // ponytail: braille + titik step-by-step — timer 400ms independen dari step, busy flag cegah overlap, plain text aman parse
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let curText = title, curPct = 5, frame = 0, busy = false, finished = false;
  const render = ()=> `${frames[frame % frames.length]} ${curText}${".".repeat((frame % 3) + 1)}\n${progressBar(curPct)}`;
  const msg = await ctx.reply(`⏳ ${render()}`);
  const timer = setInterval(async ()=>{
    if(finished || busy) return;
    busy = true; frame++;
    try{ await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, `⏳ ${render()}`); }catch{}
    busy = false;
  }, 400);
  const stop = ()=>{ finished = true; clearInterval(timer); };
  // simpan id biar bisa edit
  return {
    chatId,
    msgId: msg.message_id,
    update: async (text:string, pct:number)=>{
      curText = text; curPct = pct;
      try{ await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, `⏳ ${render()}`); }catch{}
    },
    done: async (finalText:string, extra?:any)=>{
      stop();
      try{ await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, finalText, { parse_mode: "Markdown", ...extra } as any); }catch{
        await ctx.reply(finalText, { parse_mode:"Markdown", ...extra });
      }
    },
    fail: async (err:string, extra?:any)=>{
      stop();
      // ponytail: error dinamis jangan pakai Markdown — 1 char `_*/[` dari API bikin edit gagal & user kira stuck
      try{ await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, `❌ ${err}`, extra as any); }catch{
        try{ await ctx.reply(`❌ ${err}`, extra); }catch{}
      }
    }
  };
}
// ponytail: HyeHost 128MB — browser dimatikan, Chromium butuh 300MB+ → OOM core 1GB. VPS flow 4 langkah sudah auto tanpa browser.
async function autoRefreshToken(_msisdn: string): Promise<boolean> {
  console.log("[autoRefresh] skip browser (HyeHost), pakai VPS flow 4 langkah");
  return false;
}
// ponytail: Bot API 9.4 button style — Telegraf 4.16 belum punya, tempel field manual (extra field lolos ke API). primary=biru aksi utama, danger=merah destruktif
function btn(text: string, data: string, style?: "primary" | "danger" | "success") {
  return style ? { ...Markup.button.callback(text, data), style } : Markup.button.callback(text, data);
}
function mainKeyboard() {
  return Markup.inlineKeyboard([
    [btn("🎛 Dashboard", "dashboard", "primary"), btn("📊 Cek Kuota", "cekkuota", "success")],
    [btn("📦 Cek Paket", "cekpaket"), btn("📜 Riwayat", "riwayat_7")],
    [btn("🔮 Prediksi", "prediksi", "success"), btn("📊 Summary", "summary")],
    [btn("📈 Status", "status"), btn("⚙️ Set Limit", "setlimit_info")],
    [btn("🔄 Ganti MSISDN", "gantimsisdn_info", "danger"), btn("🔑 Refresh Headers", "refresh_headers", "danger")],
    [btn("❓ Help", "help")],
  ]);
}
function menuFullKeyboard(){
  return Markup.inlineKeyboard([
    [btn("🎛 Dashboard", "dashboard", "primary"), btn("📊 Cek Kuota", "cekkuota", "success")],
    [btn("📦 Cek Paket", "cekpaket"), btn("📜 Riwayat 7h", "riwayat_7"), btn("📜 14h", "riwayat_14"), btn("📜 28h", "riwayat_28")],
    [btn("📜 30h", "riwayat_30"), btn("🔮 Prediksi", "prediksi", "success"), btn("📊 Summary", "summary")],
    [btn("📈 Status", "status"), btn("🖼 Grafik", "grafik_7", "success"), btn("⚙️ Set Limit", "setlimit_info")],
    [btn("🔄 Ganti Nomor", "gantimsisdn_info", "danger"), btn("🔑 Refresh Token", "refresh_headers", "danger"), btn("❓ Help", "help")],
    [btn("🏠 Menu", "menu")],
  ]);
}
function riwayatKeyboard(){
  return Markup.inlineKeyboard([
    [btn("7 hari", "riwayat_7"), btn("14 hari", "riwayat_14")],
    [btn("28 hari", "riwayat_28"), btn("30 hari", "riwayat_30")],
    [btn("📊 Grafik 7h", "grafik_7", "success"), btn("📊 Grafik 30h", "grafik_30", "success")],
  ]);
}
function grafikKeyboard(){
  return Markup.inlineKeyboard([
    [btn("📊 7 hari", "grafik_7"), btn("📊 14 hari", "grafik_14"), btn("📊 30 hari", "grafik_30")],
    [btn("🎛 Dashboard", "dashboard", "primary"), btn("🏠 Menu", "menu")],
  ]);
}
function headersKeyboard() {
  return Markup.inlineKeyboard([
    [btn("📋 Lihat Headers", "view_headers"), btn("🔄 Update Headers", "update_headers", "danger")],
    [btn("📖 Cara Ambil Headers", "headers_howto")],
  ]);
}

// ---- self-check early (ponytail: skip bot launch when --check) ----
if (process.argv.includes("--check")) {
  console.assert(parseLimit("10gb") === 10240, "parse 10gb");
  console.assert(parseLimit("100mb") === 100, "parse 100mb");
  console.assert(parseLimit("1.5gb") === 1536, "parse 1.5gb");
  console.assert(formatGB(10240) === "10.0 GB", "format");
  console.assert(toMB("460.4","GB") === 460.4*1024, "toMB");
  // chart png smoke test
  const sample = [
    {date:"2026-08-29", remainingMb: 45000, usedMb: 1200},
    {date:"2026-08-30", remainingMb: 43800, usedMb: 1100},
    {date:"2026-08-31", remainingMb: 42700, usedMb: 950},
    {date:"2026-09-01", remainingMb: 41600, usedMb: 800},
    {date:"2026-09-02", remainingMb: 40500, usedMb: 1024},
    {date:"2026-09-03", remainingMb: 39400, usedMb: 1500},
    {date:"2026-09-04", remainingMb: 38100, usedMb: 1300},
  ];
  const buf = renderChartPng(sample, {
    days: 7, limitMb: 10240, remainingMb: 38100, initialMb: 46000,
    packageName: "HIFI AIR", msisdnMask: "628xxx...5851", avgMb: 1100, predStr: "32 HARI"
  });
  console.assert(Buffer.isBuffer(buf) && buf.length > 1000, "png buffer ok");
  // signature check: PNG header 8 byte
  const sig = [137,80,78,71,13,10,26,10];
  let okSig = buf.length >= 8;
  for(let i=0;i<8 && okSig;i++) okSig = buf[i] === sig[i];
  console.assert(okSig, "png signature valid");
  console.log("self-check OK");
  process.exit(0);
}

// ---- HTTP health check for UptimeRobot ----
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "3000", 10);
const healthServer = Bun.serve({
  port: HEALTH_PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(JSON.stringify({
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        bot: "HifiQuota"
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("Not Found", { status: 404 });
  }
});
console.log(`[health] HTTP server listening on port ${HEALTH_PORT} (GET /health)`);

// ---- bot ----
const bot = new Telegraf(BOT_TOKEN);
bot.catch((err, ctx)=>{ console.error(`[bot catch] ${ctx.updateType}`, err); });
await bot.telegram.setMyCommands([
  { command: "start", description: "Mulai & set MSISDN/hash" },
  { command: "menu", description: "Tampilkan menu button" },
  { command: "cekkuota", description: "Cek kuota akumulasi (MB+GB)" },
  { command: "cekpaket", description: "Lihat semua paket & sisa GB/MB" },
  { command: "riwayat", description: "Riwayat pakai 7/14/28/30 hari" },
  { command: "grafik", description: "Grafik PNG penggunaan 7/14/30 hari" },
  { command: "prediksi", description: "Prediksi habis kuota" },
  { command: "summary", description: "Ringkasan mingguan" },
  { command: "dashboard", description: "Dashboard visual lengkap dengan chart" },
  { command: "setlimit", description: "Set limit harian misal /setlimit 10gb" },
  { command: "status", description: "Lihat MSISDN & limit" },
  { command: "gantimsisdn", description: "Ganti MSISDN/hash" },
  { command: "setheaders", description: "Update headers HiFi (jika 401)" },
  { command: "viewheaders", description: "Lihat headers saat ini" },
  { command: "backup", description: "Kirim backup data.db (owner)" },
  { command: "help", description: "Bantuan & cara pakai" },
]);

// pending input state: chat_id -> "await_msisdn" | "await_headers_step1" etc
const pending = new Map<string, string>();
const pendingHeaderData = new Map<string, { auth?: string; tokenid?: string }>();

function isHash(s: string): boolean { return /^[a-f0-9]{20,64}$/i.test(s.trim()) && s.trim().length%2===0; }
function isPhone(s: string): boolean { return /^(\+?62|0)\d{8,15}$/.test(s.replace(/[\s\-]/g,"").trim()); }
// ponytail: validasi longgar — terima apapun >=8 char, bukan command. Strict 628/hash bikin false "format salah"
function isValidMsisdnInput(s: string): boolean { const t=s.trim(); return t.length>=8 && !t.startsWith("/"); }

bot.start(async (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = getUserStmt.get(chatId) as any;
  if (user) {
    await ctx.reply(
      `Halo lagi! 👋\nMSISDN: \`${user.msisdn}\`\nLimit: ${formatGB(user.limit_mb)}\n\n`+
      `Pilih menu di bawah atau ketik /menu:`,
      { parse_mode: "Markdown", ...menuFullKeyboard() }
    );
    return;
  }
  pending.set(chatId, "await_msisdn");
  await ctx.reply(
    `👋 Selamat datang di *HifiQuota* by ridhz\n\n`+
    `Kirim *hash customerid* (32 hex, contoh: \`7caa857288fcee5e8befab21e729\`)\n`+
    `Ambil dari DevTools → Network → payload \`msisdn\` saat buka https://hifi.ioh.co.id/topup-hifiair\n\n`+
    `Ketik hash sekarang:`,
    { parse_mode: "Markdown", ...menuFullKeyboard() }
  );
});
bot.command("menu", async (ctx)=>{
  const chatId=String(ctx.chat.id);
  const user=getUserStmt.get(chatId) as any;
  const info=user?`MSISDN: \`${user.msisdn}\` | Limit: ${formatGB(user.limit_mb)}`:"Belum set MSISDN — /start dulu";
  await ctx.reply(`🏠 *Menu HifiQuota*\n${info}\n\nPilih aksi:`, {parse_mode:"Markdown", ...menuFullKeyboard()});
});
bot.action("menu", async (ctx)=>{ await ctx.answerCbQuery(); const chatId=String(ctx.chat!.id); const user=getUserStmt.get(chatId) as any; const info=user?`MSISDN: \`${user.msisdn}\` | Limit: ${formatGB(user.limit_mb)}`:"Belum set MSISDN"; await ctx.reply(`🏠 *Menu*\n${info}`, {parse_mode:"Markdown", ...menuFullKeyboard()}); });

bot.command("help", async (ctx) => {
  await ctx.reply(
    `*🎛 HifiQuota Help*\n`+
    `\n`+
    `📊 *Cek Kuota & Monitoring*\n`+
    `/dashboard - dashboard visual lengkap dengan chart & trend\n`+
    `/cekkuota - cek akumulasi kuota (MB+GB auto)\n`+
    `/cekpaket - detail semua paket (sisa GB/MB & expiry)\n`+
    `/riwayat [7|14|28|30] - riwayat pakai harian dengan grafik\n`+
    `/grafik [7|14|30] - gambar PNG rekap penggunaan (avg, total, limit)\n`+
    `/prediksi - prediksi kapan kuota habis\n`+
    `/summary - ringkasan mingguan\n`+
    `\n`+
    `⚙️ *Pengaturan*\n`+
    `/setlimit 10gb - set limit harian (100mb, 10gb, 1.5gb)\n`+
    `/status - lihat MSISDN & limit & pemakaian hari ini\n`+
    `/gantimsisdn 7caa... - ganti hash/MSISDN\n`+
    `\n`+
    `🔑 *Headers (jika error 401/403)*\n`+
    `/setheaders - update headers HiFi\n`+
    `/viewheaders - lihat headers terpasang\n`+
    `\n`+
    `Hash = \`customerid\` 32 hex (bukan nomor HP). Ambil via DevTools → Network → quota/details/v8 → payload msisdn.\n`+
    `Default limit 10GB, auto cek tiap 30 menit, notif 50%/90%/100%.\n\n`+
    `*Tombol interaktif* tersedia di bawah tiap balasan. Ketik \`/\` untuk lihat semua command.`,
    { parse_mode: "Markdown", ...mainKeyboard() }
  );
});

// ---- header refresh commands ----
bot.command("viewheaders", async (ctx) => {
  await ctx.reply(
    `*Headers saat ini*\n`+
    `HIFI_AUTH: \`${mask(HIFI_AUTH)}\`\n`+
    `HIFI_TOKENID: \`${mask(HIFI_TOKENID)}\`\n`+
    `HIFI_OAUTH: \`${mask(HIFI_OAUTH)}\`\n`+
    `HIFI_UID: \`${HIFI_UID || "-"}\`\n\n`+
    `Jika /cekkuota error 401/403, pakai /setheaders untuk update.`,
    { parse_mode: "Markdown", ...headersKeyboard() }
  );
});

bot.command("setheaders", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  // mode 1: langsung 3 value spasi: /setheaders auth tokenid oauth
  if (args) {
    const parts = args.split(/\s+/);
    if (parts.length >= 3) {
      updateEnvFile({ HIFI_AUTH: parts[0], HIFI_TOKENID: parts[1], HIFI_OAUTH: parts[2] });
      await ctx.reply(`✅ Headers diupdate dari args.\nAUTH: \`${mask(parts[0])}\`\nTOKENID: \`${mask(parts[1])}\`\nOAUTH: \`${mask(parts[2])}\``, { parse_mode: "Markdown", ...mainKeyboard() });
      return;
    }
    // coba parse format key=value
    if (args.includes("HIFI_AUTH") || args.includes("=")) {
      const mAuth = args.match(/HIFI_AUTH[=:]\s*([a-f0-9]+)/i);
      const mToken = args.match(/HIFI_TOKENID[=:]\s*([A-Za-z0-9._\-]+)/);
      const mOauth = args.match(/HIFI_OAUTH[=:]?\s*([a-f0-9]+)/i) || args.match(/x-imi-oauth[=:]\s*([a-f0-9]+)/i);
      const upd: Record<string,string> = {};
      if (mAuth) upd.HIFI_AUTH = mAuth[1];
      if (mToken) upd.HIFI_TOKENID = mToken[1];
      if (mOauth) upd.HIFI_OAUTH = mOauth[1];
      if (Object.keys(upd).length) {
        updateEnvFile(upd);
        await ctx.reply(`✅ Headers diupdate (parsed).\n${Object.entries(upd).map(([k,v])=>`${k}: \`${mask(v)}\``).join("\n")}`, { parse_mode: "Markdown" });
        return;
      }
    }
  }
  // mode interaktif step-by-step
  const chatId = String(ctx.chat.id);
  pending.set(chatId, "await_headers_auth");
  pendingHeaderData.set(chatId, {});
  await ctx.reply(
    `🔑 *Update Headers* (step 1/3)\n\n`+
    `Kirim *Authorization* (contoh: \`722c13dc9a986271696f7438\`)\n`+
    `Ambil dari DevTools → Headers → Authorization\n`+
    `Ketik /cancel untuk batal.`,
    { parse_mode: "Markdown" }
  );
});

bot.command("refreshheaders", async (ctx) => {
  await ctx.reply(
    `*Cara ambil headers baru:*\n`+
    `1. Buka https://hifi.ioh.co.id/topup-hifiair (login)\n`+
    `2. F12 → Network → filter \`quota/details\`\n`+
    `3. Klik request → Headers → copy \`Authorization\`, \`X-IMI-TOKENID\`, \`x-imi-oauth\`\n`+
    `4. Jalankan /setheaders lalu paste satu-per-satu\n\n`+
    `Atau langsung: \`/setheaders AUTH TOKENID OAUTH\``,
    { parse_mode: "Markdown", ...headersKeyboard() }
  );
});

bot.command("cancel", async (ctx) => {
  const chatId = String(ctx.chat.id);
  pending.delete(chatId);
  pendingHeaderData.delete(chatId);
  await ctx.reply(`❌ Dibatalkan.`, mainKeyboard());
});

bot.command("gantimsisdn", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const args = (ctx.message.text.split(" ").slice(1).join(" ").trim());
  if (args) {
    if (!isValidMsisdnInput(args)) {
      await ctx.reply(`❌ Format salah. Kirim hash 32 hex atau 628...\nContoh: /gantimsisdn 7caa857288fcee5e8befab21e729`);
      return;
    }
    const now = new Date().toISOString();
    const existing = getUserStmt.get(chatId) as any;
    if (existing) {
      db.prepare("UPDATE users SET msisdn=?, last_50_date=NULL, last_90_date=NULL, last_100_date=NULL, last_prediksi_date=NULL WHERE chat_id=?").run(args.trim(), chatId);
      const today = todayWIB();
      db.prepare("DELETE FROM snapshots WHERE chat_id=? AND date=?").run(chatId, today);
    } else {
      upsertUserStmt.run(chatId, args.trim(), 10240, now);
    }
    pending.delete(chatId);
    await ctx.reply(`✅ MSISDN diganti: \`${args.trim()}\`\nSnapshot hari ini direset, /cekkuota lagi.`, { parse_mode: "Markdown" });
    return;
  }
  pending.set(chatId, "await_msisdn");
  await ctx.reply(`Kirim hash baru (32 hex) atau nomor 628...:`);
});

bot.command("setlimit", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = getUserStmt.get(chatId) as any;
  if (!user) { await ctx.reply(`Belum set MSISDN. /start dulu.`); return; }
  const raw = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!raw) {
    await ctx.reply(`Limit sekarang: *${formatGB(user.limit_mb)}*\nCara: /setlimit 10gb atau /setlimit 500mb`, {parse_mode:"Markdown"});
    return;
  }
  const mb = parseLimit(raw);
  if (mb === null || mb <= 0) {
    await ctx.reply(`❌ Format salah. Contoh: /setlimit 10gb, /setlimit 100mb, /setlimit 1.5gb`);
    return;
  }
  updateLimitStmt.run(mb, chatId);
  // reset reminder flag jika limit naik biar bisa notif lagi hari ini
  await ctx.reply(`✅ Limit harian diset: *${formatGB(mb)}*`, {parse_mode:"Markdown"});
});

async function handleCekKuota(ctx: any) {
  const chatId = String(ctx.chat.id);
  const user = getUserStmt.get(chatId) as any;
  if (!user) { await ctx.reply(`Belum set MSISDN. /start dulu.`, mainKeyboard()); return; }
  const prog = await startProgress(ctx, "Cek kuota — mengambil token");
  try {
    await prog.update("Mengambil token & Cookie", 20);
    // fetchQuota sudah include 4 langkah (guest→check→validate→quota) + auto header
    const json = await fetchQuota(user.msisdn);
    await prog.update("Menghitung pakai harian & akumulasi MB/GB", 65);
    const parsed = parseQuotaData(json);
    const today = todayWIB();
    const existingSnap = getSnapshotStmt.get(chatId, today) as any;
    // ponytail: fix snapshot 0 bug (isMigratedUser false → 0.0) — kalau snap 0 & now >0, update
    if (!existingSnap) upsertSnapshotStmt.run(chatId, today, parsed.remainingMb, new Date().toISOString());
    else if (existingSnap.remaining_mb === 0 && parsed.remainingMb > 0) {
      upsertSnapshotStmt.run(chatId, today, parsed.remainingMb, new Date().toISOString());
      console.log(`[fix] snapshot 0 → ${parsed.remainingMb} for ${chatId} ${today}`);
    }
    const dailyUsed = calcDailyUsage(chatId, parsed.remainingMb);
    await prog.update("Menyiapkan balasan", 85);
    await prog.done(formatReply(parsed, dailyUsed, user.limit_mb), mainKeyboard());
    const fresh = getUserStmt.get(chatId) as any;
    const limit = fresh.limit_mb as number;
    const pct50 = limit * 0.5;
    const pct90 = limit * 0.9;
    // ponytail: 50% warning juga, tapi tetap aman — cuma baca DB, nggak tambah hit API
    if (dailyUsed >= limit && fresh.last_100_date !== today) {
      await ctx.reply(`🔴 *Over limit!* ${formatGB(dailyUsed)} / ${formatGB(limit)} — kurangi pemakaian!`, { parse_mode: "Markdown" });
      updateReminder100Stmt.run(today, chatId);
      if (fresh.last_90_date !== today) updateReminder90Stmt.run(today, chatId);
      if ((fresh as any).last_50_date !== today) updateReminder50Stmt.run(today, chatId);
    } else if (dailyUsed >= pct90 && dailyUsed < limit && fresh.last_90_date !== today) {
      await ctx.reply(`🟡 *Hampir limit (90%)* ${formatGB(dailyUsed)} / ${formatGB(limit)} — hati-hati!`, { parse_mode: "Markdown" });
      updateReminder90Stmt.run(today, chatId);
    } else if (dailyUsed >= pct50 && dailyUsed < pct90 && (fresh as any).last_50_date !== today) {
      await ctx.reply(`🔵 *50% limit* ${formatGB(dailyUsed)} / ${formatGB(limit)} — setengah jalan!`, { parse_mode: "Markdown" });
      updateReminder50Stmt.run(today, chatId);
    }
  } catch (e: any) {
    console.error("[cekkuota]", e);
    const isAuth = headerExpiredError(e.message);
    const isBug = e instanceof RangeError || e instanceof TypeError;
    const hint = !isBug && isPhone(user.msisdn) ? `\n\n💡 Kamu pakai nomor 628..., tapi API butuh hash 32 hex. Coba /gantimsisdn dengan hash.` : "";
    const hdrHint = isAuth ? `\n\n🔑 *Headers expired!* Pakai /setheaders untuk refresh.` : "";
    await prog.fail(`Gagal cek kuota: ${e.message}${hint}${hdrHint}`, isAuth ? headersKeyboard() : mainKeyboard());
  }
}
async function handleCekPaket(ctx:any){
  const chatId = String(ctx.chat.id);
  const user = getUserStmt.get(chatId) as any;
  if(!user){ await ctx.reply("Belum set MSISDN. /start dulu.", mainKeyboard()); return; }
  const prog = await startProgress(ctx, "Cek paket — mengambil daftar paket");
  try{
    await prog.update("Mengambil token & paket", 30);
    const json = await fetchQuota(user.msisdn);
    await prog.update("Memformat daftar paket", 70);
    const parsed = parseQuotaData(json);
    const text = formatPaketList(parsed).replace(/\*/g, "").replace(/_/g, "\\_");
    await prog.update("Mengirim balasan", 90);
    if(text.length > 4000){
      await prog.done(text.slice(0,4000));
      const parts: string[] = [];
      let cur = "";
      for(const line of text.slice(4000).split("\n")){
        if((cur+line+"\n").length > 4000){ parts.push(cur); cur=line+"\n"; } else cur+=line+"\n";
      }
      if(cur) parts.push(cur);
      for(let i=0;i<parts.length;i++) await ctx.reply(parts[i], ...(i===parts.length-1?[mainKeyboard()]:[]));
    } else {
      await prog.done(text, mainKeyboard());
    }
  }catch(e:any){
    console.error("[cekpaket]", e);
    await prog.fail(`Gagal cek paket: ${e.message}`, mainKeyboard());
  }
}
async function handleRiwayat(ctx:any, days:number=7){
  const chatId=String(ctx.chat.id);
  const user=getUserStmt.get(chatId) as any;
  if(!user){ await ctx.reply("Belum set MSISDN. /start dulu.", mainKeyboard()); return; }
  const prog = await startProgress(ctx, `Riwayat ${days} hari — mengambil snapshot`);
  try{
    await prog.update("Mengambil snapshot terbaru", 30);
    try{ const j=await fetchQuota(user.msisdn); const p=parseQuotaData(j); const t=todayWIB(); if(!getSnapshotStmt.get(chatId,t)) upsertSnapshotStmt.run(chatId,t,p.remainingMb,new Date().toISOString()); }catch{}
    await prog.update("Menyusun tabel", 70);
    const txt=formatRiwayat(chatId, days);
    await prog.done(txt, riwayatKeyboard());
  }catch(e:any){ await prog.fail(`Gagal riwayat: ${e.message}`, mainKeyboard()); }
}
async function handlePrediksi(ctx:any){
  const chatId=String(ctx.chat.id);
  const user=getUserStmt.get(chatId) as any;
  if(!user){ await ctx.reply("Belum set MSISDN. /start dulu.", mainKeyboard()); return; }
  const prog = await startProgress(ctx, "Prediksi — menghitung avg 7 hari");
  try{
    await prog.update("Mengambil data terbaru", 35);
    const j=await fetchQuota(user.msisdn);
    const p=parseQuotaData(j);
    const t=todayWIB(); if(!getSnapshotStmt.get(chatId,t)) upsertSnapshotStmt.run(chatId,t,p.remainingMb,new Date().toISOString());
    await prog.update("Menghitung prediksi", 70);
    const txt=formatPrediksi(p, chatId);
    await prog.done(txt, mainKeyboard());
  }catch(e:any){ await prog.fail(`Gagal prediksi: ${e.message}`, mainKeyboard()); }
}
async function handleSummary(ctx:any){
  const chatId=String(ctx.chat.id);
  const user=getUserStmt.get(chatId) as any;
  if(!user){ await ctx.reply("Belum set MSISDN. /start dulu.", mainKeyboard()); return; }
  const prog = await startProgress(ctx, "Summary — merangkum 7 hari");
  try{
    await prog.update("Mengambil data", 30);
    const j=await fetchQuota(user.msisdn);
    const p=parseQuotaData(j);
    const t=todayWIB(); if(!getSnapshotStmt.get(chatId,t)) upsertSnapshotStmt.run(chatId,t,p.remainingMb,new Date().toISOString());
    await prog.update("Menyusun ringkasan", 70);
    const txt=formatSummary(chatId, p);
    await prog.done(txt, mainKeyboard());
  }catch(e:any){ await prog.fail(`Gagal summary: ${e.message}`, mainKeyboard()); }
}

// Dashboard handler (reusable for command & button)
async function handleDashboard(ctx:any){
  const chatId = String(ctx.chat.id);
  const user = getUserStmt.get(chatId) as any;
  if (!user) { await ctx.reply(`Belum set MSISDN. /start dulu.`, mainKeyboard()); return; }
  const prog = await startProgress(ctx, "Dashboard — memuat visualisasi");
  try {
    await prog.update("Mengambil data kuota", 30);
    const json = await fetchQuota(user.msisdn);
    const parsed = parseQuotaData(json);
    const dailyUsed = calcDailyUsage(chatId, parsed.remainingMb);
    const hist7 = getRiwayat(chatId, 7);
    const hist30 = getRiwayat(chatId, 30);
    await prog.update("Menyusun dashboard visual", 70);

    // Build rich dashboard
    const lines: string[] = [];
    lines.push(`🎛 *DASHBOARD HiFiQuota*`);
    lines.push("");
    lines.push(`👤 \`${user.msisdn}\` | Limit: ${formatGB(user.limit_mb)}/hari`);
    lines.push("");

    // === QUOTA SECTION ===
    lines.push(`━━━ 📦 *QUOTA UTAMA* ━━━`);
    lines.push(asciiBar(parsed.remainingMb, parsed.initialMb, 22));
    const quotaPct = parsed.initialMb ? Math.round((parsed.remainingMb / parsed.initialMb) * 100) : 0;
    lines.push(`   Sisa: ${formatGB(parsed.remainingMb)} / ${formatGB(parsed.initialMb)} (${quotaPct}%)`);
    lines.push(`   Paket: ${parsed.packageName} (${parsed.packageType})`);
    lines.push(`   Status: ${parsed.status} | Exp: ${expiryToStr(parsed.expiry)} (${daysLeft(parsed.expiry)} hari)`);
    lines.push("");

    // === DAILY USAGE ===
    lines.push(`━━━ 📅 *PAKAI HARI INI* ━━━`);
    const dailyPct = Math.round((dailyUsed / user.limit_mb) * 100);
    const dailyBar = Math.max(0, Math.min(10, Math.round((dailyUsed / user.limit_mb) * 10)));
    const dailyColor = dailyUsed > user.limit_mb ? "🔴" : dailyUsed >= user.limit_mb*0.9 ? "🟡" : "🟢";
    lines.push(`${dailyColor} [${"▓".repeat(dailyBar)}${"░".repeat(10-dailyBar)}] ${formatGB(dailyUsed)} / ${formatGB(user.limit_mb)} (${dailyPct}%)`);
    if (dailyUsed > user.limit_mb) lines.push(`   ⚠️ OVER LIMIT!`);
    else if (dailyUsed >= user.limit_mb*0.9) lines.push(`   ⚠️ Mendekati limit (90%)`);
    lines.push("");

    // === WEEKLY TREND CHART ===
    if (hist7.length > 0) {
      lines.push(`━━━ 📊 *TREND 7 HARI* ━━━`);
      lines.push("```");
      const maxVal = Math.max(...hist7.map(h => h.remainingMb), 1);
      for (const h of hist7) {
        const bar = asciiBar(h.remainingMb, maxVal, 18);
        lines.push(`${h.date.slice(5)} ${bar}`);
      }
      lines.push("```");
      lines.push("");
    }

    // === PACKAGE BREAKDOWN ===
    if (parsed.allPackages.length > 1) {
      lines.push(`━━━ 📋 *PAKET DETAIL* ━━━`);
      for (let i = 0; i < parsed.allPackages.length; i++) {
        const p = parsed.allPackages[i];
        const rMb = toMB(p.packageRemainingQuota ?? "0", p.packageRemainingQuotaUnit || p.packageQuotaUnit || "GB");
        const tMb = toMB(p.packageInitialQuota ?? "0", p.packageInitialQuotaUnit || p.packageQuotaUnit || "GB");
        const pct = tMb ? Math.round(rMb/tMb*100) : 0;
        const exp = expiryToStr(p.packageExpiryDate || p.expiryDate || "");
        const left = daysLeft(p.packageExpiryDate || p.expiryDate || "");
        const statusEmoji = rMb > 0 ? (pct > 50 ? "🟢" : pct > 20 ? "🟡" : "🔴") : "⚪";
        lines.push(`${statusEmoji} ${p.packageName}: ${formatGB(rMb)}/${formatGB(tMb)} (${pct}%) | ${exp} (${left} hari)`);
      }
      lines.push("");
    }

    // === PREDIKSI ===
    const p = getPrediksi(chatId, parsed.remainingMb, parsed.expiry);
    lines.push(`━━━ 🔮 *PREDIKSI* ━━━`);
    lines.push(`   Habis kuota: ${p.willHabisStr} ${p.status}`);
    lines.push(`   Rata-rata: ${formatGB(p.avg)}/hari`);
    lines.push(`   Expiry: ${expiryToStr(parsed.expiry)} (${p.daysExpiry} hari)`);
    lines.push("");

    // === SPARKLINE 30 HARI ===
    if (hist30.length >= 7) {
      const used30 = hist30.map(h => h.usedMb);
      const max30 = Math.max(...used30, 1);
      lines.push(`━━━ ✨ *SPARKLINE 30 HARI* ━━━`);
      lines.push(`   ${miniChart(used30, max30, 30)}`);
      lines.push(`   ▁▂▃▄▅▆▇█ = ${formatGB(max30)} MB`);
      lines.push("");
    }

    lines.push(`🔄 Update: ${new Date().toLocaleString("id-ID", {timeZone:"Asia/Jakarta"})}`);
    await prog.done(lines.join("\n"), mainKeyboard());
  } catch (e:any) {
    const isAuth = headerExpiredError(e.message);
    await prog.fail(`Gagal dashboard: ${e.message}${isAuth ? " — /setheaders" : ""}`, isAuth ? headersKeyboard() : mainKeyboard());
  }
}
bot.command("cekkuota", handleCekKuota);
bot.command("cekpaket", handleCekPaket);
bot.command("riwayat", async (ctx)=>{ const arg=ctx.message.text.split(/\s+/)[1]; const d=parseInt(arg)||7; const valid=[7,14,28,30].includes(d)?d:7; await handleRiwayat(ctx, valid); });
bot.command("grafik", async (ctx)=>{ const arg=ctx.message.text.split(/\s+/)[1]; const d=parseInt(arg)||7; const valid=[7,14,30].includes(d)?d:7; await handleGrafik(ctx, valid); });
bot.command("prediksi", handlePrediksi);
bot.command("summary", handleSummary);
bot.command("dashboard", handleDashboard);
bot.command("backup", async (ctx)=>{
  if (String(ctx.chat.id) !== BACKUP_CHAT_ID) { await ctx.reply("Backup hanya untuk owner bot."); return; }
  await ctx.reply("Membuat backup data.db...");
  const ok = await sendDailyBackup();
  await ctx.reply(ok ? "Backup terkirim." : "Backup gagal — cek log.");
});

async function handleGrafik(ctx:any, days:number=7){
  const chatId=String(ctx.chat.id);
  const user=getUserStmt.get(chatId) as any;
  if(!user){ await ctx.reply("Belum set MSISDN. /start dulu.", mainKeyboard()); return; }
  const prog = await startProgress(ctx, `Grafik ${days} hari — render PNG`);
  let parsed: ReturnType<typeof parseQuotaData> | null = null;
  try{
    await prog.update("Mengambil snapshot terbaru", 25);
    try{ const j=await fetchQuota(user.msisdn); parsed=parseQuotaData(j); const t=todayWIB(); if(!getSnapshotStmt.get(chatId,t)) upsertSnapshotStmt.run(chatId,t,parsed.remainingMb,new Date().toISOString()); }
    catch(e:any){ console.warn("[grafik] fetch gagal, pakai snapshot DB:", String(e?.message ?? e).slice(0,150)); }
    await prog.update("Render chart", 60);
    const png = generateChartPng(chatId, days, parsed);
    await prog.update("Mengirim grafik", 90);
    // ponytail: caption plain tanpa Markdown — nama paket dari API bisa pecahkan parse entities (400)
    const cap = `Grafik ${days} hari\nPaket: ${parsed?.packageName ?? "HiFi Air"} | Limit: ${formatGB(user.limit_mb)}/hari\nSisa: ${formatGB(parsed?.remainingMb ?? 0)} / ${formatGB(parsed?.initialMb ?? 0)}`;
    // akar stuck 90%: replyWithPhoto bisa hang selamanya di VPS murah -> bungkus timeout 20s + retry lebar + fallback document/teks
    const withTimeout = <T>(p:Promise<T>, ms:number, label:string):Promise<T> =>
      Promise.race([p, new Promise<T>((_,rej)=> setTimeout(()=>rej(new Error(label+" timeout "+ms+"ms")), ms))]);
    const retryableSend = (e:any)=>{
      const m = String(e?.message ?? e) + " " + String(e?.code ?? "");
      return /ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|socket|closed|timeout|timed out|retry|flood|429|408|500|502|503|504|bad gateway|service unavailable/i.test(m);
    };
    let sent = false; let lastErr:any=null;
    for(let r=0;r<5 && !sent;r++){
      try{
        await withTimeout(ctx.replyWithPhoto({ source: png, filename: `grafik-${days}.png` } as any, {
          caption: cap,
          ...grafikKeyboard(),
        }), 20000, "sendPhoto");
        sent=true; lastErr=null;
      }catch(e:any){
        lastErr=e;
        const retryable = retryableSend(e);
        console.warn(`[grafik] sendPhoto r=${r} ${String(e?.message ?? e).slice(0,150)} retryable=${retryable}`);
        if(!retryable) break;
        await new Promise(v=>setTimeout(v, 1000*(r+1)));
      }
    }
    if(!sent){
      // fallback 1: kirim sebagai dokumen (lebih toleran dari photo)
      try{
        await withTimeout(ctx.replyWithDocument({ source: png, filename: `grafik-${days}.png` } as any, {
          caption: cap, ...grafikKeyboard(),
        }), 20000, "sendDocument");
        sent=true; lastErr=null;
      }catch(e:any){ lastErr=e; console.warn("[grafik] sendDocument gagal:", String(e?.message ?? e).slice(0,150)); }
    }
    if(!sent) throw lastErr ?? new Error("kirim grafik gagal tanpa error");
    try{ await prog.done(`✅ Grafik ${days} hari terkirim`, grafikKeyboard()); }catch{}
  }catch(e:any){
    console.error("[grafik]", e);
    await prog.fail(`Gagal grafik: ${String(e?.message ?? e).slice(0,300)}`, mainKeyboard());
  }
}

bot.command("status", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = getUserStmt.get(chatId) as any;
  if (!user) { await ctx.reply(`Belum set MSISDN. /start dulu.`, mainKeyboard()); return; }
  const prog = await startProgress(ctx, "Status — mengambil info");
  try {
    await prog.update("Mengambil data akun", 40);
    const json = await fetchQuota(user.msisdn);
    const parsed = parseQuotaData(json);
    const dailyUsed = calcDailyUsage(chatId, parsed.remainingMb);
    const dLeft = daysLeft(parsed.expiry);
    await prog.done(
      `*Status*\nMSISDN: \`${user.msisdn}\`\nLimit: ${formatGB(user.limit_mb)}\n`+
      `Pakai hari ini: ${formatGB(dailyUsed)} (${Math.round(dailyUsed/user.limit_mb*100)}% dari limit)\n`+
      `Sisa kuota: ${formatGB(parsed.remainingMb)} / ${formatGB(parsed.initialMb)}\n`+
      `Exp: ${expiryToStr(parsed.expiry)} (${dLeft} hari)\n`+
      `Last 90% notif: ${user.last_90_date ?? "-"} | 100%: ${user.last_100_date ?? "-"}`,
      mainKeyboard()
    );
  } catch (e:any) {
    const isAuth = headerExpiredError(e.message);
    await prog.fail(`Gagal fetch: ${e.message}${isAuth ? " — /setheaders" : ""}`, isAuth ? headersKeyboard() : mainKeyboard());
  }
});

// handle text input untuk msisdn & headers pending
bot.on("text", async (ctx, next) => {
  const chatId = String(ctx.chat.id);
  const txt = ctx.message.text.trim();
  if (txt.startsWith("/")) return next();
  const state = pending.get(chatId);
  if (!state) return next();

  // ---- header refresh flow ----
  if (state === "await_headers_auth") {
    if (txt.length < 10) { await ctx.reply("❌ Authorization terlalu pendek, coba lagi:"); return; }
    const data = pendingHeaderData.get(chatId) ?? {};
    data.auth = txt;
    pendingHeaderData.set(chatId, data);
    pending.set(chatId, "await_headers_tokenid");
    await ctx.reply(`✅ AUTH disimpan \`${mask(txt)}\`\n\n*Step 2/3:* Kirim *X-IMI-TOKENID* (JWT panjang eyJ...)`, { parse_mode: "Markdown" });
    return;
  }
  if (state === "await_headers_tokenid") {
    if (txt.length < 20) { await ctx.reply("❌ TOKENID terlalu pendek, coba lagi:"); return; }
    const data = pendingHeaderData.get(chatId) ?? {};
    data.tokenid = txt;
    pendingHeaderData.set(chatId, data);
    pending.set(chatId, "await_headers_oauth");
    await ctx.reply(`✅ TOKENID disimpan \`${mask(txt)}\`\n\n*Step 3/3:* Kirim *x-imi-oauth* (hex 64 char, contoh 28ed0808...)`, { parse_mode: "Markdown" });
    return;
  }
  if (state === "await_headers_oauth") {
    if (txt.length < 10) { await ctx.reply("❌ OAUTH terlalu pendek, coba lagi:"); return; }
    const data = pendingHeaderData.get(chatId) ?? {};
    const auth = data.auth!, tokenid = data.tokenid!;
    updateEnvFile({ HIFI_AUTH: auth, HIFI_TOKENID: tokenid, HIFI_OAUTH: txt });
    pending.delete(chatId);
    pendingHeaderData.delete(chatId);
    await ctx.reply(`✅ *Headers diupdate & disimpan ke .env*\nAUTH: \`${mask(auth)}\`\nTOKENID: \`${mask(tokenid)}\`\nOAUTH: \`${mask(txt)}\`\n\nCoba /cekkuota sekarang.`, { parse_mode: "Markdown", ...mainKeyboard() });
    return;
  }
  if (state === "await_setlimit") {
    const mb = parseLimit(txt);
    if (mb === null) { await ctx.reply("❌ Format salah. Contoh: 10gb, 500mb, 1.5gb"); return; }
    const user = getUserStmt.get(chatId) as any;
    if (!user) { await ctx.reply("Belum set MSISDN. /start dulu."); pending.delete(chatId); return; }
    updateLimitStmt.run(mb, chatId);
    pending.delete(chatId);
    await ctx.reply(`✅ Limit diset: *${formatGB(mb)}*`, { parse_mode: "Markdown", ...mainKeyboard() });
    return;
  }

  // ---- msisdn flow ----
  if (state === "await_msisdn") {
    if (!isValidMsisdnInput(txt)) {
      await ctx.reply(`❌ Format salah. Kirim hash 32 hex atau nomor 628...`);
      return;
    }
    const now = new Date().toISOString();
    const existing = getUserStmt.get(chatId) as any;
    if (existing) {
      db.prepare("UPDATE users SET msisdn=?, last_50_date=NULL, last_90_date=NULL, last_100_date=NULL, last_prediksi_date=NULL WHERE chat_id=?").run(txt, chatId);
      const today = todayWIB();
      db.prepare("DELETE FROM snapshots WHERE chat_id=? AND date=?").run(chatId, today);
    } else upsertUserStmt.run(chatId, txt, 10240, now);
    pending.delete(chatId);
    await ctx.reply(`✅ MSISDN disimpan: \`${txt}\`\nLimit default 10GB. Snapshot direset.`, { parse_mode: "Markdown", ...mainKeyboard() });
    const today2 = todayWIB();
    if (!getSnapshotStmt.get(chatId, today2)) {
      try { const j = await fetchQuota(txt); const p = parseQuotaData(j); upsertSnapshotStmt.run(chatId, today2, p.remainingMb, now); } catch {}
    }
    return;
  }
  return next();
});

// ---- inline button handlers ----
bot.action("dashboard", (ctx) => { ctx.answerCbQuery().catch(() => {}); setImmediate(() => handleDashboard(ctx)); });
bot.action("cekkuota", (ctx) => { ctx.answerCbQuery().catch(() => {}); setImmediate(() => handleCekKuota(ctx)); });
bot.action("status", (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  setImmediate(async () => {
    const chatId = String(ctx.chat!.id);
    const user = getUserStmt.get(chatId) as any;
    if (!user) { await ctx.reply("Belum set MSISDN. /start dulu.", mainKeyboard()); return; }
    try {
      const j = await fetchQuota(user.msisdn); const p = parseQuotaData(j); const d = calcDailyUsage(chatId, p.remainingMb);
      await ctx.reply(formatReply(p, d, user.limit_mb), { parse_mode: "Markdown", ...mainKeyboard() });
    } catch (e:any) { await ctx.reply(`❌ ${e.message}`, headersKeyboard()); }
  });
});
bot.action("setlimit_info", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat!.id);
  const user = getUserStmt.get(chatId) as any;
  if (!user) { await ctx.reply("Belum set MSISDN. /start dulu."); return; }
  pending.set(chatId, "await_setlimit");
  await ctx.reply(`⚙️ *Set Limit*\nLimit sekarang: *${formatGB(user.limit_mb)}*\nKirim angka + unit, contoh: \`10gb\`, \`500mb\`, \`1.5gb\`\nKetik /cancel untuk batal.`, { parse_mode: "Markdown" });
});
bot.action("gantimsisdn_info", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat!.id);
  pending.set(chatId, "await_msisdn");
  await ctx.reply("🔄 Kirim hash baru (32 hex) atau nomor 628...:", { parse_mode: "Markdown" });
});
bot.action("cekpaket", (ctx) => { ctx.answerCbQuery().catch(() => {}); setImmediate(() => handleCekPaket(ctx)); });
bot.action("refresh_headers", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat!.id);
  pending.set(chatId, "await_headers_auth");
  pendingHeaderData.set(chatId, {});
  await ctx.reply(`🔑 *Refresh Headers* (1/3)\nKirim *Authorization* (722c...) — copy dari DevTools → Headers → Authorization`, { parse_mode: "Markdown" });
});
bot.action("update_headers", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat!.id);
  pending.set(chatId, "await_headers_auth");
  pendingHeaderData.set(chatId, {});
  await ctx.reply(`🔑 *Update Headers* (1/3)\nKirim Authorization:`, { parse_mode: "Markdown" });
});
bot.action("riwayat_7", (ctx) => { ctx.answerCbQuery().catch(() => {}); setImmediate(() => handleRiwayat(ctx,7)); });
bot.action("riwayat_14", (ctx) => { ctx.answerCbQuery().catch(() => {}); setImmediate(() => handleRiwayat(ctx,14)); });
bot.action("riwayat_28", (ctx) => { ctx.answerCbQuery().catch(() => {}); setImmediate(() => handleRiwayat(ctx,28)); });
bot.action("riwayat_30", (ctx) => { ctx.answerCbQuery().catch(() => {}); setImmediate(() => handleRiwayat(ctx,30)); });
bot.action("grafik_7", (ctx) => { ctx.answerCbQuery("📊 Memuat grafik 7 hari...").catch(() => {}); setImmediate(() => handleGrafik(ctx, 7)); });
bot.action("grafik_14", (ctx) => { ctx.answerCbQuery("📊 Memuat grafik 14 hari...").catch(() => {}); setImmediate(() => handleGrafik(ctx, 14)); });
bot.action("grafik_30", (ctx) => { ctx.answerCbQuery("📊 Memuat grafik 30 hari...").catch(() => {}); setImmediate(() => handleGrafik(ctx, 30)); });
bot.action("prediksi", (ctx) => { ctx.answerCbQuery().catch(() => {}); setImmediate(() => handlePrediksi(ctx)); });
bot.action("summary", (ctx) => { ctx.answerCbQuery().catch(() => {}); setImmediate(() => handleSummary(ctx)); });
bot.action("cekpaket", (ctx) => { ctx.answerCbQuery().catch(() => {}); setImmediate(() => handleCekPaket(ctx)); });
bot.action("view_headers", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`HIFI_AUTH: \`${mask(HIFI_AUTH)}\`\nHIFI_TOKENID: \`${mask(HIFI_TOKENID)}\`\nHIFI_OAUTH: \`${mask(HIFI_OAUTH)}\``, { parse_mode: "Markdown", ...headersKeyboard() });
});
bot.action("headers_howto", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `*Cara ambil headers:*\n1. Buka https://hifi.ioh.co.id/topup-hifiair\n2. F12 → Network → filter quota/details\n3. Refresh, klik request → Headers\n4. Copy Authorization, X-IMI-TOKENID, x-imi-oauth\n5. /setheaders untuk paste`,
    { parse_mode: "Markdown", ...headersKeyboard() }
  );
});
bot.action("help", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `🎛 *HifiQuota Quick Help*\n\n`+
    `📊 *Dashboard* - visual lengkap + chart\n`+
    `📈 *Cek Kuota* - akumulasi + bar visual\n`+
    `📦 *Cek Paket* - detail per paket\n`+
    `📜 *Riwayat* - grafik 7/14/28/30 hari\n`+
    `🔮 *Prediksi* - kapan habis + trend\n`+
    `📊 *Summary* - ringkasan mingguan\n`+
    `⚙️ *Set Limit* - 100mb/10gb/1.5gb\n`+
    `🔄 *Ganti MSISDN* - hash/nomor baru\n`+
    `🔑 *Headers* - refresh jika 401/403\n\n`+
    `Hash = customerid 32 hex dari DevTools\n`+
    `Default limit 10GB, auto cek 30 menit`,
    { parse_mode: "Markdown", ...mainKeyboard() }
  );
});

// ---- scheduler ----
// ponytail: anti-ban — jitter + stagger biar nggak burst 00:00 & 30m
async function sendDailyBackup(): Promise<boolean> {
  try {
    const tgl = todayWIB();
    const buf = Buffer.from(db.serialize());
    const cap = `Backup data.db tanggal ${tgl} (${(buf.length/1024).toFixed(1)} KB)`;
    let lastErr: any = null;
    for (let r = 0; r < 3; r++) {
      try {
        await bot.telegram.sendDocument(BACKUP_CHAT_ID, { source: buf, filename: `data-backup-${tgl}.db` } as any, { caption: cap });
        lastErr = null; break;
      } catch (e: any) {
        lastErr = e;
        console.warn(`[backup] send r=${r} ${String(e?.message ?? e).slice(0,120)}`);
        await new Promise(v => setTimeout(v, 1500*(r+1)));
      }
    }
    if (lastErr) throw lastErr;
    console.log(`[backup] ${buf.length} bytes terkirim ke ${BACKUP_CHAT_ID} (${tgl})`);
    return true;
  } catch (e: any) {
    console.error(`[backup] gagal: ${String(e?.message ?? e).slice(0,200)}`);
    return false;
  }
}
async function snapshotMidnight() {
  // jitter 0-90s biar nggak semua VPS jam 00:00 bareng kena WAF
  await new Promise(r=> setTimeout(r, Math.random()*90000));
  const today = todayWIB();
  const now = new Date().toISOString();
  const users = allUsersStmt.all() as any[];
  console.log(`[cron] snapshot ${today} untuk ${users.length} user`);
  for (const u of users) {
    try {
      // stagger tiap user 1-2s biar nggak paralel
      await new Promise(r=> setTimeout(r, 800+Math.random()*1200));
      const j = await fetchQuota(u.msisdn);
      const p = parseQuotaData(j);
      upsertSnapshotStmt.run(String(u.chat_id), today, p.remainingMb, now);
      console.log(`[snapshot] ${u.chat_id} sisa ${p.remainingMb} MB`);
    } catch (e:any) {
      console.error(`[snapshot] ${u.chat_id} gagal:`, e.message);
    }
  }
  await sendDailyBackup();
}

async function checkLimits() {
  await new Promise(r=> setTimeout(r, Math.random()*60000)); // jitter 0-60s
  const today = todayWIB();
  const users = allUsersStmt.all() as any[];
  for (const u of users) {
    const chatId = String(u.chat_id);
    try {
      await new Promise(r=> setTimeout(r, 900+Math.random()*1500)); // stagger
      const j = await fetchQuota(u.msisdn);
      const p = parseQuotaData(j);
      const dailyUsed = calcDailyUsage(chatId, p.remainingMb);
      const limit = u.limit_mb as number;
      const pct90 = limit * 0.9;

      // jika belum ada snapshot hari ini, buat dulu (misal bot baru start setelah jam 00:00)
      if (!getSnapshotStmt.get(chatId, today)) {
        upsertSnapshotStmt.run(chatId, today, p.remainingMb, new Date().toISOString());
        continue;
      }

      if (dailyUsed >= limit && u.last_100_date !== today) {
        const msg = `🔴 *Over limit!*\nPakai hari ini: *${formatGB(dailyUsed)}* / ${formatGB(limit)}\nSisa kuota: ${formatGB(p.remainingMb)}\nPaket: ${p.packageName}`;
        await bot.telegram.sendMessage(chatId, msg, { parse_mode: "Markdown" });
        updateReminder100Stmt.run(today, chatId);
        if (u.last_90_date !== today) updateReminder90Stmt.run(today, chatId);
        if ((u as any).last_50_date !== today) updateReminder50Stmt.run(today, chatId);
        console.log(`[alert 100%] ${chatId} used ${dailyUsed} MB`);
      } else if (dailyUsed >= pct90 && dailyUsed < limit && u.last_90_date !== today) {
        const msg = `🟡 *Hampir limit (90%)*\nPakai hari ini: *${formatGB(dailyUsed)}* / ${formatGB(limit)}\nSisa kuota: ${formatGB(p.remainingMb)}\nHati-hati pemakaian!`;
        await bot.telegram.sendMessage(chatId, msg, { parse_mode: "Markdown" });
        updateReminder90Stmt.run(today, chatId);
        console.log(`[alert 90%] ${chatId} used ${dailyUsed} MB`);
      } else if (dailyUsed >= limit*0.5 && dailyUsed < pct90 && (u as any).last_50_date !== today) {
        const msg = `🔵 *50% limit* ${formatGB(dailyUsed)} / ${formatGB(limit)} — setengah jalan`;
        await bot.telegram.sendMessage(chatId, msg, { parse_mode: "Markdown" });
        updateReminder50Stmt.run(today, chatId);
        console.log(`[alert 50%] ${chatId} used ${dailyUsed} MB`);
      }
      // ponytail: prediksi auto — kalau <3 hari habis atau habis sebelum expiry, notif sekali/hari
      try{
        const pred = getPrediksi(chatId, p.remainingMb, p.expiry);
        if(pred.daysHabis < 3 && (u as any).last_prediksi_date !== today && pred.avg>0){
          const msg2 = `🔮 *Prediksi habis!* ${pred.willHabisStr}\nAvg: ${formatGB(pred.avg)}/hari | Sisa: ${formatGB(p.remainingMb)}\nExpiry: ${expiryToStr(p.expiry)} (${pred.daysExpiry} hari)`;
          await bot.telegram.sendMessage(chatId, msg2, { parse_mode:"Markdown" });
          updatePrediksiStmt.run(today, chatId);
          console.log(`[prediksi] ${chatId} ${pred.willHabisStr}`);
        } else if(pred.daysHabis < pred.daysExpiry && pred.daysHabis < 7 && (u as any).last_prediksi_date !== today && pred.avg>0){
          const msg2 = `⚠️ *Habis sebelum expiry* — ${pred.willHabisStr} vs expiry ${pred.daysExpiry} hari`;
          await bot.telegram.sendMessage(chatId, msg2, { parse_mode:"Markdown" });
          updatePrediksiStmt.run(today, chatId);
        }
      }catch{}
    } catch (e:any) {
      console.error(`[check] ${chatId} gagal:`, e.message);
    }
  }
}

// cron: midnight WIB + tiap 30 menit + cleanup core tiap jam
// ponytail: HyeHost 128MB — hapus core dump tiap jam biar nggak 1GB numpuk
const jobCleanup = new CronJob("0 * * * *", ()=>{
  try{ for(const f of fs.readdirSync(".")) if(f==="core"||f.startsWith("core.")||f.startsWith("core-")){ fs.unlinkSync(f); console.log(`[cleanup] hapus ${f}`);} }catch{}
  const m=process.memoryUsage(); if(m.heapUsed > 110*1024*1024) console.warn(`[mem] heap ${Math.round(m.heapUsed/1024/1024)}MB >110MB`);
}, null, false, "Asia/Jakarta");
// ponytail: global lock, single instance cukup. Per-user cron tidak perlu.
const jobMidnight = new CronJob("0 0 * * *", snapshotMidnight, null, false, "Asia/Jakarta");
const job30min = new CronJob("*/30 * * * *", checkLimits, null, false, "Asia/Jakarta");
jobMidnight.start();
job30min.start();
jobCleanup.start();
console.log("[cron] midnight 00:00 WIB & 30min checker aktif + cleanup tiap jam");

// ---- launch + polling watchdog (ponytail: HyeHost NAT bunuh long-poll 2-4 hari — getMe tiap 60s, kalau 5 menit gak ok langsung relaunch; launch gagal -> exit biar pm2 restart) ----
let lastPollOk = Date.now();
bot.catch((err:any)=>{ lastPollOk = Date.now(); console.error("[bot catch]", String(err?.message ?? err).slice(0,200)); });
let watchdog: ReturnType<typeof setInterval> | null = null;
function startWatchdog(){
  if(watchdog) clearInterval(watchdog);
  watchdog = setInterval(async ()=>{
    try{ await bot.telegram.getMe(); lastPollOk = Date.now(); }
    catch(e:any){
      if(Date.now() - lastPollOk > 5*60*1000){
        console.warn(`[watchdog] polling mati ${Math.round((Date.now()-lastPollOk)/1000)}s, relaunch...`);
        try{ bot.stop("watchdog"); }catch{}
        try{ await bot.launch({ dropPendingUpdates: true } as any); lastPollOk = Date.now(); console.log("[watchdog] relaunch ok"); }
        catch(err:any){ console.error("[watchdog] relaunch gagal:", String(err?.message ?? err).slice(0,150)); }
      }
    }
  }, 60_000);
}
bot.launch({ dropPendingUpdates: true } as any).then(()=>{
  console.log("[bot] HifiQuota jalan ✅  /start untuk mulai");
  lastPollOk = Date.now();
  startWatchdog();
}).catch((e:any)=>{
  console.error("[launch] gagal:", String(e?.message ?? e).slice(0,200));
  setTimeout(()=> process.exit(1), 1000);
});
process.once("SIGINT", () => { if(watchdog) clearInterval(watchdog); jobMidnight.stop(); job30min.stop(); healthServer.stop(); bot.stop("SIGINT"); db.close(); });
process.once("SIGTERM", () => { if(watchdog) clearInterval(watchdog); jobMidnight.stop(); job30min.stop(); healthServer.stop(); bot.stop("SIGTERM"); db.close(); });

// (self-check moved to top before bot launch)
