'use strict';

// The scan UI for both Chrome and Firefox: an overlay injected into the real
// https://www.henryschein.nl page (see the content_scripts in both manifests). Firefox
// blocks navigator.serial on every moz-extension:// page (confirmed by testing), so the
// scanner can only be used from a content script on the https site; Chrome uses the
// same overlay so both browsers behave identically.
//
// Trade-off: if the henryschein.nl page reloads (e.g. navigating to the cart after an
// add), this content script is destroyed and re-created. So queue state lives in
// storage.local and is re-read on every (re-)injection; background.js writes each
// item's outcome there too.
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const STORAGE_KEY = 'hsScannerQueue';
const PANEL_OPEN_KEY = 'hsScannerPanelOpen';
// Set by background.js when the toolbar click opens the overlay; see autoReadScanner.
const AUTO_READ_KEY = 'hsScannerAutoReadRequested';

let queue = [];
let panelOpen = false;
let els = {};

function genId() {
  return crypto.randomUUID();
}

async function loadState() {
  const stored = await browserAPI.storage.local.get([STORAGE_KEY, PANEL_OPEN_KEY]);
  // Items already added to the cart are dropped here too, not only in the onChanged
  // listener: after a successful batch background.js navigates to the cart page, which
  // can reload this page before that listener got to remove them.
  queue = (stored[STORAGE_KEY] || []).filter((item) => item.status !== 'sent');
  panelOpen = !!stored[PANEL_OPEN_KEY];
}

async function saveQueue() {
  await browserAPI.storage.local.set({ [STORAGE_KEY]: queue });
}

function setPanelOpen(open) {
  panelOpen = open;
  els.panel.style.display = open ? 'flex' : 'none';
  browserAPI.storage.local.set({ [PANEL_OPEN_KEY]: open });
}

function buildPanel() {
  const host = document.createElement('div');
  host.id = 'hs-scanner-panel-host';
  document.documentElement.appendChild(host);
  const shadowRoot = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = browserAPI.runtime.getURL('content-panel.css');
  shadowRoot.appendChild(style);

  const wrap = document.createElement('div');
  wrap.id = 'panel';
  wrap.innerHTML = `
    <div id="panel-header">
      <span>Henry Schein &mdash; Barcode Bestellen</span>
      <button id="btnClosePanel" title="Sluiten">&times;</button>
    </div>
    <section>
      <h2>OPN-2001 (USB)</h2>
      <button id="btnConnectScanner">Verbinden &amp; uitlezen</button>
      <div class="log" id="scannerLog"></div>
      <label class="hand-scan-label" for="handScanInput">Geen Opticon CSP2 USB-scanner? Scan dan met een gewone handscanner in dit veld:</label>
      <input id="handScanInput" type="text" autocomplete="off" spellcheck="false" placeholder="Klik hier en scan…">
      <div class="log" id="handScanLog"></div>
    </section>
    <section>
      <h2>Wachtrij</h2>
      <table>
        <thead><tr><th>Artikel</th><th>Aantal</th><th>Status</th><th></th></tr></thead>
        <tbody id="queueBody"></tbody>
      </table>
      <p id="emptyHint"><em>Nog geen barcodes gescand.</em></p>
      <div class="actions">
        <button id="btnSend" disabled>Ga naar Henry Schein om te bestellen</button>
        <button id="btnClear" class="secondary">Wachtrij legen</button>
      </div>
      <div class="log" id="sendLog"></div>
    </section>
    <div id="panel-version"></div>
  `;
  shadowRoot.appendChild(wrap);

  els = {
    panel: wrap,
    queueBody: shadowRoot.getElementById('queueBody'),
    emptyHint: shadowRoot.getElementById('emptyHint'),
    btnSend: shadowRoot.getElementById('btnSend'),
    btnClear: shadowRoot.getElementById('btnClear'),
    sendLog: shadowRoot.getElementById('sendLog'),
    scannerLog: shadowRoot.getElementById('scannerLog'),
    handScanInput: shadowRoot.getElementById('handScanInput'),
    handScanLog: shadowRoot.getElementById('handScanLog'),
    btnConnectScanner: shadowRoot.getElementById('btnConnectScanner'),
    btnClosePanel: shadowRoot.getElementById('btnClosePanel'),
    versionTag: shadowRoot.getElementById('panel-version'),
  };
  els.versionTag.textContent = `v${browserAPI.runtime.getManifest().version}`;

  els.btnClosePanel.addEventListener('click', () => setPanelOpen(false));
  els.btnClear.addEventListener('click', async () => {
    queue = [];
    await saveQueue();
    renderQueue();
  });
  els.btnSend.addEventListener('click', onSend);
  els.btnConnectScanner.addEventListener('click', onConnectScanner);

  els.handScanInput.addEventListener('keydown', onHandScanKeydown);
  // Keystrokes typed here would otherwise bubble out of the shadow DOM into
  // henryschein.nl's own keyboard handlers (e.g. shortcuts or its search box).
  ['keypress', 'keyup'].forEach((type) => {
    els.handScanInput.addEventListener(type, (evt) => evt.stopPropagation());
  });
}

