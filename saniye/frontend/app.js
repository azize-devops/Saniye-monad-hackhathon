import {
  createPublicClient,
  createWalletClient,
  http,
  custom,
  encodeFunctionData,
  formatEther,
  parseEther,
  parseEventLogs,
} from "https://esm.sh/viem@2.40.3";
import { privateKeyToAccount, generatePrivateKey } from "https://esm.sh/viem@2.40.3/accounts";
import qrcode from "https://esm.sh/qrcode-generator@1.4.4";
import jsQR from "https://esm.sh/jsqr@1.4.0";
import { ABI } from "./abi.js";
import { CONFIG } from "./config.js";

// ------------------------------------------------------------------ setup
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let SERVICE_ID = BigInt(params.get("service") || CONFIG.serviceId);
const ADDR = CONFIG.contractAddress;
const CONFIGURED = /^0x[0-9a-fA-F]{40}$/.test(ADDR) && !/^0x0{40}$/.test(ADDR);
const ETH_MS = 12000;

const chain = {
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpcUrl] } },
  blockExplorers: { default: { name: "MonadVision", url: CONFIG.explorer } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
};
const pub = createPublicClient({ chain, transport: http(CONFIG.rpcUrl), pollingInterval: 1000 });

const state = {
  mode: localStorage.getItem("saniye.mode") || "burner",
  account: null,
  wallet: null,
  service: null, // { owner, rate, name }
  session: null, // { startedAt, deposit, rate }
  clockOffset: 0, // chain time - local time (seconds)
  busy: false,
  biz: { users: [], sessions: [], earnings: 0n, active: 0 },
  evFrom: undefined,
};

const read = (functionName, args = []) => pub.readContract({ address: ADDR, abi: ABI, functionName, args });
const mon = (wei, d = 6) => Number(formatEther(wei)).toFixed(d);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const chainNow = () => Date.now() / 1000 + state.clockOffset;
const txUrl = (h) => `${CONFIG.explorer}/tx/${h}`;
const hms = (s) => {
  s = Math.max(0, Math.floor(s));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
};

function setStatus(msg, kind = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + kind;
}

// ------------------------------------------------------------------ errors
const ERRORS = {
  DepositTooSmall: "Depozito en az 1 dakikalık ücreti karşılamalı.",
  SessionAlreadyActive: "Zaten aktif bir oturumun var.",
  NoActiveSession: "Aktif oturum bulunamadı.",
  UnknownService: "Bu hizmet zincirde kayıtlı değil.",
  NotAllowed: "Bu işlem için yetkin yok.",
  NothingToWithdraw: "Çekilecek kazanç yok.",
  InvalidRate: "Ücret sıfır olamaz.",
};
function friendly(e) {
  let cur = e;
  while (cur) {
    const name = cur.data?.errorName;
    if (name && ERRORS[name]) return ERRORS[name];
    cur = cur.cause;
  }
  const m = String(e?.shortMessage || e?.details || e?.message || e);
  if (/insufficient|funds|balance/i.test(m)) return "Bakiye yetersiz. Sağ üstteki cüzdandan adresine test MON gönder.";
  if (/user rejected|denied/i.test(m)) return "İşlem cüzdanda reddedildi.";
  return m.split("\n")[0].slice(0, 160);
}
function isUnsupported(e) {
  let cur = e;
  while (cur) {
    const m = String(cur.details || cur.message || "").toLowerCase();
    if (cur.code === -32601 || /method not found|not supported|unsupported|does not exist|not available/.test(m)) return true;
    cur = cur.cause;
  }
  return false;
}

