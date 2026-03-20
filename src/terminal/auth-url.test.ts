import { describe, expect, it } from 'vitest';
import { extractAuthUrl, stripAnsi } from './auth-url.js';

/** Wrap text in a Buffer to match the extractAuthUrl signature. */
const buf = (s: string) => Buffer.from(s, 'utf8');

describe('extractAuthUrl', () => {
  it('matches Anthropic OAuth URL', () => {
    const output = 'Please visit: https://console.anthropic.com/oauth/authorize?client_id=abc&state=xyz123456789012345678901234567890';
    expect(extractAuthUrl(buf(output))).toContain('anthropic.com');
  });

  it('matches claude.ai login URL', () => {
    const output = 'Open https://claude.ai/oauth/authorize?response_type=code&state=abcdefghijklmnopqrstuvwxyz1234567890 to continue';
    expect(extractAuthUrl(buf(output))).toContain('claude.ai');
  });

  it('matches Microsoft device login URL', () => {
    const output = 'To sign in, use https://login.microsoftonline.com/common/oauth2/deviceauth?code=ABC123XYZ';
    expect(extractAuthUrl(buf(output))).toContain('microsoftonline.com');
  });

  it('matches Google accounts OAuth URL', () => {
    const output = 'Visit https://accounts.google.com/o/oauth2/auth?client_id=123&redirect_uri=x&state=abcdef1234567890abcdef';
    expect(extractAuthUrl(buf(output))).toContain('accounts.google.com');
  });

  it('matches GitHub login URL', () => {
    const output = 'Open https://github.com/login/device?user_code=ABCD-1234567890abcdef1234567890abcdef';
    expect(extractAuthUrl(buf(output))).toContain('github.com/login');
  });

  it('does NOT match generic API error URLs with /auth path', () => {
    const output = 'Error at https://api.example.com/auth/v1/token?grant_type=client_credentials_that_is_long_enough';
    expect(extractAuthUrl(buf(output))).toBeUndefined();
  });

  it('does NOT match docs URLs with /login path', () => {
    const output = 'See https://docs.example.com/login/troubleshooting-guide-for-long-url-that-exceeds-min';
    expect(extractAuthUrl(buf(output))).toBeUndefined();
  });

  it('does NOT match file:// URLs', () => {
    const output = 'at file:///app/node_modules/@anthropic-ai/sdk/core/error.mjs:37:20';
    expect(extractAuthUrl(buf(output))).toBeUndefined();
  });

  it('does NOT match Anthropic SDK npm URLs in stack traces', () => {
    const output = `BadRequestError at APIError.generate
(file:///app/node_modules/@anthropic-ai/sdk/core/error.mjs:37:20)
at Anthropic.makeStatusError
(file:///app/node_modules/@anthropic-ai/sdk/client.mjs:155:32)`;
    expect(extractAuthUrl(buf(output))).toBeUndefined();
  });

  it('does NOT match short URLs even if domain matches', () => {
    const output = 'See https://anthropic.com/docs';
    expect(extractAuthUrl(buf(output))).toBeUndefined();
  });

  it('extracts URL from OSC 8 hyperlink sequence', () => {
    const url = 'https://console.anthropic.com/oauth/authorize?client_id=abc&state=xyz123456789012345678901234567890';
    const output = `\x1b]8;;${url}\x07Click here\x1b]8;;\x07`;
    expect(extractAuthUrl(buf(output))).toBe(url);
  });
});

describe('stripAnsi', () => {
  it('replaces OSC 8 hyperlinks with the URL', () => {
    const result = stripAnsi('\x1b]8;;https://example.com\x07link\x1b]8;;\x07');
    expect(result).toContain('https://example.com');
  });

  it('strips SGR escape codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });
});