// What a scanned article code may look like. Anything else typed into the hand-scan
// field (a misread, a stray keystroke) is rejected instead of being sent to the site.
const SCANNED_CODE_PATTERN = /^[A-Za-z0-9-]{1,32}$/;

/**
 * Keyboard-wedge ("gewone") hand scanners type the barcode followed by Enter. On
 * Enter the code is queued and the field is cleared immediately — before the async
 * queue work — so the next scan, which can arrive within milliseconds, lands in an
 * empty field.
 * @param {KeyboardEvent} evt
 */
function onHandScanKeydown(evt) {
  evt.stopPropagation();
  if (evt.key !== 'Enter') return;
  evt.preventDefault();

  const code = els.handScanInput.value.trim();
  els.handScanInput.value = '';
  if (!code) return;
  if (!SCANNED_CODE_PATTERN.test(code)) {
    els.handScanLog.textContent = `Ongeldige barcode genegeerd: "${code.slice(0, 40)}"`;
    return;
  }
  els.handScanLog.textContent = `Toegevoegd: ${code}`;
  addToQueue(code, 1).catch((err) => {
    els.handScanLog.textContent = `Fout bij toevoegen van ${code}: ${err.message}`;
  });
}

function renderQueue() {
  els.queueBody.innerHTML = '';
  els.emptyHint.style.display = queue.length === 0 ? 'block' : 'none';
  els.btnSend.disabled = queue.length === 0 || !queue.some((item) => item.status === 'pending');

  queue.forEach((item) => {
    const tr = document.createElement('tr');
    // Code, name, and price/availability stacked in one cell: a separate price column
    // didn't fit the overlay's width (the status column fell off the right edge).
    const codeTd = document.createElement('td');
    codeTd.textContent = item.code;
    if (item.priceState === 'done' && item.priceInfo && item.priceInfo.name) {
      const nameEl = document.createElement('div');
      nameEl.className = 'item-name';
      nameEl.textContent = item.priceInfo.name;
      codeTd.appendChild(nameEl);
    }
    const priceText =
      item.priceState === 'loading'
        ? '...'
        : item.priceState === 'done' && item.priceInfo
          ? [item.priceInfo.price, item.priceInfo.availability].filter(Boolean).join(' — ')
          : '';
    if (priceText) {
      const priceEl = document.createElement('div');
      priceEl.className = 'item-price';
      priceEl.textContent = priceText;
      codeTd.appendChild(priceEl);
    }
    if (item.status === 'error' && item.error) {
      const errorEl = document.createElement('div');
      errorEl.className = 'item-error';
      errorEl.textContent = item.error;
      codeTd.appendChild(errorEl);
    }

    const qtyTd = document.createElement('td');
    const qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.min = '1';
    qtyInput.className = 'qty';
    qtyInput.value = String(item.qty);
    qtyInput.disabled = item.status !== 'pending';
    qtyInput.addEventListener('change', async () => {
      const parsed = parseInt(qtyInput.value, 10);
      item.qty = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
      qtyInput.value = String(item.qty);
      await saveQueue();
    });
    qtyTd.appendChild(qtyInput);

    const statusTd = document.createElement('td');
    statusTd.className = `status-${item.status}`;
    statusTd.textContent =
      item.status === 'pending' ? 'wachtend' : item.status === 'sent' ? 'toegevoegd' : 'fout';

    const actionsTd = document.createElement('td');
    actionsTd.className = 'row-actions';
    // Failed items stay in the list (sent ones are removed), so they must be removable too.
    if (item.status === 'pending' || item.status === 'error') {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'secondary';
      removeBtn.textContent = '×';
      removeBtn.title = 'Verwijderen';
      removeBtn.addEventListener('click', async () => {
        queue = queue.filter((q) => q.id !== item.id);
        await saveQueue();
        renderQueue();
      });
      actionsTd.appendChild(removeBtn);
    }

    tr.append(codeTd, qtyTd, statusTd, actionsTd);
    els.queueBody.appendChild(tr);
  });
}

