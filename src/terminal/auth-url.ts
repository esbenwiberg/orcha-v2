// Pure utility functions for auth URL extraction — separated from
// auth-terminal-manager.ts so they can be tested without node-pty.

// Extract URLs embedded in OSC 8 hyperlink sequences (\x1b]8;;URL\x07...text...\x1b]8;;\x07)
// before stripAnsi nukes them. Returns all URLs found in OSC 8 sequences.
// eslint-disable-next-line no-control-regex
const OSC8_RE = /\x1b\]8;;([^\x07]+)\x07/g;

// Strip ANSI escape sequences from a string so URL extraction works on raw PTY output.
// OSC 8 hyperlinks are replaced with their URL (not discarded) so extractAuthUrl can find them.
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\]8;;([^\x07]*)\x07/g, ' $1 ').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// Auth URL patterns — only match URLs that look like actual login/OAuth prompts,
// not random URLs that Claude Code might print during normal operation.
// Keep this tight: generic path-only patterns like /auth or /login caused false
// positives on docs links, API error URLs, etc.
const AUTH_URL_PATTERNS = [
  /\.anthropic\.com/i,
  /claude\.ai/i,
  /login\.microsoftonline\.com/i,
  /microsoft\.com\/devicelogin/i,
  /device(?:login|auth)/i,
  /\/oauth2?\//i,
  /\/authorize\?/i,
  /accounts\.google\.com/i,
  /github\.com\/login/i,
];

export function extractAuthUrl(snapshot: Buffer): string | undefined {
  const raw = snapshot.toString('utf8');

  // First pass: extract URLs from OSC 8 hyperlink sequences (modern terminals).
  // These get destroyed by stripAnsi, so check them before stripping.
  OSC8_RE.lastIndex = 0;
  let osc8Match: RegExpExecArray | null;
  while ((osc8Match = OSC8_RE.exec(raw)) !== null) {
    const url = osc8Match[1];
    if (url && url.startsWith('https://') && url.length > 40 && AUTH_URL_PATTERNS.some((p) => p.test(url))) {
      return url;
    }
  }

  // Second pass: scan stripped text for plain-text URLs (non-OSC 8 output).
  const text = stripAnsi(raw);
  // Split into lines so we can rejoin wrapped URLs.
  // When a URL is wider than the PTY, the terminal wraps it: the URL continues
  // on the next line with no leading whitespace. We detect this by checking
  // that the continuation line has no spaces (real sentences have spaces).
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const httpIdx = line.indexOf('https://');
    if (httpIdx === -1) continue;

    // Start URL from where https:// appears on this line.
    let url = line.slice(httpIdx).trimEnd();

    // Append continuation lines caused by terminal line-wrapping.
    for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
      const next = (lines[j] ?? '').trimEnd();
      if (next.length === 0) break;             // blank line = real end
      if (/^\s/.test(next)) break;              // leading space = new paragraph
      if (next.includes(' ')) break;            // spaces = regular sentence, not URL
      if (!/^[A-Za-z0-9%&=+_.,:/?@#!$'()*~-]/.test(next)) break;
      url += next;
    }

    // Trim any trailing punctuation that might have been captured.
    url = url.replace(/[.,;:)"']+$/, '');

    // Require a minimum meaningful URL length (filters noise) AND
    // the URL must look like an actual auth/login URL, not a random link.
    if (url.length > 40 && AUTH_URL_PATTERNS.some((p) => p.test(url))) return url;
  }

  return undefined;
}
