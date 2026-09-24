'use strict';

// Firefox exposes the Promise-based `browser` namespace; Chrome/Edge use `chrome`
// (which also returns Promises when no callback is passed, in MV3). This alias
// lets the rest of the file be written once against a single API surface.
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const HS_HOST = 'www.henryschein.nl';
const HS_LANDING_URL = 'https://www.henryschein.nl/nl-nl/medisch/Default.aspx?did=medisch&stay=1';
const HS_CART_URL = 'https://www.henryschein.nl/nl-nl/Shopping/CurrentCart.aspx';
const TAB_LOAD_TIMEOUT_MS = 15000;

// The scan UI is an overlay (content-panel.js) inside the real henryschein.nl tab, in
// both browsers. Firefox forced this: it blocks navigator.serial on every
// moz-extension:// page (confirmed by testing), so only a content script on the https
// site can use the scanner there. Chrome uses the same overlay so both browsers behave
// identically and there is one code path.
//
// Toggling is done via storage.local, not runtime.sendMessage: a freshly created tab
// races the content script's injection against this function's own message send, and a
// message sent before the content script's onMessage listener is registered is silently
// dropped (confirmed to be the cause of "opens henryschein.nl but the panel never
// appears"). Writing PANEL_OPEN_KEY has no such race — content-panel.js reads it from
// storage as part of its own startup (loadState(), before it first renders), so a write
// that lands before injection is picked up on load, and one that lands after is picked
// up by its storage.onChanged listener. Either way there's no ordering requirement.
const PANEL_OPEN_KEY = 'hsScannerPanelOpen';
// One-shot request, set when the toolbar click OPENS the overlay: the overlay consumes
// it and reads the scanner right away (when nothing is pending), saving a click. A
// separate key rather than reacting to PANEL_OPEN_KEY, because that one also stays
// true across ordinary page navigations, which must not re-read the scanner.
const AUTO_READ_KEY = 'hsScannerAutoReadRequested';

async function toggleOverlay() {
  await getReadyHenrySchemeTab();
  const stored = await browserAPI.storage.local.get(PANEL_OPEN_KEY);
  const opening = !stored[PANEL_OPEN_KEY];
  await browserAPI.storage.local.set({ [PANEL_OPEN_KEY]: opening, [AUTO_READ_KEY]: opening });
}

browserAPI.action.onClicked.addListener(() => {
  toggleOverlay();
});

/**
 * Injected into the henryschein.nl page (MAIN world, for `_n`). Adds ALL items to the
 * cart in one request — the same call the site's own jsonHelper.addItemsToCartAndGetSummary
 * makes (request and response captured from the user's DevTools): a POST to
 * JSONRequestHandler.ashx with searchType=5. This replaces one GET per item to
 * CurrentCart.aspx?addproductid=…, each of which made the server rebuild and return
 * the whole cart page — the reason adding many items was slow.
 *
 * The response reports a Status per item ("Success" on success), so each item's
 * outcome is known individually. Never throws (see runInTab).
 * @param {{code: string, qty: number}[]} items
 * @returns {Promise<{ok: boolean, value?: Object<string, string>, error?: string}>}
 *   value maps each article code to the server's Status for it ("Success" or other).
 */
