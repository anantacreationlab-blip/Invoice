/* ==========================================================================
   1. BUSINESS CONFIG — edit these once. They're your defaults every time
      the app loads. Anything you later change in Settings is saved to
      Local Storage and takes priority over these hardcoded values, so
      after your first visit you can manage everything from the Settings
      modal instead of editing this file.
   ========================================================================== */
const DEFAULT_CONFIG = {
  businessName: "Your Business Name",
  ownerName: "Your Name",
  address: "Street Address, City, State, ZIP",
  country: "Country",
  email: "you@example.com",
  phone: "+1 234 567 8900",
  website: "https://yourwebsite.com",
  portfolio: "https://atul-creative.netlify.app/",
  taxId: "",
  gst: "",
  logoPath: "assets/Logo Circle.png",

  currency: "USD",
  taxRate: 0,
  discountRate: 0,
  accentColor: "#2f5fe0",

  paypal: "",
  wise: "",
  upi: "",
  bankDetails: "",
  paymentLink: "",
  showPaypal: false,
  showWise: false,
  showUpi: false,
  showBank: false,
  showPaymentLink: false,

  paymentTerms: "Payment due within 7 days of the invoice date.",
  notes: "Please reach out with any questions about this invoice.",
  thankYouMessage: "Thank you for your business.",
  latePaymentPolicy: "A late fee of 2% per month applies to overdue balances."
};

const CURRENCY_SYMBOLS = { USD: "$", EUR: "\u20AC", GBP: "\u00A3", INR: "\u20B9", CAD: "CA$", AUD: "AU$" };

/* ==========================================================================
   2. STORAGE HELPERS
   ========================================================================== */
const STORE_KEYS = {
  settings: "inv_settings",
  clients: "inv_clients",
  history: "inv_history",
  drafts: "inv_drafts",
  lastNumber: "inv_lastNumber",
  theme: "inv_theme"
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error("Failed to read", key, e);
    return fallback;
  }
}
function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
  scheduleSync();
}

let CONFIG = Object.assign({}, DEFAULT_CONFIG, loadJSON(STORE_KEYS.settings, {}));
let clients = loadJSON(STORE_KEYS.clients, []);
let history = loadJSON(STORE_KEYS.history, []);
let drafts = loadJSON(STORE_KEYS.drafts, []);
let lastNumber = loadJSON(STORE_KEYS.lastNumber, 0);
let selectedClientId = null;
let loadedHistoryId = null; // set when an existing invoice is reopened from History, so regenerating it isn't flagged as a duplicate number

/* ==========================================================================
   2B. DATA FOLDER SYNC — writes a live backup file next to your source
       files using the File System Access API. Local Storage stays the
       primary, always-on store (this is only supported in Chromium
       browsers); this is an extra copy on disk so clearing browser data
       doesn't wipe everything. Everything here is a no-op until you
       click "Connect Data Folder" in Settings.
   ========================================================================== */