// ------------------------------------------------------------------ wallet
async function initWallet(mode) {
  if (mode === "injected") {
    if (!window.ethereum) {
      setStatus("Tarayıcı cüzdanı bulunamadı, tek tık cüzdan kullanılıyor.", "err");
      mode = "burner";
    } else {
      const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
      try {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x279f" }] });
      } catch (err) {
        if (err.code === 4902) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{ chainId: "0x279f", chainName: "Monad Testnet", nativeCurrency: chain.nativeCurrency, rpcUrls: [CONFIG.rpcUrl], blockExplorerUrls: [CONFIG.explorer] }],
          });
        } else throw err;
      }
      state.wallet = createWalletClient({ account: addr, chain, transport: custom(window.ethereum) });
      state.account = addr;
    }
  }
  if (mode === "burner") {
    let pk = localStorage.getItem("saniye.burner");
    if (!pk) {
      pk = generatePrivateKey();
      localStorage.setItem("saniye.burner", pk);
    }
    const acct = privateKeyToAccount(pk);
    state.wallet = createWalletClient({ account: acct, chain, transport: http(CONFIG.rpcUrl) });
    state.account = acct.address;
  }
  state.mode = mode;
  localStorage.setItem("saniye.mode", mode);
  $("walletBtn").textContent = short(state.account);
  $("walletAddr").textContent = state.account;
  $("walletMode").textContent =
    mode === "burner"
      ? "Tarayıcı cüzdanı: kurulum yok, imza penceresi yok. Anahtar sadece bu tarayıcıda saklanır (yalnızca testnet için)."
      : "Tarayıcı eklentisi (MetaMask vb.) bağlı.";
  refreshBalance();
  if (CONFIGURED) await loadSession();
}

async function refreshBalance() {
  if (!state.account) return;
  try {
    const b = await pub.getBalance({ address: state.account });
    $("walletBal").textContent = `${mon(b, 4)} MON`;
  } catch {}
}

// Send a contract call. Burner wallets use eth_sendRawTransactionSync: one round trip,
// the receipt comes back directly. Falls back to send + poll if the RPC lacks it.
async function sendTx(functionName, args = [], value = 0n) {
  const est = await pub.estimateContractGas({ address: ADDR, abi: ABI, functionName, args, value, account: state.account });
  const gas = (est * 125n) / 100n; // Monad charges the gas LIMIT, so keep the margin tight
  const data = encodeFunctionData({ abi: ABI, functionName, args });

  if (state.mode === "burner") {
    const req = await state.wallet.prepareTransactionRequest({ to: ADDR, data, value, gas });
    const raw = await state.wallet.signTransaction(req);
    const t0 = performance.now();
    let r;
    let sync = true;
    try {
      r = await pub.request({ method: "eth_sendRawTransactionSync", params: [raw] });
    } catch (e) {
      if (!isUnsupported(e)) throw e;
      sync = false;
      const hash = await pub.sendRawTransaction({ serializedTransaction: raw });
      r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
    }
    return { receipt: normalize(r), ms: performance.now() - t0, sync };
  }

  const hash = await state.wallet.sendTransaction({ to: ADDR, data, value, gas, account: state.account, chain });
  const t0 = performance.now();
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
  return { receipt: normalize(r), ms: performance.now() - t0, sync: false };
}
function normalize(r) {
  return {
    ok: r.status === "0x1" || r.status === "success" || r.status === 1,
    hash: r.transactionHash,
    block: BigInt(r.blockNumber),
    logs: r.logs || [],
  };
}

// ------------------------------------------------------------------ user view
async function loadService() {
  const s = await read("services", [SERVICE_ID]);
  const [owner, rate, , exists, name] = s;
  if (!exists) throw new Error(`Hizmet #${SERVICE_ID} bulunamadı.`);
  state.service = { owner, rate, name };
  const perSec = Number(formatEther(rate));
  $("svcName").textContent = name;
  $("svcRate").textContent = `${(perSec * 3600).toFixed(2)} MON / saat  ·  ${perSec.toFixed(6)} MON / saniye`;
  $("bizTitle").textContent = name;
}

async function loadSession() {
  const [serviceId, startedAt, deposit, active] = await read("sessions", [state.account]);
  if (active) {
    const [, rate] = await read("services", [serviceId]);
    const blk = await pub.getBlock();
    state.clockOffset = Number(blk.timestamp) + 0.5 - Date.now() / 1000;
    state.session = { serviceId, startedAt: Number(startedAt), deposit, rate };
  } else {
    state.session = null;
  }
  renderUser();
}