/**
 * Best-effort name/price/availability lookup for one queue item — does not add it to
 * the cart. Leaves the cell empty on failure (a convenience, not worth an error in the
 * UI), but logs the reason to the console so a failure is never silent.
 * @param {{id: string, code: string, qty: number}} item
 */
async function lookupPrice(item) {
  item.priceState = 'loading';
  renderQueue();
  try {
    // Bounded, so a hung lookup ends as a logged failure instead of "..." forever.
    const res = await Promise.race([
      browserAPI.runtime.sendMessage({ type: 'LOOKUP_INFO', code: item.code, qty: item.qty }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Time-out na 10s.')), 10000)),
    ]);
    if (res && res.ok) {
      if (res.data.nameError) console.warn(`Naam niet opgehaald voor "${item.code}": ${res.data.nameError}`);
      if (res.data.priceError) console.warn(`Prijs niet opgehaald voor "${item.code}": ${res.data.priceError}`);
      item.priceInfo = res.data;
      item.priceState = 'done';
    } else {
      console.error(`Prijs/naam ophalen mislukt voor "${item.code}":`, res && res.error);
      item.priceState = 'idle';
    }
  } catch (err) {
    console.error(`Prijs/naam ophalen mislukt voor "${item.code}":`, err);
    item.priceState = 'idle';
  }
  await saveQueue();
  renderQueue();
}

async function addToQueue(code, qty = 1) {
  const existing = queue.find((item) => item.code === code && item.status === 'pending');
  if (existing) {
    existing.qty += qty;
  } else {
    const item = { id: genId(), code, qty, status: 'pending', priceInfo: null, priceState: 'idle' };
    queue.push(item);
    lookupPrice(item);
  }
  await saveQueue();
  renderQueue();
  setPanelOpen(true);
}

async function onSend() {
  const pendingItems = queue.filter((item) => item.status === 'pending');
  if (pendingItems.length === 0) return;

  els.btnSend.disabled = true;
  els.sendLog.textContent = `Bezig: ${pendingItems.length} artikel(en) versturen...`;

  try {
    await browserAPI.runtime.sendMessage({
      type: 'ADD_TO_CART',
      items: pendingItems.map((item) => ({ id: item.id, code: item.code, qty: item.qty })),
    });
  } catch (err) {
    els.sendLog.textContent = `Fout: ${err.message}`;
    els.btnSend.disabled = false;
  }
}

// storage.local persists across the page reloads QuickAddItemHarmony triggers, so
// this is how progress written by background.js reaches the UI, whichever
// content-panel instance happens to be alive when it lands. It's also how the toolbar
// icon opens/closes the panel (background.js writes PANEL_OPEN_KEY directly instead of
// sending a runtime message): a message sent to a just-created tab can arrive before
// this content script has registered a listener and gets silently dropped, but a
// storage write has no such race — it's either already in storage when loadState()
// runs at startup, or picked up here once it lands.
browserAPI.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes[STORAGE_KEY]) {
    // Only take over item STATUSES from storage (the one thing background.js writes
    // there), never replace the in-memory queue wholesale. onChanged also fires for this
    // panel's own saveQueue() writes, asynchronously — replacing the queue with such a
    // snapshot overwrote newer in-memory state: merged quantities were lost (16 scans
    // read, quantities summing to 9) and lookup results landed on detached objects, so
    // names/prices never appeared.
    const storedById = new Map((changes[STORAGE_KEY].newValue || []).map((stored) => [stored.id, stored]));
    queue.forEach((item) => {
      const stored = storedById.get(item.id);
      if (stored) {
        item.status = stored.status;
        item.error = stored.error;
      }
    });

    // Items that made it into the cart leave the list; failed ones stay, marked.
    const sentCount = queue.filter((item) => item.status === 'sent').length;
    if (sentCount > 0) {
      queue = queue.filter((item) => item.status !== 'sent');
      saveQueue();
    }
    renderQueue();

    const failedCount = queue.filter((item) => item.status === 'error').length;
    if (failedCount > 0) {
      els.sendLog.textContent = `${sentCount} toegevoegd, ${failedCount} niet toegevoegd (rood in de lijst).`;
    } else if (sentCount > 0) {
      els.sendLog.textContent = `${sentCount} artikel(en) toegevoegd aan het winkelmandje.`;
    }
  }

  if (changes[PANEL_OPEN_KEY] && els.panel) {
    panelOpen = !!changes[PANEL_OPEN_KEY].newValue;
    els.panel.style.display = panelOpen ? 'flex' : 'none';
  }

  // Before the panel exists, the startup sequence consumes the request instead.
  if (changes[AUTO_READ_KEY] && changes[AUTO_READ_KEY].newValue === true && els.panel) {
    consumeAutoReadRequest();
  }
});