const DATA_FILE_NAME = "invoice-data.json";
const IDB_NAME = "invoice_app_db";
const IDB_STORE = "handles";
const fileSyncSupported = "showDirectoryPicker" in window;
let dataDirHandle = null;
let dataDirName = "";
let fileSyncTimer = null;
let syncState = fileSyncSupported ? "disconnected" : "unsupported";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function idbDelete(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function buildBackupPayload() {
  return {
    settings: CONFIG, clients, history, drafts, lastNumber,
    theme: localStorage.getItem(STORE_KEYS.theme) || "light",
    exportedAt: new Date().toISOString()
  };
}
function applyBackupPayload(payload) {
  if (payload.settings) { CONFIG = Object.assign({}, DEFAULT_CONFIG, payload.settings); localStorage.setItem(STORE_KEYS.settings, JSON.stringify(CONFIG)); }
  if (payload.clients) { clients = payload.clients; localStorage.setItem(STORE_KEYS.clients, JSON.stringify(clients)); }
  if (payload.history) { history = payload.history; localStorage.setItem(STORE_KEYS.history, JSON.stringify(history)); }
  if (payload.drafts) { drafts = payload.drafts; localStorage.setItem(STORE_KEYS.drafts, JSON.stringify(drafts)); }
  if (payload.lastNumber) { lastNumber = payload.lastNumber; localStorage.setItem(STORE_KEYS.lastNumber, JSON.stringify(lastNumber)); }
  if (payload.theme) { localStorage.setItem(STORE_KEYS.theme, payload.theme); document.body.setAttribute("data-theme", payload.theme); $("#btnTheme").textContent = payload.theme === "dark" ? "\u2600\uFE0F" : "\uD83C\uDF19"; }
  applyAccentColor();
  renderClientList();
  resetToNewInvoice();
}

function setSyncState(state) {
  syncState = state;
  const labels = {
    unsupported: "\uD83D\uDCBE Folder Sync Needs Chrome/Edge",
    disconnected: "\uD83D\uDCBE Not Connected",
    synced: "\uD83D\uDCBE Synced" + (dataDirName ? ": " + dataDirName : ""),
    reconnect: "\uD83D\uDCBE Reconnect Needed",
    error: "\uD83D\uDCBE Sync Error"
  };
  const topbarBtn = $("#btnDataFolder");
  if (topbarBtn) { topbarBtn.textContent = labels[state] || labels.disconnected; topbarBtn.dataset.state = state; }
  refreshDataFolderSettingsUI();
}
function refreshDataFolderSettingsUI() {
  const statusText = $("#dataFolderStatusText");
  if (!statusText) return;
  const texts = {
    unsupported: "This browser doesn't support saving directly to a folder (Chrome/Edge only). Use the manual JSON backup below instead.",
    disconnected: "Not connected. Your data currently lives only in this browser's storage.",
    synced: `Connected to "${dataDirName}". Every change is also written to ${DATA_FILE_NAME} in that folder.`,
    reconnect: `Was connected to "${dataDirName}" but permission needs to be re-granted this session. Click Reconnect.`,
    error: "Last write to the folder failed. Check the folder still exists, then try again."
  };
  statusText.textContent = texts[syncState] || texts.disconnected;
  $("#btnConnectFolder").classList.toggle("hidden", syncState === "synced" || syncState === "reconnect" || syncState === "unsupported");
  $("#btnReconnectFolder").classList.toggle("hidden", syncState !== "reconnect");
  $("#btnDisconnectFolder").classList.toggle("hidden", syncState === "disconnected" || syncState === "unsupported");
}

async function writeToDataDir() {
  if (!dataDirHandle) return;
  try {
    const perm = await dataDirHandle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") { setSyncState("reconnect"); return; }
    const fileHandle = await dataDirHandle.getFileHandle(DATA_FILE_NAME, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(buildBackupPayload(), null, 2));
    await writable.close();
    setSyncState("synced");
  } catch (e) {
    console.error("Data folder sync failed:", e);
    setSyncState("error");
  }
}
function scheduleSync() {
  if (!dataDirHandle) return;
  clearTimeout(fileSyncTimer);
  fileSyncTimer = setTimeout(writeToDataDir, 600);
}

async function loadFromConnectedFile(isInitialConnect) {
  if (!dataDirHandle) return;
  try {
    const fileHandle = await dataDirHandle.getFileHandle(DATA_FILE_NAME, { create: false });
    const file = await fileHandle.getFile();
    const payload = JSON.parse(await file.text());
    if (isInitialConnect) {
      confirmAction(`This folder already has ${DATA_FILE_NAME}. Load it now? This replaces what's currently in the app.`, () => {
        applyBackupPayload(payload);
        showToast("Loaded data from the folder.");
      });
    } else {
      applyBackupPayload(payload);
    }
  } catch (e) {
    // No existing data file in this folder yet — seed it from the app's current state.
    if (isInitialConnect) await writeToDataDir();
  }
}
async function connectDataFolder() {
  if (!fileSyncSupported) { showToast("Folder sync needs Chrome or Edge. Use Export/Import JSON instead.", true); return; }
  try {
    const handle = await window.showDirectoryPicker();
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") { showToast("Folder access wasn't granted.", true); return; }
    dataDirHandle = handle;
    dataDirName = handle.name;
    await idbSet("dataDir", handle);
    setSyncState("synced");
    await loadFromConnectedFile(true);
    showToast(`Connected to "${handle.name}". Saving here from now on.`);
  } catch (e) {
    if (e.name !== "AbortError") { console.error(e); showToast("Couldn't connect that folder.", true); }
  }
}
async function reconnectDataFolder() {
  if (!dataDirHandle) return;
  try {
    const perm = await dataDirHandle.requestPermission({ mode: "readwrite" });
    if (perm === "granted") { setSyncState("synced"); scheduleSync(); showToast("Reconnected."); }
    else { showToast("Permission not granted.", true); }
  } catch (e) { console.error(e); showToast("Reconnect failed.", true); }
}
async function disconnectDataFolder() {
  dataDirHandle = null;
  dataDirName = "";
  await idbDelete("dataDir");
  setSyncState("disconnected");
  showToast("Disconnected. Now saving in this browser only.");
}
async function initFileSync() {
  if (!fileSyncSupported) { setSyncState("unsupported"); return; }
  try {
    const handle = await idbGet("dataDir");
    if (!handle) { setSyncState("disconnected"); return; }
    dataDirHandle = handle;
    dataDirName = handle.name;
    const perm = await handle.queryPermission({ mode: "readwrite" });
    setSyncState(perm === "granted" ? "synced" : "reconnect");
  } catch (e) {
    console.error(e);
    setSyncState("disconnected");
  }
}

/* ==========================================================================
   3. UTILITIES
   ========================================================================== */
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDaysISO(iso, days) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function formatMoney(amount, currency) {
  const symbol = CURRENCY_SYMBOLS[currency] || "";
  const num = isFinite(amount) ? amount : 0;
  return symbol + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatDateDisplay(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function nextInvoiceNumber() {
  return "INV-" + String(lastNumber + 1).padStart(4, "0");
}
function showToast(message, isError) {
  const t = $("#toast");
  t.textContent = message;
  t.className = "toast show" + (isError ? " error" : "");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { t.className = "toast"; }, 2600);
}
function confirmAction(message, onOk) {
  $("#confirmMessage").textContent = message;
  const overlay = $("#confirmModal");
  overlay.classList.remove("hidden");
  const ok = $("#confirmOk");
  const cancel = $("#confirmCancel");
  function cleanup() {
    overlay.classList.add("hidden");
    ok.removeEventListener("click", okHandler);
    cancel.removeEventListener("click", cleanup);
  }
  function okHandler() { cleanup(); onOk(); }
  ok.addEventListener("click", okHandler);
  cancel.addEventListener("click", cleanup);
}
function openModal(id) { $(id).classList.remove("hidden"); }
function closeModal(id) { $(id).classList.add("hidden"); }

/* ==========================================================================
   4. ITEM ROWS
   ========================================================================== */
function addItemRow(item) {
  const tpl = $("#itemRowTemplate").content.cloneNode(true);
  const row = tpl.querySelector(".item-row");
  if (item) {
    row.querySelector(".item-desc").value = item.desc || "";
    row.querySelector(".item-qty").value = item.qty != null ? item.qty : 1;
    row.querySelector(".item-rate").value = item.rate != null ? item.rate : 0;
  }
  row.querySelectorAll("input").forEach(inp => inp.addEventListener("input", handleFormChange));
  row.querySelector(".item-delete").addEventListener("click", () => {
    row.remove();
    handleFormChange();
  });
  $("#itemsContainer").appendChild(row);
}
function getItems() {
  return $all("#itemsContainer .item-row").map(row => {
    const qty = parseFloat(row.querySelector(".item-qty").value) || 0;
    const rate = parseFloat(row.querySelector(".item-rate").value) || 0;
    return { desc: row.querySelector(".item-desc").value, qty, rate, total: qty * rate };
  });
}
function refreshItemTotals() {
  $all("#itemsContainer .item-row").forEach(row => {
    const qty = parseFloat(row.querySelector(".item-qty").value) || 0;
    const rate = parseFloat(row.querySelector(".item-rate").value) || 0;
    row.querySelector(".item-total").textContent = (qty * rate).toFixed(2);
  });
}

/* ==========================================================================
   4B. CSV IMPORT — pulls invoice line items from a CSV export of a work
       tracker (e.g. a Google Sheet exported via File > Download > CSV).
       Expects columns with headers containing "date", "video" (but not
       "channel"), and "amount"/"rate". A trailing TRUE/FALSE checkbox
       column, if present, is treated as "already invoiced" — TRUE rows
       are skipped so you don't double-bill completed work.
   ========================================================================== */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(f => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); if (row.some(f => f.trim() !== "")) rows.push(row); }
  return rows;
}
function findColIndex(headers, keywords) {
  return headers.findIndex(h => keywords.some(k => h.toLowerCase().includes(k)));
}
function handleCsvImport(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rows = parseCSV(reader.result);
      if (rows.length < 2) { showToast("That CSV has no data rows.", true); return; }
      const headers = rows[0].map(h => h.trim());
      const dateCol = findColIndex(headers, ["date"]);
      const videoCol = headers.findIndex(h => /video/i.test(h) && !/channel/i.test(h));
      const amountCol = findColIndex(headers, ["amount", "rate", "total"]);
      if (dateCol === -1 || videoCol === -1 || amountCol === -1) {
        showToast("Couldn't find Date / Video Num. / Amount columns — check the CSV headers match your sheet.", true);
        return;
      }
      let statusCol = headers.findIndex((h, idx) => idx !== dateCol && /paid|invoiced|status|done/i.test(h));
      if (statusCol === -1) statusCol = headers.length - 1;

      const newItems = [];
      let skippedInvoiced = 0;
      rows.slice(1).forEach(r => {
        const dateVal = (r[dateCol] || "").trim();
        const videoVal = (r[videoCol] || "").trim();
        if (!dateVal && !videoVal) return;
        const statusVal = (r[statusCol] || "").trim().toUpperCase();
        if (statusVal === "TRUE") { skippedInvoiced++; return; }
        const rate = parseFloat((r[amountCol] || "").replace(/[^0-9.\-]/g, "")) || 0;
        newItems.push({ desc: `${dateVal} Vid ${videoVal}`, qty: 1, rate });
      });

      if (newItems.length === 0) {
        showToast("No unchecked rows to import — everything in that sheet is already marked invoiced.", true);
        return;
      }
      const skipNote = skippedInvoiced ? ` (${skippedInvoiced} already-invoiced row(s) skipped)` : "";
      confirmAction(`Import ${newItems.length} row(s) as invoice items${skipNote}? This replaces the current item rows.`, () => {
        $("#itemsContainer").innerHTML = "";
        newItems.forEach(addItemRow);
        handleFormChange();
        showToast(`Imported ${newItems.length} item(s) from CSV.`);
      });
    } catch (e) {
      console.error(e);
      showToast("Couldn't read that CSV file.", true);
    }
  };
  reader.readAsText(file);
}

