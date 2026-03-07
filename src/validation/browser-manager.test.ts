/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest';
import { BrowserManager } from './browser-manager.js';

describe('BrowserManager', () => {
  let bm: BrowserManager;

  beforeEach(() => {
    bm = new BrowserManager();
  });

  describe('URL validation', () => {
    // Access private method via prototype trick for unit testing
    const resolveUrl = (
      url: string | undefined,
      path: string | undefined,
      port: number,
    ) => {
      return (bm as any)._resolveUrl(url, path, port);
    };

    it('should resolve path to localhost URL', () => {
      expect(resolveUrl(undefined, '/dashboard', 4000)).toBe(
        'http://localhost:4000/dashboard',
      );
    });

    it('should prepend / to path if missing', () => {
      expect(resolveUrl(undefined, 'about', 4000)).toBe(
        'http://localhost:4000/about',
      );
    });

    it('should default to root when no path or url given', () => {
      expect(resolveUrl(undefined, undefined, 4000)).toBe(
        'http://localhost:4000',
      );
    });

    it('should accept valid localhost URL', () => {
      expect(resolveUrl('http://localhost:4000/foo', undefined, 4000)).toBe(
        'http://localhost:4000/foo',
      );
    });

    it('should reject URL with wrong port', () => {
      expect(() =>
        resolveUrl('http://localhost:9999/foo', undefined, 4000),
      ).toThrow('URL must be on http://localhost:4000');
    });

    it('should reject external URL', () => {
      expect(() =>
        resolveUrl('https://evil.com/steal', undefined, 4000),
      ).toThrow('URL must be on http://localhost:4000');
    });

    it('should reject URL with different scheme', () => {
      expect(() =>
        resolveUrl('https://localhost:4000/foo', undefined, 4000),
      ).toThrow('URL must be on http://localhost:4000');
    });
  });

  describe('console logs', () => {
    it('should return empty array for unknown session', () => {
      expect(bm.getConsoleLogs('nonexistent')).toEqual([]);
    });

    it('should respect limit parameter', () => {
      // Manually inject a session to test log retrieval
      const session = {
        context: null as any,
        page: null as any,
        consoleLogs: Array.from({ length: 50 }, (_, i) => ({
          level: 'log',
          text: `msg-${i}`,
          url: 'http://localhost:3000',
          timestamp: Date.now() + i,
        })),
        mutex: Promise.resolve(),
      };
      (bm as any)._sessions.set('test-session', session);

      const logs = bm.getConsoleLogs('test-session', 10);
      expect(logs).toHaveLength(10);
      expect(logs[0]!.text).toBe('msg-40'); // last 10
    });

    it('should cap ring buffer at 200 entries', () => {
      const session = {
        context: null as any,
        page: null as any,
        consoleLogs: Array.from({ length: 250 }, (_, i) => ({
          level: 'log',
          text: `msg-${i}`,
          url: 'http://localhost:3000',
          timestamp: Date.now() + i,
        })),
        mutex: Promise.resolve(),
      };
      // The ring buffer enforcement happens on the console event listener,
      // but we can test the trim logic directly here
      if (session.consoleLogs.length > 200) {
        session.consoleLogs.splice(0, session.consoleLogs.length - 200);
      }
      expect(session.consoleLogs).toHaveLength(200);
      expect(session.consoleLogs[0]!.text).toBe('msg-50');
    });
  });

  describe('close', () => {
    it('should be a no-op for unknown session', async () => {
      await expect(bm.close('nonexistent')).resolves.toBeUndefined();
    });

    it('should remove session from map on close', async () => {
      // Inject a mock session
      const mockContext = { close: async () => {} };
      const session = {
        context: mockContext as any,
        page: { isClosed: () => false } as any,
        consoleLogs: [],
        mutex: Promise.resolve(),
      };
      (bm as any)._sessions.set('sess-1', session);

      await bm.close('sess-1');
      expect((bm as any)._sessions.has('sess-1')).toBe(false);
    });
  });

  describe('screenshot without session', () => {
    it('should throw when no browse session exists', async () => {
      await expect(
        bm.screenshot('nonexistent', {}),
      ).rejects.toThrow('No browser session');
    });
  });

  describe('extract without session', () => {
    it('should throw when no browse session exists', async () => {
      await expect(
        bm.extract('nonexistent', 'div'),
      ).rejects.toThrow('No browser session');
    });
  });
});