async function addItemsToCartInPage(items) {
  try {
    // eslint-disable-next-line no-undef
    const token = typeof _n === 'string' ? _n : '';
    if (!token) {
      return { ok: false, error: 'Geen sessie-token (_n) op de pagina — niet ingelogd op henryschein.nl?' };
    }

    // Field values exactly as the site sends them for a plain add (captured payload).
    const itemArray = JSON.stringify({
      ItemDataToAdd: items.map((item) => ({
        ProductId: item.code,
        Qty: String(item.qty),
        Uom: 'ST',
        CheckProductIdForPromoCode: 'False',
        CheckExternalMapping: 'False',
        CheckBackOrderStatus: 'False',
        IsProductInventoryStatusLoaded: 'True',
        LineItemId: '',
      })),
    });
    const body = new URLSearchParams({
      ItemArray: itemArray,
      searchType: '5',
      did: 'medisch',
      catalogName: 'WEBMED',
      endecaCatalogName: 'WEBMED',
      culture: 'nl-nl',
    });

    const res = await fetch('/webservices/JSONRequestHandler.ashx', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'n': token,
        'isCallingFromCMS': 'False',
      },
      body: body.toString(),
    });
    if (!res.ok) {
      return { ok: false, error: `Toevoegen mislukt (HTTP ${res.status}).` };
    }

    const charset = ((res.headers.get('content-type') || '').match(/charset=([^;]+)/i) || [])[1] || 'utf-8';
    const text = new TextDecoder(charset.trim()).decode(await res.arrayBuffer());
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      return { ok: false, error: `Geen JSON-antwoord bij toevoegen (${text.length} bytes, begint met "${text.slice(0, 60)}").` };
    }
    if (!data || !Array.isArray(data.ItemsStatus)) {
      return { ok: false, error: 'Antwoord bij toevoegen bevat geen ItemsStatus.' };
    }

    const statusByCode = {};
    data.ItemsStatus.forEach((entry) => {
      statusByCode[String(entry.ItemId)] = String(entry.Status);
    });
    return { ok: true, value: statusByCode };
  } catch (err) {
    return { ok: false, error: `Toevoegen mislukt: ${err.message}` };
  }
}

/**
 * Injected into the henryschein.nl page. Looks up live price and availability for one
 * article number WITHOUT adding it to the cart, via JSONRequestHandler.ashx (confirmed
 * via a HAR capture: POSTing an ItemArray of ItemDataToPrice has no cart side effect).
 * Requires an anti-CSRF-style "n" header carrying the page's session token `_n`.
 *
 * This is the source of truth for price, not just availability: the
 * "<span class=\"amount ...\">" on the search-results page (lookupNameInPage) is only
 * a placeholder filled in by client-side JS — confirmed empty on a raw fetch.
 *
 * Never throws (see runInTab). A response without a price is reported as an error
 * including the server's own pricing diagnostics, so the reason is visible.
 * @param {string} code
 * @param {number} qty
 * @returns {Promise<{ok: boolean, value?: {price: string, availability: string|null, unavailable: boolean}, error?: string}>}
 */