function renderUser() {
  const live = !!state.session;
  $("gate").classList.toggle("open", live);
  document.querySelector(".main-card").classList.toggle("live", live);
  const btn = $("actionBtn");
  btn.disabled = state.busy || !CONFIGURED || !state.service;
  $("scanBtn").disabled = btn.disabled;
  $("scanBtn").innerHTML = live
    ? `<span aria-hidden="true">▣</span> Çıkış QR'ını okut <span class="muted">· öde ve kalan iade</span>`
    : `<span aria-hidden="true">▣</span> QR okut <span class="muted">· girişte başlar, çıkışta öder</span>`;
  btn.className = "btn huge " + (live ? "stop" : "primary");
  btn.textContent = state.busy ? "Zincire gönderiliyor…" : live ? "Durdur ve öde" : `Başlat  ·  ${CONFIG.depositMon} MON depozito`;
  if (!live) {
    $("elapsed").textContent = "00:00:00";
    $("cost").textContent = "0.000000";
    $("meterFill").style.width = "100%";
    $("depositLbl").textContent = `${CONFIG.depositMon} MON`;
    $("refundLbl").textContent = "—";
  }
}

function tick() {
  const ses = state.session;
  if (ses) {
    const el = Math.max(0, chainNow() - ses.startedAt);
    const rate = Number(formatEther(ses.rate));
    const dep = Number(formatEther(ses.deposit));
    const cost = Math.min(el * rate, dep);
    $("elapsed").textContent = hms(el);
    $("cost").textContent = cost.toFixed(6);
    $("meterFill").style.width = `${((dep - cost) / dep) * 100}%`;
    $("depositLbl").textContent = `${dep.toFixed(4)} MON`;
    $("refundLbl").textContent = `${(dep - cost).toFixed(6)} MON`;
    const classic = Math.ceil(Math.max(el, 1) / 3600) * rate * 3600;
    $("classic").textContent = `${classic.toFixed(4)} MON`;
    $("fair").textContent = `${cost.toFixed(6)} MON`;
    const pct = classic > 0 ? ((classic - cost) / classic) * 100 : 0;
    $("saving").textContent = `Saatlik yuvarlamaya göre %${pct.toFixed(1)} daha az ödüyorsun.`;
    if (cost >= dep && !state.busy) setStatus("Depozito bitti. Durdurduğunda oturum kapanır.", "err");
  }
  if (!$("view-biz").hidden) tickBiz();
  requestAnimationFrame(tick);
}

function showLatency(ms, sync) {
  $("latMonad").textContent = `${Math.round(ms).toLocaleString("tr-TR")} ms`;
  $("latMonadBar").style.width = `${Math.max(2, Math.min(100, (ms / ETH_MS) * 100))}%`;
  $("latNote").textContent = sync
    ? "eth_sendRawTransactionSync: makbuz tek istekte geldi."
    : "Gönderimden makbuza kadar geçen süre.";
}

function addFeed(listId, tag, text, hash) {
  const list = $(listId);
  if (list.firstElementChild?.classList.contains("muted")) list.innerHTML = "";
  const li = document.createElement("li");
  const cls = tag === "durdur" ? "stop" : tag === "çekim" ? "ok" : "";
  li.innerHTML = `<span class="tag ${cls}">${tag}</span><span>${text}</span>${hash ? `<a href="${txUrl(hash)}" target="_blank" rel="noopener" title="Explorer'da aç">↗</a>` : "<span></span>"}`;
  list.prepend(li);
  while (list.children.length > 30) list.lastElementChild.remove();
}

async function onAction() {
  if (state.busy) return;
  state.busy = true;
  renderUser();
  try {
    if (!state.session) await doStart();
    else await doStop();
  } catch (e) {
    console.error(e);
    setStatus(friendly(e), "err");
  } finally {
    state.busy = false;
    renderUser();
    refreshBalance();
  }
}

