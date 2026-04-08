import { chromium, Browser, BrowserContext, Page } from 'playwright';

console.log('[BrowserAgent] module loaded');

// ── Singleton state ────────────────────────────────────────────────────────────

let browser:  Browser        | null = null;
let context:  BrowserContext | null = null;
let page:     Page           | null = null;
let headlessMode = true;

// ── Internal helpers ───────────────────────────────────────────────────────────

async function getPage(headless = true): Promise<Page> {
  // Relaunch if headless mode changes
  if (browser && browser.isConnected() && headless !== headlessMode) {
    await browser.close();
    browser  = null;
    context  = null;
    page     = null;
  }

  if (!browser || !browser.isConnected()) {
    browser     = await chromium.launch({ headless });
    headlessMode = headless;
    context      = null;
    page         = null;
  }

  if (!context) {
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport:  { width: 1280, height: 800 },
    });
  }

  if (!page || page.isClosed()) {
    page = await context.newPage();
  }

  return page;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function browserOpen(url: string, headless = true): Promise<string> {
  const p = await getPage(headless);
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return `Opened: ${p.url()} — "${await p.title()}"`;
}

export async function browserClick(selector: string): Promise<string> {
  const p = await getPage();
  // Try CSS selector, fall back to visible text match
  try {
    await p.click(selector, { timeout: 8_000 });
  } catch {
    await p.getByText(selector, { exact: false }).first().click({ timeout: 8_000 });
  }
  return `Clicked: ${selector}`;
}

export async function browserType(selector: string, text: string): Promise<string> {
  const p = await getPage();
  try {
    await p.fill(selector, text, { timeout: 8_000 });
  } catch {
    // Fallback: click the element then type
    await p.click(selector, { timeout: 5_000 });
    await p.keyboard.type(text);
  }
  return `Typed into ${selector}`;
}

export async function browserExtract(selector: string): Promise<string> {
  const p = await getPage();

  if (!selector || selector === 'body' || selector === '*') {
    const text = await p.evaluate(() => document.body.innerText ?? '');
    return text.slice(0, 4000);
  }

  try {
    const el = await p.$(selector);
    if (el) {
      const text = await el.innerText();
      return text.slice(0, 4000);
    }
  } catch { /* fall through */ }

  // Selector not found — return page text
  const text = await p.evaluate(() => document.body.innerText ?? '');
  return text.slice(0, 4000);
}

export async function browserScreenshot(): Promise<string> {
  const p    = await getPage();
  const buf  = await p.screenshot({ type: 'png', fullPage: false });
  const b64  = buf.toString('base64');
  const title = await p.title();
  // Return base64 prefixed so callers can detect it
  return `screenshot:${title}:${b64}`;
}

export async function browserSearch(
  query:  string,
  engine: 'google' | 'youtube' | 'reddit' = 'google',
): Promise<string> {
  const urls: Record<string, string> = {
    google:  `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    youtube: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    reddit:  `https://www.reddit.com/search/?q=${encodeURIComponent(query)}&sort=relevance`,
  };

  const p = await getPage();
  await p.goto(urls[engine], { waitUntil: 'domcontentloaded', timeout: 30_000 });

  // Extract readable text result summary
  const text = await p.evaluate(() => {
    // Remove nav/header noise
    const noise = document.querySelectorAll('nav, header, footer, script, style, [aria-hidden="true"]');
    noise.forEach(n => n.remove());
    return document.body.innerText ?? '';
  });

  return `${engine} search: "${query}"\n\n${text.slice(0, 3000)}`;
}

export async function browserScroll(direction: 'up' | 'down', amount: number): Promise<string> {
  const p   = await getPage();
  const dy  = direction === 'down' ? amount : -amount;
  await p.evaluate((d: number) => window.scrollBy(0, d), dy);
  return `Scrolled ${direction} ${amount}px`;
}

export async function browserWait(ms: number): Promise<string> {
  const capped = Math.min(ms, 10_000);
  await new Promise(r => setTimeout(r, capped));
  return `Waited ${capped}ms`;
}

export async function browserClose(): Promise<string> {
  if (browser) {
    await browser.close();
    browser  = null;
    context  = null;
    page     = null;
  }
  return 'Browser closed';
}
