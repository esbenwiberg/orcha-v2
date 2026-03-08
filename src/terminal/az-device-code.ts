/**
 * Utility for extracting Azure CLI device code login information from PTY output.
 *
 * When `az login --use-device-code` runs, it prints a message like:
 *   "To sign in, use a web browser to open the page https://microsoft.com/devicelogin
 *    and enter the code XXXXXXXXX to authenticate."
 *
 * This module parses that output to extract the URL and code for display in the UI.
 */

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

export interface AzDeviceCode {
  url: string;
  code: string;
}

/**
 * Extract the device login URL and code from az CLI output.
 * Returns null if the device code message hasn't appeared yet.
 */
export function extractAzDeviceCode(snapshot: Buffer | string): AzDeviceCode | null {
  const text = stripAnsi(typeof snapshot === 'string' ? snapshot : snapshot.toString('utf8'));

  // Match the code from "enter the code XXXXXXXXX to authenticate"
  const codeMatch = /enter the code\s+([A-Z0-9]{5,15})\s+to authenticate/i.exec(text);
  if (!codeMatch) return null;

  const code = codeMatch[1]!;

  // Extract the URL — try specific devicelogin/deviceauth URLs first, fall back to any https URL
  const urlMatch =
    /https:\/\/[^\s"'<>]*device(?:login|auth)[^\s"'<>]*/i.exec(text) ??
    /https:\/\/microsoft\.com\/devicelogin/i.exec(text);

  const url = urlMatch?.[0]?.replace(/[.,;:)"']+$/, '') ?? 'https://microsoft.com/devicelogin';

  return { url, code };
}

/**
 * Extract account info from az login success output (JSON array with user object).
 */
export function extractAzAccount(snapshot: Buffer | string): string | null {
  const text = stripAnsi(typeof snapshot === 'string' ? snapshot : snapshot.toString('utf8'));

  // az login outputs JSON with "user": { "name": "user@example.com" }
  const nameMatch = /"name"\s*:\s*"([^"]+@[^"]+)"/i.exec(text);
  return nameMatch?.[1] ?? null;
}