/* ==========================================================================
   5. CALCULATIONS
   ========================================================================== */
function calcTotals() {
  const items = getItems();
  const subtotal = items.reduce((s, i) => s + i.total, 0);
  const discountEnabled = $("#discountEnabled")?.checked ?? false;
  const advanceEnabled = $("#advanceEnabled")?.checked ?? false;
  const discountRateInput = parseFloat($("#discountRate").value) || 0;
  const discountRate = discountEnabled ? discountRateInput : 0;
  const taxRate = parseFloat($("#taxRate").value) || 0;
  const advanceInput = parseFloat($("#advancePayment").value) || 0;
  const discountAmount = subtotal * (discountRate / 100);
  const taxable = subtotal - discountAmount;
  const taxAmount = taxable * (taxRate / 100);
  const grandTotal = taxable + taxAmount;
  const advancePayment = advanceEnabled ? Math.min(Math.max(advanceInput, 0), grandTotal) : 0;
  const balanceDue = Math.max(0, grandTotal - advancePayment);
  return { items, subtotal, discountEnabled, discountRate, discountAmount, taxRate, taxAmount, grandTotal, advanceEnabled, advancePayment, balanceDue };
}

/* ==========================================================================
   6. FORM <-> STATE
   ========================================================================== */
function collectFormData() {
  const t = calcTotals();
  return {
    invoiceNumber: $("#invoiceNumber").value,
    status: $("#invoiceStatus").value,
    includeStatus: $("#includeStatus").checked,
    invoiceDate: $("#invoiceDate").value,
    dueDate: $("#dueDate").value,
    includeDueDate: $("#includeDueDate").checked,
    currency: $("#currency").value,
    client: {
      company: $("#clientCompany").value,
      name: $("#clientName").value,
      email: $("#clientEmail").value,
      country: $("#clientCountry").value,
      address: $("#clientAddress").value
    },
    items: t.items,
    discountEnabled: t.discountEnabled,
    discountRate: t.discountRate,
    taxRate: t.taxRate,
    advanceEnabled: t.advanceEnabled,
    advancePayment: t.advancePayment,
    balanceDue: t.balanceDue,
    paymentTerms: $("#paymentTerms").value,
    notes: $("#notes").value,
    thankYouMessage: $("#thankYouMessage").value,
    latePaymentPolicy: $("#latePaymentPolicy").value,
    grandTotal: t.grandTotal
  };
}
function populateForm(data, historyId) {
  loadedHistoryId = historyId || null;
  $("#invoiceNumber").value = data.invoiceNumber || nextInvoiceNumber();
  $("#invoiceStatus").value = data.status || "Draft";
  $("#includeStatus").checked = data.includeStatus !== false;
  $("#invoiceStatus").disabled = !$("#includeStatus").checked;
  $("#invoiceDate").value = data.invoiceDate || todayISO();
  $("#dueDate").value = data.dueDate || addDaysISO(todayISO(), 7);
  $("#includeDueDate").checked = data.includeDueDate !== false;
  $("#dueDate").disabled = !$("#includeDueDate").checked;
  $("#currency").value = data.currency || CONFIG.currency;
  $("#clientCompany").value = data.client?.company || "";
  $("#clientName").value = data.client?.name || "";
  $("#clientEmail").value = data.client?.email || "";
  $("#clientCountry").value = data.client?.country || "";
  $("#clientAddress").value = data.client?.address || "";
  $("#itemsContainer").innerHTML = "";
  (data.items && data.items.length ? data.items : [{ desc: "", qty: 1, rate: 0 }]).forEach(addItemRow);
  $("#discountRate").value = data.discountRate != null ? data.discountRate : CONFIG.discountRate;
  $("#discountEnabled").checked = data.discountEnabled != null ? data.discountEnabled : (parseFloat(data.discountRate) || 0) > 0;
  $("#discountRate").disabled = !$("#discountEnabled").checked;
  $("#advancePayment").value = data.advancePayment != null ? data.advancePayment : 0;
  $("#advanceEnabled").checked = data.advanceEnabled === true;
  $("#advancePayment").disabled = !$("#advanceEnabled").checked;
  $("#taxRate").value = data.taxRate != null ? data.taxRate : CONFIG.taxRate;
  $("#paymentTerms").value = data.paymentTerms || CONFIG.paymentTerms;
  $("#notes").value = data.notes || CONFIG.notes;
  $("#thankYouMessage").value = data.thankYouMessage || CONFIG.thankYouMessage;
  $("#latePaymentPolicy").value = data.latePaymentPolicy || CONFIG.latePaymentPolicy;
  refreshItemTotals();
  renderPreview();
}
function resetToNewInvoice() {
  populateForm({ invoiceNumber: nextInvoiceNumber() });
  selectedClientId = null;
  $("#clientSearch").value = "";
  hideValidation();
}

