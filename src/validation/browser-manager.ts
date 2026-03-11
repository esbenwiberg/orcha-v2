import type { Browser, BrowserContext, Page, ConsoleMessage } from 'playwright';

export interface ConsoleEntry {
  level: string;
  text: string;
  url: string;
  timestamp: number;
}

export interface BrowseResult {
  screenshot: Buffer;
  title: string;
  url: string;
  consoleErrors: ConsoleEntry[];
}

export interface ExtractResult {
  text: string;
  html: string;
  attribute?: string;
}

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  consoleLogs: ConsoleEntry[];
  /** Promise chain for serializing concurrent operations on this session */
  mutex: Promise<void>;
}

const MAX_CONSOLE_ENTRIES = 200;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024; // 5MB
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

export class BrowserManager {
  private _browser: Browser | null = null;
  private _launching: Promise<Browser> | null = null;
  private _sessions: Map<string, BrowserSession> = new Map();

  /**
   * Navigate to a page in the validation app and return a screenshot + metadata.
   * @param baseUrl The base URL to browse (e.g. http://localhost:3001 or http://orcha-val-abc-orcha-1:3000)
   */
  async browse(
    sessionId: string,
    baseUrl: string,
    opts: { url?: string; path?: string; waitFor?: string },
  ): Promise<BrowseResult> {
    const targetUrl = this._resolveUrl(opts.url, opts.path, baseUrl);
    const session = await this._getOrCreateSession(sessionId);

    return this._serialized(session, async () => {
      await this._ensurePageAlive(session);

      await session.page.goto(targetUrl, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      });

      // Optional: wait for a specific selector
      if (opts.waitFor) {
        await session.page
          .waitForSelector(opts.waitFor, { timeout: 10_000 })
          .catch(() => {
            // We'll still take the screenshot; caller sees the warning in console errors
            session.consoleLogs.push({
              level: 'warning',
              text: `wait_for selector "${opts.waitFor}" timed out after 10s`,
              url: targetUrl,
              timestamp: Date.now(),
            });
          });
      }

      const screenshot = await this._takeScreenshot(session.page, false);
      const title = await session.page.title();
      const currentUrl = session.page.url();
      const consoleErrors = session.consoleLogs.filter(
        (e) => e.level === 'error' || e.level === 'warning',
      );

      return { screenshot, title, url: currentUrl, consoleErrors };
    });
  }

  /**
   * Take a screenshot of the current page or a specific element.
   */
  async screenshot(
    sessionId: string,
    opts: { fullPage?: boolean; selector?: string },
  ): Promise<Buffer> {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new Error(
        'No browser session. Call validate_browse first to navigate to a page.',
      );
    }

    return this._serialized(session, async () => {
      if (opts.selector) {
        const el = await session.page.$(opts.selector);
        if (!el) {
          throw new Error(`Selector "${opts.selector}" not found on page`);
        }
        return (await el.screenshot({ type: 'png' })) as Buffer;
      }
      return this._takeScreenshot(session.page, opts.fullPage ?? false);
    });
  }

  /**
   * Extract text/HTML/attribute from elements matching a CSS selector.
   */
  async extract(
    sessionId: string,
    selector: string,
    attribute?: string,
  ): Promise<ExtractResult[]> {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new Error(
        'No browser session. Call validate_browse first to navigate to a page.',
      );
    }

    return this._serialized(session, async () => {
      const elements = await session.page.$$(selector);
      if (elements.length === 0) {
        return [];
      }

      const results: ExtractResult[] = [];
      for (const el of elements) {
        const text = (await el.textContent()) ?? '';
        const html = await el.innerHTML();
        const result: ExtractResult = { text: text.trim(), html };
        if (attribute) {
          const attr = await el.getAttribute(attribute);
          if (attr !== null) {
            result.attribute = attr;
          }
        }
        results.push(result);
      }
      return results;
    });
  }

  /**
   * Return buffered console logs for a session.
   */
  getConsoleLogs(sessionId: string, limit?: number): ConsoleEntry[] {
    const session = this._sessions.get(sessionId);
    if (!session) return [];

    const entries = session.consoleLogs;
    if (limit !== undefined && limit > 0) {
      return entries.slice(-limit);
    }
    return [...entries];
  }

  /**
   * Close a single session's browser context.
   * Closes the browser entirely if no sessions remain.
   */
  async close(sessionId: string): Promise<void> {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    this._sessions.delete(sessionId);
    await session.context.close().catch(() => {});

    if (this._sessions.size === 0 && this._browser) {
      await this._browser.close().catch(() => {});
      this._browser = null;
      this._launching = null;
    }
  }

  /**
   * Close all sessions and the browser. Used on shutdown.
   */
  async closeAll(): Promise<void> {
    for (const [id] of this._sessions) {
      const session = this._sessions.get(id);
      if (session) {
        await session.context.close().catch(() => {});
      }
    }
    this._sessions.clear();

    if (this._browser) {
      await this._browser.close().catch(() => {});
      this._browser = null;
      this._launching = null;
    }
  }

  // --- Private helpers ---

  private async _ensureBrowser(): Promise<Browser> {
    if (this._browser && this._browser.isConnected()) {
      return this._browser;
    }

    // Dedup concurrent launch requests
    if (this._launching) {
      return this._launching;
    }

    this._launching = (async () => {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

      browser.on('disconnected', () => {
        this._browser = null;
        this._launching = null;
      });

      this._browser = browser;
      this._launching = null;
      return browser;
    })();

    return this._launching;
  }

  private async _getOrCreateSession(
    sessionId: string,
  ): Promise<BrowserSession> {
    const existing = this._sessions.get(sessionId);
    if (existing && !existing.page.isClosed()) {
      return existing;
    }

    // Clean up stale session if page is closed
    if (existing) {
      await existing.context.close().catch(() => {});
      this._sessions.delete(sessionId);
    }

    const browser = await this._ensureBrowser();
    const context = await browser.newContext({
      viewport: DEFAULT_VIEWPORT,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    const session: BrowserSession = {
      context,
      page,
      consoleLogs: [],
      mutex: Promise.resolve(),
    };

    // Capture console messages
    page.on('console', (msg: ConsoleMessage) => {
      const entry: ConsoleEntry = {
        level: msg.type(),
        text: msg.text(),
        url: page.url(),
        timestamp: Date.now(),
      };
      session.consoleLogs.push(entry);
      // Ring buffer
      if (session.consoleLogs.length > MAX_CONSOLE_ENTRIES) {
        session.consoleLogs.splice(
          0,
          session.consoleLogs.length - MAX_CONSOLE_ENTRIES,
        );
      }
    });

    // Capture uncaught page errors
    page.on('pageerror', (err) => {
      session.consoleLogs.push({
        level: 'error',
        text: `[pageerror] ${String(err)}`,
        url: page.url(),
        timestamp: Date.now(),
      });
    });

    this._sessions.set(sessionId, session);
    return session;
  }

  private async _ensurePageAlive(
    session: BrowserSession,
  ): Promise<void> {
    if (session.page.isClosed()) {
      // Recreate page in existing context
      session.page = await session.context.newPage();
      // Re-attach listeners (they don't survive page recreation)
      session.page.on('console', (msg: ConsoleMessage) => {
        session.consoleLogs.push({
          level: msg.type(),
          text: msg.text(),
          url: session.page.url(),
          timestamp: Date.now(),
        });
        if (session.consoleLogs.length > MAX_CONSOLE_ENTRIES) {
          session.consoleLogs.splice(
            0,
            session.consoleLogs.length - MAX_CONSOLE_ENTRIES,
          );
        }
      });
      session.page.on('pageerror', (err) => {
        session.consoleLogs.push({
          level: 'error',
          text: `[pageerror] ${String(err)}`,
          url: session.page.url(),
          timestamp: Date.now(),
        });
      });
    }
  }

  private _resolveUrl(
    url: string | undefined,
    path: string | undefined,
    baseUrl: string,
  ): string {
    const baseOrigin = new URL(baseUrl).origin;

    if (url) {
      const parsed = new URL(url);
      if (parsed.origin !== baseOrigin) {
        throw new Error(
          `URL must be on ${baseOrigin}. Got: ${parsed.origin}`,
        );
      }
      return url;
    }

    if (path) {
      const normalized = path.startsWith('/') ? path : `/${path}`;
      return `${baseOrigin}${normalized}`;
    }

    return baseOrigin;
  }

  private async _takeScreenshot(
    page: Page,
    fullPage: boolean,
  ): Promise<Buffer> {
    const buf = (await page.screenshot({
      type: 'png',
      fullPage,
    })) as Buffer;

    if (buf.length > MAX_SCREENSHOT_BYTES) {
      // Fall back to viewport-only if full page was too large
      if (fullPage) {
        return (await page.screenshot({ type: 'png', fullPage: false })) as Buffer;
      }
    }

    return buf;
  }

  /**
   * Serialize operations on a session to prevent concurrent page interactions.
   */
  private async _serialized<T>(
    session: BrowserSession,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = session.mutex;
    let resolve!: () => void;
    session.mutex = new Promise<void>((r) => {
      resolve = r;
    });

    await prev;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }
}