/* ---------- OPN-2001 (Web Serial / CSP2 protocol) ---------- */

const CSP2 = {
  STX: 0x02,
  INTERROGATE_CMD: 0x01,
  CLEAR_BAR_CODES_CMD: 0x02,
  UPLOAD_BAR_CODE_DATA_CMD: 0x07,
  POWER_DOWN_CMD: 0x05,
  SET_TIME_CMD: 0x09,
  GET_TIME_CMD: 0x0a,
  TEMPORARY_ERROR: 0x05,
  ACK: 0x06,
};

// TEMPORARY, for debugging: skips clearing the scanner's memory after a read, so the
// same barcodes can be re-scanned repeatedly without re-presenting them to the device.
// Set back to false before real use, or old scans will keep reappearing on every read.
//const DEBUG_SKIP_SCANNER_CLEAR = true;

// TEMPORARY, for testing without the scanner at hand: these codes are put in the queue
// when the panel starts with an empty queue, as if just read from the scanner.
// Set to [] before real use.
//const DEBUG_FAKE_SCAN_CODES = ['824240', '9882042', '1091112', '809755', '1046352', '7142723', '477644'];

// USB vendor ID for Opticon Sensors Europe / Optoelectronics Co. (confirmed via
// `lsusb` against a physical OPN-2001: "ID 065a:0009 ... OPN-2001 [Opticon]").
const OPTICON_USB_VENDOR_ID = 0x065a;