/* ==========================================================================
   7. LIVE PREVIEW
   ========================================================================== */
function renderPreview() {
  const t = calcTotals();
  const currency = $("#currency").value;

  $("#pvBusinessName").textContent = CONFIG.businessName;
  $("#pvOwnerName").textContent = CONFIG.ownerName;
  $("#pvAddress").textContent = CONFIG.address + (CONFIG.country ? ", " + CONFIG.country : "");
  $("#pvContact").textContent = [CONFIG.email, CONFIG.phone].filter(Boolean).join(" \u00B7 ");
  const pvPortfolio = $("#pvPortfolio");
  if (CONFIG.portfolio) {
    pvPortfolio.innerHTML = `<a href="${escapeHtml(CONFIG.portfolio)}" target="_blank" rel="noopener">${escapeHtml(CONFIG.portfolio)}</a>`;
    pvPortfolio.classList.remove("hidden");
  } else {
    pvPortfolio.textContent = "";
    pvPortfolio.classList.add("hidden");
  }

  $("#pvInvoiceNumber").textContent = $("#invoiceNumber").value;
  $("#pvInvoiceDate").textContent = formatDateDisplay($("#invoiceDate").value);
  $("#pvDueDate").textContent = formatDateDisplay($("#dueDate").value);
  $("#pvDueDateRow").classList.toggle("hidden", !$("#includeDueDate").checked);
  $("#pvStatus").textContent = $("#invoiceStatus").value;
  $("#pvStatusRow").classList.toggle("hidden", !$("#includeStatus").checked);

  $("#pvClientCompany").textContent = $("#clientCompany").value;
  $("#pvClientName").textContent = $("#clientName").value;
  $("#pvClientAddress").textContent = $("#clientAddress").value;
  $("#pvClientEmail").textContent = $("#clientEmail").value;

  const body = $("#pvItemsBody");
  body.innerHTML = "";
  t.items.forEach(i => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(i.desc)}</td><td>${i.qty}</td><td>${formatMoney(i.rate, currency)}</td><td>${formatMoney(i.total, currency)}</td>`;
    body.appendChild(tr);
  });

  $("#pvSubtotal").textContent = formatMoney(t.subtotal, currency);
  $("#pvDiscount").textContent = t.discountRate ? "-" + formatMoney(t.discountAmount, currency) + ` (${t.discountRate}%)` : formatMoney(0, currency);
  $("#pvDiscountRow").classList.toggle("hidden", !t.discountEnabled);
  $("#pvTax").textContent = formatMoney(t.taxAmount, currency) + (t.taxRate ? ` (${t.taxRate}%)` : "");
  $("#pvInvoiceTotal").textContent = formatMoney(t.grandTotal, currency);
  $("#pvInvoiceTotalRow").classList.toggle("hidden", !t.advanceEnabled);
  $("#pvAdvance").textContent = "-" + formatMoney(t.advancePayment, currency);
  $("#pvAdvanceRow").classList.toggle("hidden", !t.advanceEnabled);
  $("#pvGrandTotal").textContent = formatMoney(t.balanceDue, currency);

  const pm = $("#pvPaymentMethods");
  pm.innerHTML = "";
  const methods = [
    CONFIG.showPaypal && CONFIG.paypal ? ["PayPal", CONFIG.paypal] : null,
    CONFIG.showWise && CONFIG.wise ? ["Wise", CONFIG.wise] : null,
    CONFIG.showUpi && CONFIG.upi ? ["UPI", CONFIG.upi] : null,
    CONFIG.showBank && CONFIG.bankDetails ? ["Bank Transfer", CONFIG.bankDetails] : null,
    CONFIG.showPaymentLink && CONFIG.paymentLink ? ["Payment Link", CONFIG.paymentLink] : null
  ].filter(Boolean);
  if (methods.length === 0) {
    pm.innerHTML = "<div>No payment methods configured yet — add them in Settings.</div>";
  } else {
    methods.forEach(([label, val]) => {
      const div = document.createElement("div");
      const isUrl = /^https?:\/\//i.test(val.trim());
      const valueHtml = isUrl
        ? `<a href="${escapeHtml(val)}" target="_blank" rel="noopener">${escapeHtml(val)}</a>`
        : escapeHtml(val);
      div.innerHTML = `<span>${label}:</span> ${valueHtml}`;
      pm.appendChild(div);
    });
  }

  $("#pvPaymentTerms").textContent = $("#paymentTerms").value;
  $("#pvNotes").textContent = $("#notes").value;
  $("#pvLatePolicy").textContent = $("#latePaymentPolicy").value;
  $("#pvThankYou").textContent = $("#thankYouMessage").value;

  $("#logoImg").src = CONFIG.logoPath;
}
function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function handleFormChange() {
  refreshItemTotals();
  renderPreview();
}

/* ==========================================================================
   8. VALIDATION
   ========================================================================== */
function hideValidation() { $("#validationBanner").classList.add("hidden"); }
function runValidation() {
  const problems = [];
  const data = collectFormData();
  if (!data.client.company && !data.client.name) problems.push("Client name is missing.");
  if (data.items.length === 0 || data.items.every(i => !i.desc)) problems.push("No invoice items entered.");
  if (data.grandTotal === 0) problems.push("Invoice total is zero.");
  const dupe = history.find(h => h.number === data.invoiceNumber && h.id !== loadedHistoryId);
  if (dupe) problems.push(`Invoice number ${data.invoiceNumber} has already been used. Click New for the next number, or pick a different one.`);
  const banner = $("#validationBanner");
  if (problems.length) {
    banner.innerHTML = "\u26A0 " + problems.join(" &nbsp;\u00B7&nbsp; ");
    banner.classList.remove("hidden");
    return false;
  }
  hideValidation();
  return true;
}

/* ==========================================================================
   9. CLIENTS
   ========================================================================== */
function renderClientList() {
  const list = $("#clientList");
  list.innerHTML = "";
  clients.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c.company || c.name;
    opt.dataset.id = c.id;
    list.appendChild(opt);
  });
}
function findClientByLabel(label) {
  return clients.find(c => (c.company || c.name) === label);
}
function initClientSearch() {
  $("#clientSearch").addEventListener("input", (e) => {
    const match = findClientByLabel(e.target.value);
    if (match) {
      selectedClientId = match.id;
      $("#clientCompany").value = match.company || "";
      $("#clientName").value = match.name || "";
      $("#clientEmail").value = match.email || "";
      $("#clientCountry").value = match.country || "";
      $("#clientAddress").value = match.address || "";
      handleFormChange();
    }
  });
}
function saveCurrentAsClient() {
  const company = $("#clientCompany").value.trim();
  const name = $("#clientName").value.trim();
  if (!company && !name) { showToast("Enter a client name or company first.", true); return; }
  const existing = clients.find(c => (c.company || c.name) === (company || name));
  if (existing) { showToast("A client with that name already exists — use Update Selected instead.", true); return; }
  const client = {
    id: uid(), company, name,
    email: $("#clientEmail").value.trim(),
    country: $("#clientCountry").value.trim(),
    address: $("#clientAddress").value.trim()
  };
  clients.push(client);
  saveJSON(STORE_KEYS.clients, clients);
  selectedClientId = client.id;
  renderClientList();
  showToast("Client saved.");
}
function updateSelectedClient() {
  if (!selectedClientId) { showToast("No client selected. Search and pick one first.", true); return; }
  const c = clients.find(c => c.id === selectedClientId);
  if (!c) return;
  c.company = $("#clientCompany").value.trim();
  c.name = $("#clientName").value.trim();
  c.email = $("#clientEmail").value.trim();
  c.country = $("#clientCountry").value.trim();
  c.address = $("#clientAddress").value.trim();
  saveJSON(STORE_KEYS.clients, clients);
  renderClientList();
  showToast("Client updated.");
}
function deleteSelectedClient() {
  if (!selectedClientId) { showToast("No client selected.", true); return; }
  confirmAction("Delete this saved client?", () => {
    clients = clients.filter(c => c.id !== selectedClientId);
    saveJSON(STORE_KEYS.clients, clients);
    selectedClientId = null;
    renderClientList();
    showToast("Client deleted.");
  });
}

/* ==========================================================================
   10. DRAFTS
   ========================================================================== */
function saveDraft() {
  const data = collectFormData();
  const existing = drafts.find(d => d.number === data.invoiceNumber);
  const entry = {
    id: existing ? existing.id : uid(),
    number: data.invoiceNumber,
    client: data.client.company || data.client.name || "(no client)",
    savedAt: new Date().toISOString(),
    snapshot: data
  };
  if (existing) Object.assign(existing, entry); else drafts.push(entry);
  saveJSON(STORE_KEYS.drafts, drafts);
  showToast("Draft saved.");
}
function renderDrafts() {
  const body = $("#draftsTableBody");
  body.innerHTML = "";
  if (drafts.length === 0) {
    body.innerHTML = `<tr><td colspan="4">No saved drafts yet.</td></tr>`;
    return;
  }
  drafts.slice().reverse().forEach(d => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(d.number)}</td><td>${escapeHtml(d.client)}</td><td>${formatDateDisplay(d.savedAt.slice(0,10))}</td>
      <td>
        <button class="btn btn-tertiary" data-load="${d.id}">Load</button>
        <button class="btn btn-danger-outline" data-del="${d.id}">Delete</button>
      </td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll("[data-load]").forEach(btn => btn.addEventListener("click", () => {
    const d = drafts.find(x => x.id === btn.dataset.load);
    populateForm(d.snapshot);
    closeModal("#draftsModal");
    showToast("Draft loaded.");
  }));
  body.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", () => {
    confirmAction("Delete this draft?", () => {
      drafts = drafts.filter(x => x.id !== btn.dataset.del);
      saveJSON(STORE_KEYS.drafts, drafts);
      renderDrafts();
      showToast("Draft deleted.");
    });
  }));
}

/* ==========================================================================
   11. HISTORY
   ========================================================================== */
function addToHistory(data) {
  const fields = {
    number: data.invoiceNumber,
    client: data.client.company || data.client.name || "(no client)",
    amount: data.grandTotal,
    currency: data.currency,
    date: data.invoiceDate,
    status: data.status,
    snapshot: data
  };
  const existing = loadedHistoryId ? history.find(h => h.id === loadedHistoryId) : null;
  if (existing) {
    Object.assign(existing, fields);
  } else {
    const entry = Object.assign({ id: uid() }, fields);
    history.push(entry);
    loadedHistoryId = entry.id;
  }
  saveJSON(STORE_KEYS.history, history);

  const numeric = parseInt(String(data.invoiceNumber).replace(/\D/g, ""), 10);
  if (!isNaN(numeric) && numeric > lastNumber) {
    lastNumber = numeric;
    saveJSON(STORE_KEYS.lastNumber, lastNumber);
  }
}
function renderHistory(filter) {
  const body = $("#historyTableBody");
  body.innerHTML = "";
  const rows = history.filter(h => {
    if (!filter) return true;
    const f = filter.toLowerCase();
    return h.number.toLowerCase().includes(f) || h.client.toLowerCase().includes(f);
  }).slice().reverse();
  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="6">No invoices generated yet.</td></tr>`;
    return;
  }
  rows.forEach(h => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(h.number)}</td><td>${escapeHtml(h.client)}</td><td>${formatMoney(h.amount, h.currency)}</td><td>${formatDateDisplay(h.date)}</td><td>${h.status}</td>
      <td>
        <button class="btn btn-tertiary" data-open="${h.id}">Open</button>
        <button class="btn btn-tertiary" data-dupe="${h.id}">Duplicate</button>
        <button class="btn btn-danger-outline" data-del="${h.id}">Delete</button>
      </td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll("[data-open]").forEach(btn => btn.addEventListener("click", () => {
    const h = history.find(x => x.id === btn.dataset.open);
    populateForm(h.snapshot, h.id);
    closeModal("#historyModal");
    showToast("Invoice loaded.");
  }));
  body.querySelectorAll("[data-dupe]").forEach(btn => btn.addEventListener("click", () => {
    duplicateFromHistory(btn.dataset.dupe);
    closeModal("#historyModal");
  }));
  body.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", () => {
    confirmAction("Delete this invoice from history?", () => {
      history = history.filter(x => x.id !== btn.dataset.del);
      saveJSON(STORE_KEYS.history, history);
      renderHistory($("#historySearch").value);
      showToast("Removed from history.");
    });
  }));
}
function duplicateFromHistory(id) {
  const h = history.find(x => x.id === id);
  if (!h) return;
  const data = JSON.parse(JSON.stringify(h.snapshot));
  data.invoiceNumber = nextInvoiceNumber();
  data.invoiceDate = todayISO();
  data.dueDate = addDaysISO(todayISO(), 7);
  data.status = "Draft";
  populateForm(data);
  showToast("Duplicated as " + data.invoiceNumber + ". Review and generate when ready.");
}
function duplicateCurrentInvoice() {
  const data = collectFormData();
  data.invoiceNumber = nextInvoiceNumber();
  data.invoiceDate = todayISO();
  data.dueDate = addDaysISO(todayISO(), 7);
  data.status = "Draft";
  populateForm(data);
  showToast("Duplicated as " + data.invoiceNumber + ".");
}