async function doStart() {
  $("summary").hidden = true;
  const value = parseEther(CONFIG.depositMon);
  const bal = await pub.getBalance({ address: state.account });
  if (bal < value) throw new Error("insufficient balance");
  setStatus("İmzalanıyor ve Monad'a gönderiliyor…");
  const { receipt, ms, sync } = await sendTx("start", [SERVICE_ID], value);
  if (!receipt.ok) throw new Error("İşlem geri döndü (revert).");
  const [ev] = parseEventLogs({ abi: ABI, logs: receipt.logs, eventName: "SessionStarted" });
  const startedAt = Number(ev.args.startedAt);
  state.clockOffset = startedAt + 0.5 - Date.now() / 1000;
  state.session = { serviceId: SERVICE_ID, startedAt, deposit: ev.args.deposit, rate: state.service.rate };
  showLatency(ms, sync);
  addFeed("rcptFeed", "başlat", `Blok #${receipt.block} · ${Math.round(ms)} ms`, receipt.hash);
  setStatus(`Bariyer açıldı · onay ${Math.round(ms)} ms`, "ok");
}

async function doStop() {
  setStatus("Durduruluyor, hesap kapanıyor…");
  const { receipt, ms, sync } = await sendTx("stop");
  if (!receipt.ok) throw new Error("İşlem geri döndü (revert).");
  const [ev] = parseEventLogs({ abi: ABI, logs: receipt.logs, eventName: "SessionStopped" });
  const { elapsed, cost, refund } = ev.args;
  const rate = Number(formatEther(state.session.rate));
  const classic = Math.ceil(Math.max(Number(elapsed), 1) / 3600) * rate * 3600;
  state.session = null;
  showLatency(ms, sync);
  addFeed("rcptFeed", "durdur", `Blok #${receipt.block} · ${Math.round(ms)} ms`, receipt.hash);
  setStatus(`Ödendi ve iade edildi · onay ${Math.round(ms)} ms`, "ok");

  const s = $("summary");
  s.innerHTML = `
    <h3>Oturum kapandı ✓</h3>
    <div class="sum-grid">
      <div><p class="label">Süre</p><p class="mono mid">${Number(elapsed)} sn</p></div>
      <div><p class="label">Ödenen</p><p class="mono mid accent">${mon(cost)} MON</p></div>
      <div><p class="label">Anında iade</p><p class="mono mid">${mon(refund)} MON</p></div>
      <div><p class="label">Klasik sistemde</p><p class="mono mid">${classic.toFixed(4)} MON</p></div>
    </div>
    <p class="muted small">Tek işlemde: ücret işletmeye, %1 platform payı hazineye, kalan depozito sana. <a href="${txUrl(receipt.hash)}" target="_blank" rel="noopener">Explorer'da gör ↗</a></p>`;
  s.hidden = false;
}

// ------------------------------------------------------------------ in-app QR scanner
// Scan at the entrance: session starts. Scan the same code at the exit: pay and get refunded.
function serviceFromQR(text) {
  const t = String(text || "").trim();
  try {
    const s = new URL(t).searchParams.get("service");
    if (s && /^\d+$/.test(s)) return BigInt(s);
  } catch {}
  if (/^\d+$/.test(t)) return BigInt(t);
  return null;
}

async function onScanResult(text) {
  const id = serviceFromQR(text);
  if (id === null) {
    setStatus("Bu bir Saniye QR kodu değil.", "err");
    return;
  }
  if (state.session) {
    if (state.session.serviceId !== undefined && BigInt(state.session.serviceId) !== id) {
      setStatus("Aktif oturumun başka bir hizmette. Önce onu durdur.", "err");
      return;
    }
    setStatus("Çıkış QR'ı okundu. Ödeniyor…");
    return onAction(); // stop + pay + refund
  }
  if (id !== SERVICE_ID) {
    SERVICE_ID = id;
    history.replaceState(null, "", `${location.pathname}?service=${id}#kullanici`);
    await loadService();
    renderUser();
  }
  setStatus("Giriş QR'ı okundu. Başlatılıyor…");
  return onAction(); // start
}