const CRCTAB16 = new Uint16Array([
  0x0000, 0xc0c1, 0xc181, 0x0140, 0xc301, 0x03c0, 0x0280, 0xc241, 0xc601, 0x06c0, 0x0780, 0xc741,
  0x0500, 0xc5c1, 0xc481, 0x0440, 0xcc01, 0x0cc0, 0x0d80, 0xcd41, 0x0f00, 0xcfc1, 0xce81, 0x0e40,
  0x0a00, 0xcac1, 0xcb81, 0x0b40, 0xc901, 0x09c0, 0x0880, 0xc841, 0xd801, 0x18c0, 0x1980, 0xd941,
  0x1b00, 0xdbc1, 0xda81, 0x1a40, 0x1e00, 0xdec1, 0xdf81, 0x1f40, 0xdd01, 0x1dc0, 0x1c80, 0xdc41,
  0x1400, 0xd4c1, 0xd581, 0x1540, 0xd701, 0x17c0, 0x1680, 0xd641, 0xd201, 0x12c0, 0x1380, 0xd341,
  0x1100, 0xd1c1, 0xd081, 0x1040, 0xf001, 0x30c0, 0x3180, 0xf141, 0x3300, 0xf3c1, 0xf281, 0x3240,
  0x3600, 0xf6c1, 0xf781, 0x3740, 0xf501, 0x35c0, 0x3480, 0xf441, 0x3c00, 0xfcc1, 0xfd81, 0x3d40,
  0xff01, 0x3fc0, 0x3e80, 0xfe41, 0xfa01, 0x3ac0, 0x3b80, 0xfb41, 0x3900, 0xf9c1, 0xf881, 0x3840,
  0x2800, 0xe8c1, 0xe981, 0x2940, 0xeb01, 0x2bc0, 0x2a80, 0xea41, 0xee01, 0x2ec0, 0x2f80, 0xef41,
  0x2d00, 0xedc1, 0xec81, 0x2c40, 0xe401, 0x24c0, 0x2580, 0xe541, 0x2700, 0xe7c1, 0xe681, 0x2640,
  0x2200, 0xe2c1, 0xe381, 0x2340, 0xe101, 0x21c0, 0x2080, 0xe041, 0xa001, 0x60c0, 0x6180, 0xa141,
  0x6300, 0xa3c1, 0xa281, 0x6240, 0x6600, 0xa6c1, 0xa781, 0x6740, 0xa501, 0x65c0, 0x6480, 0xa441,
  0x6c00, 0xacc1, 0xad81, 0x6d40, 0xaf01, 0x6fc0, 0x6e80, 0xae41, 0xaa01, 0x6ac0, 0x6b80, 0xab41,
  0x6900, 0xa9c1, 0xa881, 0x6840, 0x7800, 0xb8c1, 0xb981, 0x7940, 0xbb01, 0x7bc0, 0x7a80, 0xba41,
  0xbe01, 0x7ec0, 0x7f80, 0xbf41, 0x7d00, 0xbdc1, 0xbc81, 0x7c40, 0xb401, 0x74c0, 0x7580, 0xb541,
  0x7700, 0xb7c1, 0xb681, 0x7640, 0x7200, 0xb2c1, 0xb381, 0x7340, 0xb101, 0x71c0, 0x7080, 0xb041,
  0x5000, 0x90c1, 0x9181, 0x5140, 0x9301, 0x53c0, 0x5280, 0x9241, 0x9601, 0x56c0, 0x5780, 0x9741,
  0x5500, 0x95c1, 0x9481, 0x5440, 0x9c01, 0x5cc0, 0x5d80, 0x9d41, 0x5f00, 0x9fc1, 0x9e81, 0x5e40,
  0x5a00, 0x9ac1, 0x9b81, 0x5b40, 0x9901, 0x59c0, 0x5880, 0x9841, 0x8801, 0x48c0, 0x4980, 0x8941,
  0x4b00, 0x8bc1, 0x8a81, 0x4a40, 0x4e00, 0x8ec1, 0x8f81, 0x4f40, 0x8d01, 0x4dc0, 0x4c80, 0x8c41,
  0x4400, 0x84c1, 0x8581, 0x4540, 0x8701, 0x47c0, 0x4680, 0x8641, 0x8201, 0x42c0, 0x4380, 0x8341,
  0x4100, 0x81c1, 0x8081, 0x4040,
]);

function crc16(data, end) {
  let res = 0x0ffff;
  for (let i = 0; i < end; i++) {
    res = ((res >> 8) & 0xff) ^ CRCTAB16[(res ^ data[i]) & 0xff];
  }
  return ~res & 0x0ffff;
}

function buildSimplePacket(cmd) {
  const packet = new Uint8Array(5);
  packet[0] = cmd;
  packet[1] = CSP2.STX;
  packet[2] = 0;
  const crc = crc16(packet, 3);
  packet[3] = crc >> 8;
  packet[4] = crc & 0xff;
  return packet;
}

function buildSetTimePacket() {
  const now = new Date();
  const packet = new Uint8Array(11);
  let i = 0;
  packet[i++] = CSP2.SET_TIME_CMD;
  packet[i++] = CSP2.STX;
  packet[i++] = 6;
  packet[i++] = now.getSeconds();
  packet[i++] = now.getMinutes();
  packet[i++] = now.getHours();
  packet[i++] = now.getDate();
  packet[i++] = now.getMonth() + 1;
  packet[i++] = now.getFullYear() - 2000;
  packet[i++] = 0;
  const crc = crc16(packet, i);
  const full = new Uint8Array(i + 2);
  full.set(packet.subarray(0, i));
  full[i] = crc >> 8;
  full[i + 1] = crc & 0xff;
  return full;
}

function readResponse(reader, timeoutMs) {
  return new Promise((resolve, reject) => {
    const rxPacket = [];
    const timer = setTimeout(() => reject(new Error('Time-out: geen reactie van scanner.')), timeoutMs);

    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          rxPacket.push(...value);
          if (rxPacket.length >= 3 && rxPacket[rxPacket.length - 3] === 0) {
            const crc = crc16(rxPacket, rxPacket.length - 2);
            if (
              (crc >> 8) === rxPacket[rxPacket.length - 2] &&
              (crc & 0xff) === rxPacket[rxPacket.length - 1]
            ) {
              clearTimeout(timer);
              resolve(rxPacket);
              return;
            }
          }
        }
        clearTimeout(timer);
        reject(new Error('Verbinding met scanner gesloten voor volledig antwoord.'));
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    })();
  });
}