/* ==========================================================================
   12. PDF EXPORT (browser print — no external libraries required)
   ========================================================================== */
function generatePdf() {
  if (!runValidation()) { showToast("Fix the issues above before generating a PDF.", true); return; }
  const data = collectFormData();
  addToHistory(data);
  const clientName = (data.client.company || data.client.name || "Client").replace(/[^\w\- ]/g, "").trim().replace(/\s+/g, "-");
  const suggestedName = `Invoice-${data.invoiceNumber}-${clientName}`;
  const originalTitle = document.title;
  document.title = suggestedName;
  window.addEventListener("afterprint", function restoreTitle() {
    document.title = originalTitle;
    window.removeEventListener("afterprint", restoreTitle);
  });
  window.print();
  showToast("Saved to history. Use your browser's Save-as-PDF option in the print dialog.");
}
function emailInvoice() {
  const data = collectFormData();
  const to = data.client.email || "";
  const subject = encodeURIComponent(`Invoice ${data.invoiceNumber} from ${CONFIG.businessName}`);
  const body = encodeURIComponent(
    `Hi ${data.client.name || ""},\n\nPlease find invoice ${data.invoiceNumber} with a balance due of ${formatMoney(data.balanceDue, data.currency)}, due ${formatDateDisplay(data.dueDate)}.\n\n${CONFIG.thankYouMessage}\n\n${CONFIG.businessName}`
  );
  window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
  showToast("Opening your mail client. Generate and attach the PDF manually — browsers can't attach files automatically.");
}

