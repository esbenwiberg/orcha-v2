import type { Browser, BrowserContext, Page, ConsoleMessage, CDPSession } from 'playwright';

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

export interface HandoffResult {
  screenshot: Buffer;
  title: string;
  url: string;
}

export type HandoffStatus = 'active' | 'spectating';

interface HandoffState {
  status: HandoffStatus;
  cdpSession: CDPSession;
  message?: string;
  settled: boolean;
  resolveHandoff: (result: HandoffResult) => void;
  rejectHandoff: (err: Error) => void;
  waitForTimer?: NodeJS.Timeout;
  timeoutTimer?: NodeJS.Timeout;
}

interface SessionOptions {
  proxy?: string;
}

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  consoleLogs: ConsoleEntry[];
  /** Promise chain for serializing concurrent operations on this session */
  mutex: Promise<void>;
  handoff?: HandoffState;
  proxyServer?: string;
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
    this._assertNoActiveHandoff(sessionId);

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
    this._assertNoActiveHandoff(sessionId);

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
    this._assertNoActiveHandoff(sessionId);

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

  // --- Handoff ---

  /**
   * Navigate to a URL and hand the browser to the human user for interactive
   * tasks (login, MFA, etc.). Returns a promise that blocks until the user
   * signals done or a wait_for selector appears.
   */
  async startHandoff(
    sessionId: string,
    url: string,
    opts: {
      message?: string;
      waitFor?: string;
      timeout?: number;
      proxy?: string;
    },
  ): Promise<HandoffResult> {
    const session = await this._getOrCreateSession(
      sessionId,
      opts.proxy ? { proxy: opts.proxy } : undefined,
    );

    if (session.handoff?.status === 'active') {
      throw new Error('A handoff is already active for this session.');
    }

    // Clean up stale spectating handoff if present
    if (session.handoff) {
      await this._cleanupHandoff(session);
      session.handoff = undefined;
    }

    // Navigate without origin restriction — handoff needs to reach external URLs
    // (e.g. login.microsoftonline.com, org.crm4.dynamics.com)
    await this._serialized(session, async () => {
      await this._ensurePageAlive(session);
      await session.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
    });

    // Create CDP session and start screencast
    const cdpSession = await session.page.context().newCDPSession(session.page);
    await cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: DEFAULT_VIEWPORT.width,
      maxHeight: DEFAULT_VIEWPORT.height,
    });

    return new Promise<HandoffResult>((resolve, reject) => {
      const handoff: HandoffState = {
        status: 'active',
        cdpSession,
        message: opts.message,
        settled: false,
        resolveHandoff: resolve,
        rejectHandoff: reject,
      };

      // Timeout
      const timeoutSec = opts.timeout ?? 300;
      handoff.timeoutTimer = setTimeout(() => {
        if (handoff.settled) return;
        handoff.settled = true;
        void this._cleanupHandoff(session);
        session.handoff = undefined;
        reject(new Error(`Handoff timed out after ${timeoutSec}s — user did not complete interaction`));
      }, timeoutSec * 1000);

      // Optional wait_for selector polling
      if (opts.waitFor) {
        const selector = opts.waitFor;
        const poll = (): void => {
          if (handoff.settled) return;
          session.page.$(selector)
            .then((el) => {
              if (el && !handoff.settled) {
                void this.completeHandoff(sessionId);
              } else if (!handoff.settled) {
                handoff.waitForTimer = setTimeout(poll, 2000);
              }
            })
            .catch(() => {
              if (!handoff.settled) {
                handoff.waitForTimer = setTimeout(poll, 2000);
              }
            });
        };
        handoff.waitForTimer = setTimeout(poll, 2000);
      }

      session.handoff = handoff;
    });
  }

  /**
   * Complete an active handoff — stop interactive mode, take final screenshot,
   * switch to spectating. Idempotent (safe to call multiple times).
   */
  async completeHandoff(sessionId: string): Promise<HandoffResult | undefined> {
    const session = this._sessions.get(sessionId);
    if (!session?.handoff || session.handoff.settled) return undefined;

    const handoff = session.handoff;
    handoff.settled = true;

    // Clear timers
    if (handoff.timeoutTimer) clearTimeout(handoff.timeoutTimer);
    if (handoff.waitForTimer) clearTimeout(handoff.waitForTimer);

    // Take final screenshot
    const result = await this._serialized(session, async () => {
      const screenshot = await this._takeScreenshot(session.page, false);
      const title = await session.page.title();
      const url = session.page.url();
      return { screenshot, title, url };
    });

    // Switch to spectating — screencast keeps running for viewers
    handoff.status = 'spectating';

    // Resolve the blocking promise so the agent resumes
    handoff.resolveHandoff(result);

    return result;
  }

  /**
   * Stop spectating and fully clean up the handoff CDP session.
   */
  async endSpectating(sessionId: string): Promise<void> {
    const session = this._sessions.get(sessionId);
    if (!session?.handoff) return;

    await this._cleanupHandoff(session);
    session.handoff = undefined;
  }

  /**
   * Get the CDP session for the relay to subscribe to screencast frames.
   * Returns undefined if no handoff is active.
   */
  getCdpSession(sessionId: string): CDPSession | undefined {
    const session = this._sessions.get(sessionId);
    return session?.handoff?.cdpSession;
  }

  /**
   * Get current handoff state for a session.
   */
  getHandoffState(sessionId: string): { status: HandoffStatus; message?: string } | undefined {
    const session = this._sessions.get(sessionId);
    if (!session?.handoff) return undefined;
    return {
      status: session.handoff.status,
      ...(session.handoff.message !== undefined ? { message: session.handoff.message } : {}),
    };
  }

  /**
   * After a handoff, the browser may be on an external origin (e.g. Dataverse).
   * Returns that origin so ValidationManager can use it as baseUrl for
   * subsequent validate_browse calls.
   */
  getHandoffOrigin(sessionId: string): string | undefined {
    const session = this._sessions.get(sessionId);
    if (!session?.handoff) return undefined;
    try {
      return new URL(session.page.url()).origin;
    } catch {
      return undefined;
    }
  }

  /**
   * Close a single session's browser context.
   * Closes the browser entirely if no sessions remain.
   */
  async close(sessionId: string): Promise<void> {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    // Clean up handoff if present
    if (session.handoff) {
      if (!session.handoff.settled) {
        session.handoff.settled = true;
        session.handoff.rejectHandoff(
          new Error('Validation environment stopped during handoff'),
        );
      }
      await this._cleanupHandoff(session);
    }

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
        if (session.handoff) {
          if (!session.handoff.settled) {
            session.handoff.settled = true;
            session.handoff.rejectHandoff(new Error('Browser manager shutting down'));
          }
          await this._cleanupHandoff(session);
        }
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

  private _assertNoActiveHandoff(sessionId: string): void {
    const session = this._sessions.get(sessionId);
    if (session?.handoff?.status === 'active') {
      throw new Error(
        'Browser is in handoff mode — waiting for user interaction. ' +
        'The handoff must complete before the agent can use the browser.',
      );
    }
  }

  private async _cleanupHandoff(session: BrowserSession): Promise<void> {
    if (!session.handoff) return;
    if (session.handoff.timeoutTimer) clearTimeout(session.handoff.timeoutTimer);
    if (session.handoff.waitForTimer) clearTimeout(session.handoff.waitForTimer);
    await session.handoff.cdpSession.send('Page.stopScreencast').catch(() => {});
    await session.handoff.cdpSession.detach().catch(() => {});
  }

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
    opts?: SessionOptions,
  ): Promise<BrowserSession> {
    const existing = this._sessions.get(sessionId);
    if (existing && !existing.page.isClosed()) {
      // If proxy config changed, recreate the session
      if (opts?.proxy && existing.proxyServer !== opts.proxy) {
        // Clean up handoff before destroying context
        if (existing.handoff) {
          if (!existing.handoff.settled) {
            existing.handoff.settled = true;
            existing.handoff.rejectHandoff(new Error('Session recreated with new proxy config'));
          }
          await this._cleanupHandoff(existing);
        }
        await existing.context.close().catch(() => {});
        this._sessions.delete(sessionId);
      } else {
        return existing;
      }
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
      ...(opts?.proxy ? { proxy: { server: opts.proxy } } : {}),
    });
    const page = await context.newPage();

    const session: BrowserSession = {
      context,
      page,
      consoleLogs: [],
      mutex: Promise.resolve(),
      ...(opts?.proxy ? { proxyServer: opts.proxy } : {}),
    };

    // Capture console messages
    this._attachPageListeners(session, page);

    this._sessions.set(sessionId, session);
    return session;
  }

  private _attachPageListeners(session: BrowserSession, page: Page): void {
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
  }

  private async _ensurePageAlive(
    session: BrowserSession,
  ): Promise<void> {
    if (session.page.isClosed()) {
      // Recreate page in existing context
      session.page = await session.context.newPage();
      // Re-attach listeners (they don't survive page recreation)
      this._attachPageListeners(session, session.page);
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
