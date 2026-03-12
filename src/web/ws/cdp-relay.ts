import type WebSocket from 'ws';
import type { CDPSession } from 'playwright';
import type { BrowserManager, HandoffStatus } from '../../validation/browser-manager.js';

const MAX_FPS = 10;
const MIN_FRAME_INTERVAL_MS = 1000 / MAX_FPS;

/**
 * Bridge a browser viewer WebSocket client to a Playwright CDP session.
 * Forwards screencast frames to the client and (in interactive mode)
 * relays mouse/keyboard input from the client to the browser.
 */
export function handleCdpRelay(
  ws: WebSocket,
  sessionId: string,
  browserManager: BrowserManager,
): void {
  const cdp = browserManager.getCdpSession(sessionId);
  if (!cdp) {
    ws.send(JSON.stringify({ type: 'error', message: 'No active handoff for this session' }));
    ws.close(4004);
    return;
  }

  const handoffState = browserManager.getHandoffState(sessionId);
  let mode: HandoffStatus = handoffState?.status ?? 'spectating';

  // Send initial status
  ws.send(JSON.stringify({ type: 'status', mode }));

  // --- Screencast frame forwarding ---
  let lastFrameTime = 0;

  const onFrame = (params: Record<string, unknown>): void => {
    if (ws.readyState !== 1 /* WebSocket.OPEN */) return;

    // Throttle frames
    const now = Date.now();
    if (now - lastFrameTime < MIN_FRAME_INTERVAL_MS) {
      // Still ack the frame so CDP keeps sending
      cdp.send('Page.screencastFrameAck', {
        sessionId: params['sessionId'] as number,
      }).catch(() => {});
      return;
    }
    lastFrameTime = now;

    const base64Data = params['data'] as string;
    const metadata = params['metadata'] as Record<string, number>;
    const width = metadata['deviceWidth'] ?? 1280;
    const height = metadata['deviceHeight'] ?? 720;

    // Send as binary: 8-byte header (width u32 BE + height u32 BE) + JPEG bytes
    const jpegBuf = Buffer.from(base64Data, 'base64');
    const header = Buffer.alloc(8);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    const frame = Buffer.concat([header, jpegBuf]);

    ws.send(frame, { binary: true });

    // Ack the frame
    cdp.send('Page.screencastFrameAck', {
      sessionId: params['sessionId'] as number,
    }).catch(() => {});
  };

  cdp.on('Page.screencastFrame', onFrame);

  // --- Input forwarding from client ---
  ws.on('message', (raw: Buffer | string) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      return;
    }

    // Refresh mode from BrowserManager (it may have changed)
    const currentState = browserManager.getHandoffState(sessionId);
    if (currentState) {
      const newMode = currentState.status;
      if (newMode !== mode) {
        mode = newMode;
        ws.send(JSON.stringify({ type: 'status', mode }));
      }
    }

    if (msg['type'] === 'done') {
      // User clicked Done — complete the handoff
      browserManager.completeHandoff(sessionId).catch((err) => {
        console.error(`[cdp-relay] error completing handoff for ${sessionId}:`, err);
      });
      return;
    }

    // Only forward input in interactive mode
    if (mode !== 'active') return;

    if (msg['type'] === 'mouse' && msg['params']) {
      cdp.send('Input.dispatchMouseEvent', msg['params'] as Record<string, unknown>).catch(() => {});
    } else if (msg['type'] === 'key' && msg['params']) {
      cdp.send('Input.dispatchKeyEvent', msg['params'] as Record<string, unknown>).catch(() => {});
    }
  });

  // --- Cleanup ---
  ws.on('close', () => {
    cdp.off('Page.screencastFrame', onFrame);
  });

  ws.on('error', () => {
    cdp.off('Page.screencastFrame', onFrame);
  });

  // If CDP session detaches, close the WebSocket
  cdp.on('CDPSession.Disconnected' as string, () => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'error', message: 'CDP session disconnected' }));
      ws.close(4000);
    }
  });
}