/* ==========================================================================
   13. DASHBOARD
   ========================================================================== */
function renderDashboard() {
  const total = history.length;
  const totalEarnings = history.reduce((s, h) => s + h.amount, 0);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthEarnings = history.filter(h => h.date && h.date.slice(0, 7) === thisMonth).reduce((s, h) => s + h.amount, 0);
  const outstanding = history.filter(h => h.status === "Sent" || h.status === "Overdue").reduce((s, h) => s + (h.snapshot?.balanceDue != null ? h.snapshot.balanceDue : h.amount), 0);

  $("#statTotalInvoices").textContent = total;
  $("#statTotalEarnings").textContent = formatMoney(totalEarnings, CONFIG.currency);
  $("#statMonthEarnings").textContent = formatMoney(monthEarnings, CONFIG.currency);
  $("#statOutstanding").textContent = formatMoney(outstanding, CONFIG.currency);

  const byClient = {};
  history.forEach(h => { byClient[h.client] = (byClient[h.client] || 0) + h.amount; });
  const top = Object.entries(byClient).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const list = $("#topClientsList");
  list.innerHTML = top.length
    ? top.map(([name, amt]) => `<li>${escapeHtml(name)} — ${formatMoney(amt, CONFIG.currency)}</li>`).join("")
    : "<li>No invoices yet.</li>";
}