let scanStream = null;
let scanLoop = null;
async function openScanner() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Bu tarayıcı kamerayı desteklemiyor. Telefonun kamera uygulamasıyla QR'ı okutabilirsin.", "err");
    return;
  }
  $("scanner").hidden = false;
  $("scanHint").textContent = "Kamerayı bariyerdeki / kasadaki Saniye QR koduna tut.";
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  } catch {
    closeScanner();
    setStatus("Kamera izni verilmedi. Tarayıcı ayarlarından izin ver ya da telefon kamerasıyla okut.", "err");
    return;
  }
  const video = $("scanVideo");
  video.srcObject = scanStream;
  await video.play().catch(() => {});
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const step = () => {
    if (!scanStream) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const scale = Math.min(1, 640 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      if (code?.data && serviceFromQR(code.data) !== null) {
        navigator.vibrate?.(60);
        closeScanner();
        onScanResult(code.data);
        return;
      }
    }
    scanLoop = requestAnimationFrame(step);
  };
  scanLoop = requestAnimationFrame(step);
}
function closeScanner() {
  if (scanLoop) cancelAnimationFrame(scanLoop);
  scanLoop = null;
  scanStream?.getTracks().forEach((t) => t.stop());
  scanStream = null;
  $("scanVideo").srcObject = null;
  $("scanner").hidden = true;
}

// ------------------------------------------------------------------ QR & kiosk
const customerUrl = () => `${location.origin}${location.pathname}?service=${SERVICE_ID}#kullanici`;

function renderQR(el, text) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

function renderQRs() {
  const url = customerUrl();
  if ($("qrBox").dataset.url === url) return;
  $("qrBox").dataset.url = url;
  renderQR($("qrBox"), url);
  renderQR($("kioskQr"), url);
  $("qrLink").textContent = url;
  if (/^(localhost|127\.)/.test(location.hostname)) {
    $("qrLink").textContent = url + "  (localhost telefonda açılmaz; canlı linkten açınca QR telefonda çalışır)";
  }
}

let flashTimer;
function kioskFlash(title, sub, bye = false) {
  if ($("kiosk").hidden) return;
  $("kioskFlashTitle").textContent = title;
  $("kioskFlashSub").textContent = sub;
  $("kioskFlash").classList.toggle("bye", bye);
  $("kioskFlash").querySelector(".gate").classList.toggle("open", !bye);
  $("kioskFlash").hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => ($("kioskFlash").hidden = true), 4000);
}