// Firefox-only quirk: a Uint8Array constructed inside a content script's own sandboxed
// realm is not always recognized as a valid ArrayBufferView by a native API belonging to
// the page's realm (Web Serial's writer here) — it throws "Value could not be converted
// to any of: ArrayBufferView, ArrayBuffer." `cloneInto` (a Firefox content-script-only
// global) structured-clones the packet into the page's own realm first, producing a
// genuine page-realm Uint8Array the writer accepts.
function toPageRealm(typedArray) {
  return typeof cloneInto === 'function' ? cloneInto(typedArray, window) : typedArray;
}

async function sendAndReceive(port, packet, timeoutMs = 3000) {
  const writer = port.writable.getWriter();
  try {
    await writer.write(toPageRealm(packet));
  } finally {
    writer.releaseLock();
  }
  const reader = port.readable.getReader();
  try {
    return await readResponse(reader, timeoutMs);
  } finally {
    reader.releaseLock();
  }
}

function parseBarcodePacket(rxPacket) {
  const results = [];
  let j = 1 + 1 + 8;
  while (j < rxPacket.length) {
    const length = rxPacket[j++];
    if (length === 0) break;
    j++; // symbology byte, not needed for ordering into a webshop cart
    let code = '';
    for (let k = 0; k < length - 5; k++) {
      code += String.fromCharCode(rxPacket[j++]);
    }
    j += 4; // timestamp bytes, not needed here
    results.push(code);
  }
  return results;
}

/**
 * Reads all stored barcodes from an OPN-2001 on the given (not yet opened) port.
 * @param {SerialPort} port
 * @param {(msg: string) => void} onLog
 * @returns {Promise<string[]>}
 */