/* ==========================================================================
   14. SETTINGS MODAL
   ========================================================================== */
function populateSettingsForm() {
  $("#cfgBusinessName").value = CONFIG.businessName;
  $("#cfgOwnerName").value = CONFIG.ownerName;
  $("#cfgEmail").value = CONFIG.email;
  $("#cfgPhone").value = CONFIG.phone;
  $("#cfgWebsite").value = CONFIG.website;
  $("#cfgPortfolio").value = CONFIG.portfolio;
  $("#cfgCountry").value = CONFIG.country;
  $("#cfgTaxId").value = CONFIG.taxId;
  $("#cfgGst").value = CONFIG.gst;
  $("#cfgAddress").value = CONFIG.address;

  $("#cfgShowPaypal").checked = CONFIG.showPaypal; $("#cfgPaypal").value = CONFIG.paypal;
  $("#cfgShowWise").checked = CONFIG.showWise; $("#cfgWise").value = CONFIG.wise;
  $("#cfgShowUpi").checked = CONFIG.showUpi; $("#cfgUpi").value = CONFIG.upi;
  $("#cfgShowLink").checked = CONFIG.showPaymentLink; $("#cfgPaymentLink").value = CONFIG.paymentLink;
  $("#cfgShowBank").checked = CONFIG.showBank; $("#cfgBankDetails").value = CONFIG.bankDetails;

  $("#cfgCurrency").value = CONFIG.currency;
  $("#cfgTaxRate").value = CONFIG.taxRate;
  $("#cfgDiscountRate").value = CONFIG.discountRate;
  $("#cfgAccentColor").value = CONFIG.accentColor;
  $("#cfgPaymentTerms").value = CONFIG.paymentTerms;
  $("#cfgNotes").value = CONFIG.notes;
  $("#cfgThankYou").value = CONFIG.thankYouMessage;
  $("#cfgLatePolicy").value = CONFIG.latePaymentPolicy;
}
function saveSettingsForm() {
  CONFIG = {
    businessName: $("#cfgBusinessName").value,
    ownerName: $("#cfgOwnerName").value,
    email: $("#cfgEmail").value,
    phone: $("#cfgPhone").value,
    website: $("#cfgWebsite").value,
    portfolio: $("#cfgPortfolio").value,
    country: $("#cfgCountry").value,
    taxId: $("#cfgTaxId").value,
    gst: $("#cfgGst").value,
    address: $("#cfgAddress").value,
    logoPath: CONFIG.logoPath,

    showPaypal: $("#cfgShowPaypal").checked, paypal: $("#cfgPaypal").value,
    showWise: $("#cfgShowWise").checked, wise: $("#cfgWise").value,
    showUpi: $("#cfgShowUpi").checked, upi: $("#cfgUpi").value,
    showPaymentLink: $("#cfgShowLink").checked, paymentLink: $("#cfgPaymentLink").value,
    showBank: $("#cfgShowBank").checked, bankDetails: $("#cfgBankDetails").value,

    currency: $("#cfgCurrency").value,
    taxRate: parseFloat($("#cfgTaxRate").value) || 0,
    discountRate: parseFloat($("#cfgDiscountRate").value) || 0,
    accentColor: $("#cfgAccentColor").value,
    paymentTerms: $("#cfgPaymentTerms").value,
    notes: $("#cfgNotes").value,
    thankYouMessage: $("#cfgThankYou").value,
    latePaymentPolicy: $("#cfgLatePolicy").value
  };
  saveJSON(STORE_KEYS.settings, CONFIG);
  applyAccentColor();
  renderPreview();
  closeModal("#settingsModal");
  showToast("Settings saved.");
}
function applyAccentColor() {
  document.documentElement.style.setProperty("--color-accent", CONFIG.accentColor || DEFAULT_CONFIG.accentColor);
}