function openKiosk() {
  renderQRs();
  if (state.service) {
    $("kioskName").textContent = state.service.name;
    const perSec = Number(formatEther(state.service.rate));
    $("kioskPrice").textContent = `${(perSec * 3600).toFixed(2)} MON / saat · saniye başı ödeme`;
  }
  $("kiosk").hidden = false;
  document.documentElement.requestFullscreen?.().catch(() => {});
}
function closeKiosk() {
  $("kiosk").hidden = true;
  $("kioskFlash").hidden = true;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

// ------------------------------------------------------------------ business view
// Batch reads through Multicall3; fall back to individual calls if it is unavailable.
async function multi(contracts) {
  try {
    return await pub.multicall({ allowFailure: false, contracts });
  } catch {
    return Promise.all(contracts.map((c) => pub.readContract(c)));
  }
}

async function refreshBiz() {
  if (!CONFIGURED || !state.service) return;
  try {
    const [svc, users] = await multi([
      { address: ADDR, abi: ABI, functionName: "services", args: [SERVICE_ID] },
      { address: ADDR, abi: ABI, functionName: "activeUsers", args: [SERVICE_ID] },
    ]);
    const calls = users.map((u) => ({ address: ADDR, abi: ABI, functionName: "sessions", args: [u] }));
    calls.push({ address: ADDR, abi: ABI, functionName: "earnings", args: [svc[0]] });
    const res = await multi(calls);
    const earnings = res.pop();
    state.biz = {
      users,
      sessions: res.map(([, startedAt, deposit]) => ({ startedAt: Number(startedAt), deposit })),
      earnings,
      active: Number(svc[2]),
    };
    if (state.clockOffset === 0) {
      const blk = await pub.getBlock();
      state.clockOffset = Number(blk.timestamp) + 0.5 - Date.now() / 1000;
    }
    $("bizActive").textContent = state.biz.active;
    $("bizEarn").textContent = mon(earnings);
    const isOwner = state.account && state.account.toLowerCase() === state.service.owner.toLowerCase();
    $("withdrawBtn").disabled = !isOwner || earnings === 0n;
    $("withdrawBtn").title = isOwner ? "" : "Sadece hizmet sahibi çekebilir";

    const list = $("bizSessions");
    if (!users.length) list.innerHTML = `<li class="muted small">Şu an aktif oturum yok.</li>`;
    else list.innerHTML = users.map((u, i) => `<li><span class="mono">${short(u)}</span><span class="mono accent" data-ses="${i}">—</span></li>`).join("");
  } catch (e) {
    console.warn("biz refresh", e);
  }
}

function tickBiz() {
  const rate = Number(formatEther(state.service?.rate || 0n));
  let total = 0;
  state.biz.sessions.forEach((s, i) => {
    const dep = Number(formatEther(s.deposit));
    const el = Math.max(0, chainNow() - s.startedAt);
    const c = Math.min(el * rate, dep);
    total += c;
    const el2 = document.querySelector(`[data-ses="${i}"]`);
    if (el2) el2.textContent = `${hms(el)} · ${c.toFixed(6)} MON`;
  });
  $("bizLive").textContent = total.toFixed(6);
}

async function pollEvents() {
  if (!CONFIGURED || $("view-biz").hidden) return;
  try {
    const latest = await pub.getBlockNumber();
    if (state.evFrom === undefined || latest - state.evFrom > 90n) {
      const floor = BigInt(CONFIG.deployBlock || 0);
      state.evFrom = latest > 60n ? latest - 60n : 0n;
      if (state.evFrom < floor) state.evFrom = floor;
    }
    if (latest < state.evFrom) return;
    const logs = await pub.getContractEvents({ address: ADDR, abi: ABI, fromBlock: state.evFrom, toBlock: latest });
    state.evFrom = latest + 1n;
    let changed = false;
    for (const l of logs) {
      const a = l.args;
      if (a.serviceId !== undefined && a.serviceId !== SERVICE_ID) continue;
      if (l.eventName === "SessionStarted") {
        addFeed("bizFeed", "başlat", `${short(a.user)} · depozito ${mon(a.deposit, 4)} MON`, l.transactionHash);
        kioskFlash("Bariyer açıldı", `Hoş geldin ${short(a.user)} · sayaç başladı`);
        changed = true;
      } else if (l.eventName === "SessionStopped") {
        addFeed("bizFeed", "durdur", `${short(a.user)} · ${Number(a.elapsed)} sn · +${mon(a.cost)} MON`, l.transactionHash);
        kioskFlash("İyi yolculuklar", `${Number(a.elapsed)} sn · ${mon(a.cost)} MON ödendi · kalan iade edildi`, true);
        changed = true;
      } else if (l.eventName === "Withdrawn" && state.service && a.to.toLowerCase() === state.service.owner.toLowerCase()) {
        addFeed("bizFeed", "çekim", `${mon(a.amount)} MON çekildi`, l.transactionHash);
        changed = true;
      }
    }
    if (changed) refreshBiz();
  } catch (e) {
    console.warn("events", e);
  }
}

async function onWithdraw() {
  $("withdrawBtn").disabled = true;
  try {
    const { receipt, ms } = await sendTx("withdraw");
    if (!receipt.ok) throw new Error("revert");
    $("bizEarn").textContent = mon(0n);
    addFeed("bizFeed", "çekim", `Kazanç cüzdana geçti · ${Math.round(ms)} ms`, receipt.hash);
  } catch (e) {
    alert(friendly(e));
  }
  refreshBiz();
  refreshBalance();
}

async function onRegister(ev) {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const out = $("regStatus");
  try {
    const rate = parseEther(String(f.get("perHour")).replace(",", ".")) / 3600n;
    if (rate === 0n) throw new Error("Ücret çok düşük.");
    out.textContent = "Zincire kaydediliyor…";
    const { receipt, ms } = await sendTx("registerService", [String(f.get("name")), rate]);
    const [e] = parseEventLogs({ abi: ABI, logs: receipt.logs, eventName: "ServiceRegistered" });
    const id = e.args.serviceId;
    const url = `${location.pathname}?service=${id}#kullanici`;
    out.innerHTML = `Hizmet #${id} kaydedildi (${Math.round(ms)} ms). Müşteri linki: <a href="${url}">${location.host}${url}</a>`;
  } catch (e) {
    out.textContent = friendly(e);
  }
}

// ------------------------------------------------------------------ routing & boot
function route() {
  const biz = location.hash === "#isletme";
  $("view-user").hidden = biz;
  $("view-biz").hidden = !biz;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === (biz ? "biz" : "user")));
  if (biz) {
    renderQRs();
    refreshBiz();
    pollEvents();
  }
}