async function readOpn2001(port, onLog) {
  await port.open({ baudRate: 9600, bufferSize: 4096 });

  try {
    let interrogateResponse;
    for (let attempt = 0; attempt < 2; attempt++) {
      interrogateResponse = await sendAndReceive(port, buildSimplePacket(CSP2.INTERROGATE_CMD));
      if (interrogateResponse[0] !== CSP2.ACK) {
        throw new Error('Ongeldig antwoord op INTERROGATE.');
      }
      if (interrogateResponse[3] !== CSP2.TEMPORARY_ERROR) break;
      onLog('OPN-2001 wordt wakker... 5 seconden wachten.');
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (interrogateResponse[3] === CSP2.TEMPORARY_ERROR) {
      throw new Error('Scanner reageerde nog steeds niet na 5 seconden. Opnieuw proberen.');
    }

    onLog('Verbonden. Tijd synchroniseren...');
    await sendAndReceive(port, buildSimplePacket(CSP2.GET_TIME_CMD));
    await sendAndReceive(port, buildSetTimePacket());

    onLog('Barcodes uitlezen...');
    const barcodeResponse = await sendAndReceive(
      port,
      buildSimplePacket(CSP2.UPLOAD_BAR_CODE_DATA_CMD),
      5000
    );
    const codes = parseBarcodePacket(barcodeResponse);

    let cleared = false;
    if (codes.length > 0 && !DEBUG_SKIP_SCANNER_CLEAR) {
      onLog('Scannergeheugen wissen...');
      try {
        await sendAndReceive(port, buildSimplePacket(CSP2.CLEAR_BAR_CODES_CMD));
        cleared = true;
      } catch (err) {
        cleared = false;
      }
    }

    await sendAndReceive(port, buildSimplePacket(CSP2.POWER_DOWN_CMD)).catch(() => {
      // Device may close the port immediately on power-down; a missing ACK here is not fatal.
    });

    onLog(
      codes.length === 0
        ? '0 barcode(s) gelezen.'
        : DEBUG_SKIP_SCANNER_CLEAR
          ? `${codes.length} barcode(s) gelezen. Scannergeheugen NIET gewist (DEBUG_SKIP_SCANNER_CLEAR staat aan).`
          : cleared
            ? `${codes.length} barcode(s) gelezen. Scannergeheugen gewist.`
            : `${codes.length} barcode(s) gelezen. Wissen van scannergeheugen is mislukt — oude barcodes blijven op de scanner staan.`
    );
    return codes;
  } finally {
    await port.close().catch(() => {});
  }
}

// A manual click and an automatic read must never open the port at the same time.
let scannerReadInProgress = false;

/**
 * Reads the scanner on `port` and adds the codes to the queue, reporting in the panel.
 * @param {SerialPort} port
 */
async function readScannerIntoQueue(port) {
  if (scannerReadInProgress) return;
  scannerReadInProgress = true;
  els.btnConnectScanner.disabled = true;
  els.scannerLog.textContent = 'Verbinden...';
  try {
    const codes = await readOpn2001(port, (msg) => {
      els.scannerLog.textContent = msg;
    });
    for (const code of codes) {
      await addToQueue(code, 1);
    }
  } catch (err) {
    els.scannerLog.textContent = `Fout: ${err.message}`;
  } finally {
    els.btnConnectScanner.disabled = false;
    scannerReadInProgress = false;
  }
}

async function onConnectScanner() {
  if (!navigator.serial) {
    els.scannerLog.textContent = 'Fout: Web Serial API niet beschikbaar in deze context.';
    return;
  }
  let port;
  try {
    // The port picker needs a user click; this handler is that click.
    port = await navigator.serial.requestPort({ filters: [{ usbVendorId: OPTICON_USB_VENDOR_ID }] });
  } catch (err) {
    els.scannerLog.textContent = `Fout: ${err.message}`;
    return;
  }
  await readScannerIntoQueue(port);
}

/**
 * Reads the scanner without a click, when the toolbar click opened the overlay and
 * nothing is pending. Browsers only show the port picker (requestPort) on a user click,
 * but a port the user authorized once is available afterwards via getPorts() without
 * one — so only the very first read needs the "Verbinden & uitlezen" click.
 */
async function autoReadScanner() {
  if (queue.some((item) => item.status === 'pending')) return;
  if (!navigator.serial) return;
  const ports = await navigator.serial.getPorts();
  const port = ports.find((p) => p.getInfo().usbVendorId === OPTICON_USB_VENDOR_ID);
  if (!port) {
    els.scannerLog.textContent = 'Klik eenmalig op "Verbinden & uitlezen" om de scanner te koppelen; daarna leest hij automatisch uit.';
    return;
  }
  await readScannerIntoQueue(port);
}

/** Consumes background.js's one-shot auto-read request (AUTO_READ_KEY), if set. */
async function consumeAutoReadRequest() {
  const stored = await browserAPI.storage.local.get(AUTO_READ_KEY);
  if (!stored[AUTO_READ_KEY]) return;
  await browserAPI.storage.local.set({ [AUTO_READ_KEY]: false });
  // The toolbar click just opened the overlay: a hand-scanner user can scan right away.
  els.handScanInput.focus();
  await autoReadScanner();
}

(async () => {
  await loadState();
  buildPanel();

  // Re-read PANEL_OPEN_KEY here, after buildPanel() (i.e. after els.panel exists),
  // instead of trusting the value loadState() read earlier: background.js's toggle
  // write happens right as this tab becomes ready, i.e. right around when this script
  // is doing this same startup sequence. A write landing between loadState()'s read and
  // this point is invisible to the onChanged listener below (it bails while els.panel
  // is still undefined) and would otherwise be silently lost, leaving the panel closed
  // even though the toggle was requested. This closes that gap.
  const stored = await browserAPI.storage.local.get(PANEL_OPEN_KEY);
  panelOpen = !!stored[PANEL_OPEN_KEY];
  els.panel.style.display = panelOpen ? 'flex' : 'none';

  // Queue state survives page loads here, so seeding only when nothing is pending keeps
  // every reload from adding the fake codes on top of the previous ones. Not via
  // addToQueue(): that also forces the panel open on every henryschein.nl page load.
  if (!queue.some((item) => item.status === 'pending')) {
    DEBUG_FAKE_SCAN_CODES.forEach((code) => {
      const item = { id: genId(), code, qty: 1, status: 'pending', priceInfo: null, priceState: 'idle' };
      queue.push(item);
      lookupPrice(item);
    });
    await saveQueue();
  }
  renderQueue();

  // The toolbar click that opened the overlay may have landed before this script ran.
  await consumeAutoReadRequest();
})();
