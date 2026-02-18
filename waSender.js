const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

// Separate session dirs so batch and monitor never conflict
const BATCH_SESSION_DIR = path.join(__dirname, '.wa-session');
const MONITOR_SESSION_DIR = path.join(__dirname, '.wa-session-monitor');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildWhatsAppUrl(phone, message) {
  const text = encodeURIComponent(message);
  return `https://web.whatsapp.com/send?phone=${encodeURIComponent(phone)}&text=${text}`;
}

async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function getContext(sessionDir) {
  await ensureDir(sessionDir);
  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: process.env.HEADLESS === 'true',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      // Memory saving flags for low-RAM environments (Render free tier = 512MB)
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--js-flags=--max-old-space-size=256',
      '--single-process',
    ],
  });
  return context;
}

async function waitForReady(page) {
  await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded' });
  // Wait until logged in (search box visible = chat list loaded)
  await page.waitForSelector('div[contenteditable="true"][data-tab]', { timeout: 0 });
  await page.evaluate(() => {
    try { document.body.style.zoom = '100%'; } catch { }
  });
}

/**
 * Tries multiple strategies to find and click the WhatsApp send button.
 * Returns true if clicked, false if not found.
 */
async function trySendClick(page) {
  // Strategy 1: in-page JS — find any button containing a send-icon span
  const clicked = await page.evaluate(() => {
    // WhatsApp uses data-icon="send" on a <span> inside a <button>
    const selectors = [
      'button[aria-label="Send"]',
      'button[data-testid="send"]',
      'button[data-tab="11"]',
      '[data-testid="send"]',
    ];

    // Try direct selectors first
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        el.click();
        return true;
      }
    }

    // Fallback: find any <span> with data-icon="send" and click its parent button
    const spans = document.querySelectorAll('span[data-icon="send"]');
    for (const span of spans) {
      const btn = span.closest('button');
      if (btn && btn.offsetParent !== null) {
        btn.click();
        return true;
      }
    }

    // Last resort: find any visible button whose aria-label contains "send" (case-insensitive)
    const allBtns = document.querySelectorAll('button');
    for (const btn of allBtns) {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('send') && btn.offsetParent !== null) {
        btn.click();
        return true;
      }
    }

    return false;
  });

  if (clicked) return true;

  // Strategy 2: Playwright locators as backup (in case JS click doesn't work)
  const playwrightSelectors = [
    'button[aria-label="Send"]',
    'button[data-testid="send"]',
    'span[data-icon="send"]',
    'button span[data-icon="send"]',
  ];

  for (const sel of playwrightSelectors) {
    try {
      const loc = page.locator(sel).first();
      const visible = await loc.isVisible().catch(() => false);
      if (visible) {
        await loc.click();
        return true;
      }
    } catch (_) { }
  }

  return false;
}

async function sendSingle(page, { phone, message }) {
  const url = buildWhatsAppUrl(phone, message);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Wait for chat to load — wait for message input
  await page.waitForSelector('div[contenteditable="true"][data-tab]', { timeout: 60000 });

  // Give WhatsApp a moment to pre-fill the message and show the send button
  await sleep(2000);

  // Try clicking send up to 5 times with 1s gaps
  for (let attempt = 0; attempt < 5; attempt++) {
    const ok = await trySendClick(page);
    if (ok) return;
    await sleep(1000);
  }

  // Final fallback: press Enter
  await page.keyboard.press('Enter');
  await sleep(1200);
}

async function sendBatch({ rows, onProgress, delayMs = 4000 }) {
  const context = await getContext(BATCH_SESSION_DIR);
  const page = await context.newPage();

  try {
    await waitForReady(page);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        await sendSingle(page, row);
        onProgress?.({ index: i, row, ok: true });
      } catch (e) {
        onProgress?.({ index: i, row, ok: false, error: e.message || String(e) });
      }
      await sleep(delayMs);
    }
  } finally {
    await context.close();
  }
}

/**
 * Monitor Mode — two sub-modes:
 *
 * 1. CSV mode (rows provided):
 *    Navigates to each contact's chat URL (pre-fills message via URL),
 *    waits for the send button to appear, clicks it, then moves to next row.
 *
 * 2. Watch mode (no rows):
 *    Sits on WhatsApp Web and auto-clicks send whenever the button appears.
 *
 * Returns: { stats, stop() }
 */
let lastPage = null; // Keep track of the last active page

async function getScreenshot() {
  if (!lastPage || lastPage.isClosed()) return null;
  try {
    return await lastPage.screenshot({ type: 'png' });
  } catch (e) {
    return null;
  }
}

async function startMonitor({ rows = null, delayMs = 4000, onEvent } = {}) {
  const context = await getContext(MONITOR_SESSION_DIR);
  const page = await context.newPage();
  lastPage = page; // Store reference for screenshots

  const stats = { running: true, clicks: 0, lastClick: null, current: null };
  let stopped = false;

  await waitForReady(page);

  if (rows && rows.length > 0) {
    // ── CSV mode ──────────────────────────────────────────────────────────────
    (async () => {
      for (let i = 0; i < rows.length && !stopped; i++) {
        const row = rows[i];
        stats.current = `${i + 1}/${rows.length} — ${row.phone}`;
        try {
          const url = buildWhatsAppUrl(row.phone, row.message);
          await page.goto(url, { waitUntil: 'domcontentloaded' });

          // Wait for chat input to confirm chat opened
          await page.waitForSelector('div[contenteditable="true"][data-tab]', { timeout: 60000 });

          // Wait for message to be pre-filled and send button to appear
          await sleep(2500);

          // Try clicking send up to 5 times
          let sent = false;
          for (let attempt = 0; attempt < 5 && !sent; attempt++) {
            sent = await trySendClick(page);
            if (!sent) await sleep(1000);
          }

          if (!sent) {
            // Last resort: press Enter
            await page.keyboard.press('Enter');
          }

          stats.clicks += 1;
          stats.lastClick = Date.now();
          onEvent?.({ clicked: true, t: stats.lastClick, clicks: stats.clicks, index: i, row, ok: true });
        } catch (e) {
          onEvent?.({ clicked: false, t: Date.now(), clicks: stats.clicks, index: i, row, ok: false, error: e.message });
        }
        if (!stopped) await sleep(delayMs);
      }
      if (!stopped) {
        stats.running = false;
        stats.current = 'Done';
        onEvent?.({ done: true, clicks: stats.clicks });
        try { await context.close(); } catch (_) { }
      }
    })();
  } else {
    // ── Watch mode (manual typing) ────────────────────────────────────────────
    (async () => {
      stats.current = 'Watching for send button…';
      let lastClickedAt = 0;
      while (!stopped) {
        try {
          // Debounce: don't click again within 1.5s of last click
          if (Date.now() - lastClickedAt > 1500) {
            const clicked = await trySendClick(page);
            if (clicked) {
              stats.clicks += 1;
              stats.lastClick = Date.now();
              lastClickedAt = stats.lastClick;
              onEvent?.({ clicked: true, t: stats.lastClick, clicks: stats.clicks });
            }
          }
        } catch (_) {
          // Page navigating — ignore
        }
        await sleep(500);
      }
    })();
  }

  return {
    stats,
    stop: async () => {
      stopped = true;
      stats.running = false;
      try { await context.close(); } catch (_) { }
    },
  };
}

module.exports = { sendBatch, startMonitor, getScreenshot };