/* ==========================================================================
   15. IMPORT / EXPORT
   ========================================================================== */
function exportAllData() {
  const payload = buildBackupPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `invoice-generator-backup-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Data exported.");
}
function importAllData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);
      applyBackupPayload(payload);
      scheduleSync();
      showToast("Data imported successfully.");
    } catch (e) {
      showToast("Import failed — file isn't valid backup JSON.", true);
    }
  };
  reader.readAsText(file);
}

/* ==========================================================================
   16. THEME
   ========================================================================== */
function initTheme() {
  const saved = localStorage.getItem(STORE_KEYS.theme) || "light";
  document.body.setAttribute("data-theme", saved);
  $("#btnTheme").textContent = saved === "dark" ? "\u2600\uFE0F" : "\uD83C\uDF19";
}
function toggleTheme() {
  const current = document.body.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.body.setAttribute("data-theme", next);
  localStorage.setItem(STORE_KEYS.theme, next);
  scheduleSync();
  $("#btnTheme").textContent = next === "dark" ? "\u2600\uFE0F" : "\uD83C\uDF19";
}

/* ==========================================================================
   17. EVENT BINDING / INIT
   ========================================================================== */
function bindEvents() {
  $("#includeDueDate").addEventListener("change", (e) => { $("#dueDate").disabled = !e.target.checked; });
  $("#includeStatus").addEventListener("change", (e) => { $("#invoiceStatus").disabled = !e.target.checked; });
  $("#discountEnabled").addEventListener("change", (e) => { $("#discountRate").disabled = !e.target.checked; handleFormChange(); });
  $("#advanceEnabled").addEventListener("change", (e) => { $("#advancePayment").disabled = !e.target.checked; handleFormChange(); });

  $("#btnAddItem").addEventListener("click", () => { addItemRow(); handleFormChange(); });
  $("#btnImportCsv").addEventListener("click", () => $("#csvFileInput").click());
  $("#csvFileInput").addEventListener("change", (e) => {
    if (e.target.files[0]) handleCsvImport(e.target.files[0]);
    e.target.value = "";
  });
  $all("#formPane input, #formPane select, #formPane textarea").forEach(el => {
    el.addEventListener("input", handleFormChange);
    el.addEventListener("change", handleFormChange);
  });

  $("#btnNewInvoice").addEventListener("click", () => confirmAction("Start a new invoice? Unsaved changes will be lost unless you save a draft first.", resetToNewInvoice));
  $("#btnSaveDraft").addEventListener("click", saveDraft);
  $("#btnGeneratePdf").addEventListener("click", generatePdf);
  $("#btnDuplicateInvoice").addEventListener("click", duplicateCurrentInvoice);
  $("#btnEmailInvoice").addEventListener("click", emailInvoice);

  $("#btnSaveClient").addEventListener("click", saveCurrentAsClient);
  $("#btnEditClient").addEventListener("click", updateSelectedClient);
  $("#btnDeleteClient").addEventListener("click", deleteSelectedClient);

  $("#btnSettings").addEventListener("click", () => { populateSettingsForm(); refreshDataFolderSettingsUI(); openModal("#settingsModal"); });
  $("#btnSaveSettings").addEventListener("click", saveSettingsForm);
  $("#btnExportData").addEventListener("click", exportAllData);
  $("#btnImportData").addEventListener("click", () => $("#importFileInput").click());
  $("#importFileInput").addEventListener("change", (e) => { if (e.target.files[0]) importAllData(e.target.files[0]); });

  $("#btnDataFolder").addEventListener("click", () => { populateSettingsForm(); refreshDataFolderSettingsUI(); openModal("#settingsModal"); });
  $("#btnConnectFolder").addEventListener("click", connectDataFolder);
  $("#btnReconnectFolder").addEventListener("click", reconnectDataFolder);
  $("#btnDisconnectFolder").addEventListener("click", () => confirmAction("Stop syncing to this folder? Your data stays in the browser either way.", disconnectDataFolder));

  $("#btnHistory").addEventListener("click", () => { renderHistory(""); openModal("#historyModal"); });
  $("#historySearch").addEventListener("input", (e) => renderHistory(e.target.value));

  $("#btnDrafts").addEventListener("click", () => { renderDrafts(); openModal("#draftsModal"); });
  $("#btnDashboard").addEventListener("click", () => { renderDashboard(); openModal("#dashboardModal"); });

  $("#btnTheme").addEventListener("click", toggleTheme);

  $all("[data-close]").forEach(btn => btn.addEventListener("click", (e) => {
    e.target.closest(".modal-overlay").classList.add("hidden");
  }));
  $all(".modal-overlay").forEach(ov => ov.addEventListener("click", (e) => {
    if (e.target === ov) ov.classList.add("hidden");
  }));

  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key.toLowerCase() === "s") { e.preventDefault(); saveDraft(); }
    else if (e.key.toLowerCase() === "n") { e.preventDefault(); confirmAction("Start a new invoice?", resetToNewInvoice); }
    else if (e.key.toLowerCase() === "p") { e.preventDefault(); generatePdf(); }
  });
}

function init() {
  initTheme();
  applyAccentColor();
  bindEvents();
  initClientSearch();
  renderClientList();
  resetToNewInvoice();
  setSyncState(syncState);
  initFileSync();
}

document.addEventListener("DOMContentLoaded", init);