async function tickBlock() {
  try {
    $("blockNo").textContent = `#${(await pub.getBlockNumber()).toLocaleString("tr-TR")}`;
  } catch {}
}

async function boot() {
  $("actionBtn").onclick = onAction;
  $("withdrawBtn").onclick = onWithdraw;
  $("regForm").onsubmit = onRegister;
  $("kioskBtn").onclick = openKiosk;
  $("scanBtn").onclick = openScanner;
  $("scanClose").onclick = closeScanner;
  window.__saniye = { onScanResult }; // used by tests
  $("kioskClose").onclick = closeKiosk;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("scanner").hidden) closeScanner();
    else if (!$("kiosk").hidden) closeKiosk();
  });
  $("copyLink").onclick = () => navigator.clipboard.writeText(customerUrl());
  $("walletBtn").onclick = () => ($("walletPanel").hidden = false);
  $("walletClose").onclick = () => ($("walletPanel").hidden = true);
  $("walletPanel").onclick = (e) => { if (e.target.id === "walletPanel") $("walletPanel").hidden = true; };
  $("copyAddr").onclick = () => navigator.clipboard.writeText(state.account || "");
  $("useBurner").onclick = () => initWallet("burner").catch((e) => setStatus(friendly(e), "err"));
  $("useInjected").onclick = () => initWallet("injected").catch((e) => setStatus(friendly(e), "err"));
  $("faucetLinks").innerHTML = CONFIG.faucets.map((u) => `<a href="${u}" target="_blank" rel="noopener">${new URL(u).host}</a>`).join(" · ");
  window.addEventListener("hashchange", route);
  route();
  requestAnimationFrame(tick);

  if (!CONFIGURED) {
    setStatus("Kontrat adresi ayarlı değil. Önce `npm run deploy` çalıştır (frontend/config.js).", "err");
    renderUser();
  } else {
    $("contractLink").textContent = short(ADDR);
    $("contractLink").href = `${CONFIG.explorer}/address/${ADDR}`;
    try {
      await loadService();
    } catch (e) {
      setStatus(friendly(e), "err");
    }
  }
  await initWallet(state.mode).catch(() => initWallet("burner"));
  renderUser();

  // First visit from a QR scan: the fresh phone wallet is empty, say what to do.
  if (CONFIGURED && !state.session) {
    try {
      const bal = await pub.getBalance({ address: state.account });
      if (bal < parseEther(CONFIG.depositMon)) {
        setStatus(`Cüzdanın boş. Sağ üstteki cüzdana dokun, adresini kopyala ve ona ${CONFIG.depositMon}+ test MON gönder.`, "err");
      }
    } catch {}
  }

  tickBlock();
  setInterval(tickBlock, 1000);
  setInterval(refreshBalance, 5000);
  setInterval(() => !$("view-biz").hidden && refreshBiz(), 2500);
  setInterval(pollEvents, 1500);
}

boot();
