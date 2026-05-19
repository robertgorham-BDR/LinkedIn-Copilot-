// Playwright session manager. One persistent Chromium context per user.
// First-run flow: open the context, navigate to LinkedIn login, let the user
// complete sign-in + 2FA + Sales Nav. Cookies persist in the user-data dir.

import { chromium, type BrowserContext, type Page } from 'playwright';
import { app } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import log from 'electron-log';

let ctx: BrowserContext | null = null;
let starting: Promise<BrowserContext> | null = null;

function profileDir(userId: number): string {
  const dir = join(app.getPath('userData'), 'playwright-profile', String(userId));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export async function getContext(userId: number): Promise<BrowserContext> {
  if (ctx) return ctx;
  if (starting) return starting;
  starting = (async () => {
    const dir = profileDir(userId);
    log.info('launching persistent chromium at', dir);
    const c = await chromium.launchPersistentContext(dir, {
      headless: false,
      viewport: { width: 1280, height: 900 },
      // Realistic UA + locale to keep LinkedIn happy.
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });
    // Hide navigator.webdriver. LinkedIn checks this.
    await c.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    ctx = c;
    return c;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

export async function newPage(userId: number): Promise<Page> {
  const c = await getContext(userId);
  const pages = c.pages();
  // Reuse the first page if it's LinkedIn-affiliated, else open new.
  const reusable = pages.find((p) =>
    /linkedin\.com|^about:blank$/.test(p.url())
  );
  if (reusable) {
    await reusable.bringToFront();
    return reusable;
  }
  return await c.newPage();
}

export async function closeContext(): Promise<void> {
  if (ctx) {
    try {
      await ctx.close();
    } catch (err) {
      log.warn('error closing context', err);
    }
    ctx = null;
  }
}

export async function isLinkedInLoggedIn(userId: number): Promise<boolean> {
  const c = await getContext(userId);
  try {
    const res = await c.request.get('https://www.linkedin.com/feed/', { maxRedirects: 5, timeout: 15_000 });
    const finalUrl = res.url();
    if (/\/login|\/uas\/login|\/checkpoint/.test(finalUrl)) return false;
    return res.ok() && /linkedin\.com\/feed/.test(finalUrl);
  } catch (err) {
    log.warn('isLinkedInLoggedIn check failed', err);
    return false;
  }
}

export async function startLinkedInLogin(userId: number): Promise<void> {
  const page = await newPage(userId);
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  // We don't fill credentials. The user signs in by hand. Persistent context
  // remembers the cookie. 2FA codes are entered live.
}

// Sales Nav has its own session that can expire independently of regular LinkedIn.
// The Sales Nav home page is /sales/home; logged-out redirects to a marketing page
// or the LinkedIn login flow.
export async function isSalesNavLoggedIn(userId: number): Promise<boolean> {
  const c = await getContext(userId);
  try {
    const res = await c.request.get('https://www.linkedin.com/sales/home', { maxRedirects: 5, timeout: 15_000 });
    const finalUrl = res.url();
    if (/\/login|\/uas\/login|\/sales\/start|\/sales\/marketing|\/checkpoint/.test(finalUrl)) return false;
    return res.ok() && /linkedin\.com\/sales\//.test(finalUrl);
  } catch (err) {
    log.warn('isSalesNavLoggedIn check failed', err);
    return false;
  }
}

export async function startSalesNavLogin(userId: number): Promise<void> {
  const page = await newPage(userId);
  // Sales Nav login goes through the LinkedIn login page first; on success, redirects back.
  await page.goto('https://www.linkedin.com/sales/home', { waitUntil: 'domcontentloaded' });
}