async function lookupPriceInPage(code, qty) {
  try {
    // The site's own AJAX code sends this header as setRequestHeader("n", _n), where
    // `_n` is a global of the page's own scripts (confirmed from the site's
    // jsonHelper.getProductDimensions source). It is only reachable from the page's MAIN
    // world — hence this function runs there (see LOOKUP_INFO) — and it's only filled in
    // for a logged-in session; the site itself skips the request when it's empty. (The
    // OneWeb cookie it mirrors is HttpOnly, confirmed: document.cookie can't see it.)
    // eslint-disable-next-line no-undef
    const token = typeof _n === 'string' ? _n : '';
    if (!token) {
      return { ok: false, error: 'Geen sessie-token (_n) op de pagina — niet ingelogd op henryschein.nl?' };
    }

    // Body and Referer match a real, working request captured from the user's DevTools.
    const itemArray = JSON.stringify({
      ItemDataToPrice: [{ ProductId: code, Qty: String(qty), Uom: 'ST' }],
    });
    const body = new URLSearchParams({
      ItemArray: itemArray,
      searchType: '6',
      did: 'medisch',
      catalogName: 'WEBMED',
      endecaCatalogName: 'WEBMED',
      culture: 'nl-nl',
      showPriceToAnonymousUserFromCMS: 'False',
      isCallingFromCMS: 'False',
    });

    const res = await fetch('/webservices/JSONRequestHandler.ashx', {
      method: 'POST',
      credentials: 'same-origin',
      referrer: '/nl-nl/Search.aspx?searchkeyWord=' + encodeURIComponent(code),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'n': token,
        'iscallingfromcms': 'False',
      },
      body: body.toString(),
    });
    if (!res.ok) {
      return { ok: false, error: `Prijs opvragen mislukt (HTTP ${res.status}).` };
    }

    // res.text() always decodes as UTF-8, but this site serves non-UTF-8 (the "€" came
    // out as "�"); decode with the charset the response itself declares.
    const priceCharset = ((res.headers.get('content-type') || '').match(/charset=([^;]+)/i) || [])[1] || 'utf-8';
    const text = new TextDecoder(priceCharset.trim()).decode(await res.arrayBuffer());
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      return { ok: false, error: `Geen JSON-antwoord (${text.length} bytes, begint met "${text.slice(0, 60)}").` };
    }
    const item = data && data.ItemDataToPrice && data.ItemDataToPrice[0];
    if (!item) {
      return { ok: false, error: 'Antwoord bevat geen ItemDataToPrice.' };
    }
    if (!item.CatalogPriceDisplay) {
      return {
        ok: false,
        error: `Geen prijs in antwoord (DoNotShowPrice=${item.DoNotShowPrice}, PricingErrorMessage=${item.PricingErrorMessage}).`,
      };
    }

    return {
      ok: true,
      value: {
        price: item.CatalogPriceDisplay,
        availability: item.InventoryAvailabilityText || null,
        unavailable: !!item.UnavailableOrDiscontinued,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Injected into the henryschein.nl page. Scrapes the product name for one article
 * number from the search-results page (a GET, no cart side effect). Its `id` is
 * ASP.NET-generated and includes a repeater-row index that isn't stable, so it's
 * matched by the one part of the id that IS stable: it always ends in
 * "_hylProductTitle".
 *
 * NOTE: this page also has a "<span class=\"amount ...\">" that looks like a
 * server-rendered price at first glance, but it's confirmed EMPTY on a raw fetch — it's
 * only filled in by client-side JS after the page loads for real, so it can't be
 * scraped this way. Price comes from lookupPriceInPage instead.
 *
 * Never throws (see runInTab).
 * @param {string} code
 * @returns {Promise<{ok: boolean, value?: string, error?: string}>}
 */
async function lookupNameInPage(code) {
  try {
    const res = await fetch('/nl-nl/search.aspx?searchkeyWord=' + encodeURIComponent(code), {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (!res.ok) {
      return { ok: false, error: `Naam ophalen mislukt (HTTP ${res.status}).` };
    }

    // fetch()'s .text() always decodes as UTF-8, but this page is served as iso-8859-15
    // (its Content-Type header says so) — decoding with the declared charset avoids
    // mojibake in names with characters like "ï".
    const nameCharset = ((res.headers.get('content-type') || '').match(/charset=([^;]+)/i) || [])[1] || 'utf-8';
    const html = new TextDecoder(nameCharset.trim()).decode(await res.arrayBuffer());
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const titleEl = doc.querySelector('a[id$="_hylProductTitle"]');
    const name = titleEl && (titleEl.getAttribute('title') || titleEl.textContent.trim());
    if (!name) {
      return { ok: false, error: 'Geen product gevonden op de zoekpagina.' };
    }
    return { ok: true, value: name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Runs one of the *InPage functions in the given tab and unwraps its result.
 * Those functions never throw; they return {ok, value} or {ok, error} instead, because
 * scripting.executeScript reports a thrown error differently per browser: Firefox sets
 * InjectionResult.error, but Chrome has no such field and just returns result: null —
 * which made every failure in Chrome look like an empty success (the cause of price
 * silently never showing, with no error anywhere). Returning the outcome as a plain
 * value works identically in both.
 *
 * Functions run in the extension's ISOLATED world unless `world` is 'MAIN'. MAIN shares
 * the page's own JS globals, so it is used only where that is required (the `_n` token).
 * @param {number} tabId
 * @param {Function} func - a self-contained *InPage function.
 * @param {Array} args
 * @param {'ISOLATED'|'MAIN'} [world='ISOLATED']
 * @returns {Promise<*>} the function's `value`.
 * @throws {Error} with the function's own error message, or if no result came back.
 */
async function runInTab(tabId, func, args, world = 'ISOLATED') {
  const results = await browserAPI.scripting.executeScript({ target: { tabId }, func, args, world });
  const outcome = results[0] && results[0].result;
  if (!outcome) {
    throw new Error('Geen resultaat van de pagina.');
  }
  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
  return outcome.value;
}

/**
 * Returns the product name for an article number: from the permanent storage.local
 * cache if known, otherwise scraped once from the search page and cached. An article
 * number always names the same product on this site (confirmed by the user), so a
 * known code never costs a network request again.
 * @param {number} tabId - only used on a cache miss
 * @param {string} code
 * @returns {Promise<string>}
 * @throws {Error} on a cache miss where the page lookup fails.
 */
async function getProductName(tabId, code) {
  const stored = await browserAPI.storage.local.get('hsProductNames');
  const cache = stored.hsProductNames || {};
  if (cache[code]) {
    return cache[code];
  }

  const name = await runInTab(tabId, lookupNameInPage, [code]);
  await cacheProductName(code, name);
  return name;
}

// Several lookups run concurrently; each cache write is a read-modify-write of one
// storage object, so unserialized writes could overwrite each other's new names.
// Chaining them on one promise runs them strictly one after another.
let nameCacheWriteChain = Promise.resolve();

/**
 * @param {string} code
 * @param {string} name
 * @returns {Promise<void>}
 */
function cacheProductName(code, name) {
  const write = nameCacheWriteChain.then(async () => {
    const stored = await browserAPI.storage.local.get('hsProductNames');
    const cache = stored.hsProductNames || {};
    cache[code] = name;
    await browserAPI.storage.local.set({ hsProductNames: cache });
  });
  // The caller sees this write's failure; the chain itself must not stay rejected, or
  // every later write would be skipped.
  nameCacheWriteChain = write.catch(() => {});
  return write;
}

/**
 * Resolves once the given tab reaches status 'complete'. Rejects on timeout.
 * @param {number} tabId
 * @param {number} timeoutMs
 */
async function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      browserAPI.tabs.onUpdated.removeListener(listener);
      reject(new Error('Time-out: pagina laadde niet binnen ' + timeoutMs + ' ms.'));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browserAPI.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    browserAPI.tabs.onUpdated.addListener(listener);

    // Tab might already be complete right now (e.g. before we injected anything yet).
    // Promise-based tabs.get works identically on Chrome and Firefox; a tab that no
    // longer exists simply rejects here, and the onUpdated listener above still covers
    // the normal case, so a rejection at this point is not itself a failure.
    browserAPI.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === 'complete' && !settled) {
        settled = true;
        clearTimeout(timer);
        browserAPI.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, () => {});
  });
}

/**
 * Finds an existing henryschein.nl tab or creates one, then waits for it to finish loading.
 * @returns {Promise<number>} tabId
 */
async function getReadyHenrySchemeTab() {
  const tabs = await browserAPI.tabs.query({ url: `*://${HS_HOST}/*` });
  let tab = tabs.find((t) => !t.discarded);

  if (!tab) {
    tab = await browserAPI.tabs.create({ url: HS_LANDING_URL, active: true });
  } else {
    await browserAPI.tabs.update(tab.id, { active: true });
  }

  await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);
  return tab.id;
}

/**
 * The tab of the overlay that sent a message. Only the overlay (a content script on
 * henryschein.nl) sends ADD_TO_CART / LOOKUP_INFO; anything else is rejected.
 * @param {object} sender - runtime.MessageSender
 * @returns {number} tabId
 * @throws {Error} if the sender is not a henryschein.nl page.
 */
function henryScheinSenderTabId(sender) {
  if (!sender.tab || !sender.url || new URL(sender.url).host !== HS_HOST) {
    throw new Error('Bericht niet afkomstig van een henryschein.nl-pagina.');
  }
  return sender.tab.id;
}

/**
 * Persists the batch's item statuses into storage.local in ONE write, which is how the
 * overlay learns the outcome (and survives a page reload meanwhile). One write per
 * batch, not per item: the overlay reports "N toegevoegd" per storage change.
 * @param {Object<string, {status: 'sent'|'error', error: string|null}>} outcomeById
 */
async function updateQueueStatuses(outcomeById) {
  const stored = await browserAPI.storage.local.get('hsScannerQueue');
  const queue = stored.hsScannerQueue || [];
  queue.forEach((item) => {
    const outcome = outcomeById[item.id];
    if (outcome) {
      item.status = outcome.status;
      item.error = outcome.error;
    }
  });
  await browserAPI.storage.local.set({ hsScannerQueue: queue });
}

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ADD_TO_CART') return false;

  let tabId;
  try {
    tabId = henryScheinSenderTabId(sender);
  } catch (err) {
    sendResponse({ started: false, error: err.message });
    return false;
  }

  (async () => {
    const items = message.items;
    const outcomeById = {};

    // One request for the whole batch (see addItemsToCartInPage).
    let statusByCode;
    try {
      statusByCode = await runInTab(
        tabId,
        addItemsToCartInPage,
        [items.map(({ code, qty }) => ({ code, qty }))],
        'MAIN'
      );
    } catch (err) {
      // The request itself failed, so no item is known to be in the cart.
      items.forEach(({ id }) => { outcomeById[id] = { status: 'error', error: err.message }; });
      await updateQueueStatuses(outcomeById);
      return;
    }

    let failedCount = 0;
    items.forEach(({ id, code }) => {
      if (statusByCode[code] === 'Success') {
        outcomeById[id] = { status: 'sent', error: null };
      } else {
        failedCount++;
        outcomeById[id] = {
          status: 'error',
          error: `Server meldt: ${statusByCode[code] || 'geen status voor dit artikel'}.`,
        };
      }
    });
    await updateQueueStatuses(outcomeById);
    // Stay on the page so the failed items stay visible in the overlay.
    if (failedCount > 0) return;

    // The add-to-cart call updates the server-side session cart directly (see
    // addItemsToCartInPage) without the site's own JS ever running, so the page's own
    // cart-total/cart-icon widgets — rendered once at page load — don't reflect the
    // new items until something reloads them. Navigating to the cart page does that
    // automatically, instead of leaving the user to notice and refresh manually.
    await browserAPI.tabs.update(tabId, { url: HS_CART_URL });
  })();

  sendResponse({ started: true });
  return true;
});

// Name and price are independent lookups: one failing must not hide the other, so each
// settles on its own and its error (if any) is returned alongside the data, for the
// panel to log. Returns the response as a Promise (supported by Chrome and Firefox).
browserAPI.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'LOOKUP_INFO') return undefined;

  return (async () => {
    try {
      const tabId = henryScheinSenderTabId(sender);

      const [nameOutcome, priceOutcome] = await Promise.allSettled([
        getProductName(tabId, message.code),
        runInTab(tabId, lookupPriceInPage, [message.code, message.qty], 'MAIN'),
      ]);
      const pricing = priceOutcome.status === 'fulfilled' ? priceOutcome.value : null;

      return {
        ok: true,
        data: {
          name: nameOutcome.status === 'fulfilled' ? nameOutcome.value : null,
          nameError: nameOutcome.status === 'rejected' ? nameOutcome.reason.message : null,
          price: pricing ? pricing.price : null,
          availability: pricing ? pricing.availability : null,
          unavailable: pricing ? pricing.unavailable : false,
          priceError: priceOutcome.status === 'rejected' ? priceOutcome.reason.message : null,
        },
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  })();
});
