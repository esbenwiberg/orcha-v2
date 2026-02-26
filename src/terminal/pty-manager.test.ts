import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IDisposable } from 'node-pty';
import { PtyManager } from './pty-manager.js';

type DataListener = (data: string) => void;
type ExitListener = (e: { exitCode: number; signal?: number }) => void;

interface MockPty {
  pid: number;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  _triggerData: (data: string) => void;
  _triggerExit: (exitCode: number, signal?: number) => void;
}

function createMockPty(): MockPty {
  let dataCallback: DataListener | undefined;
  let exitCallback: ExitListener | undefined;

  const mockPty: MockPty = {
    pid: 12345,
    onData: vi.fn((listener: DataListener): IDisposable => {
      dataCallback = listener;
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((listener: ExitListener): IDisposable => {
      exitCallback = listener;
      return { dispose: vi.fn() };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    _triggerData(data: string) {
      dataCallback?.(data);
    },
    _triggerExit(exitCode: number, signal?: number) {
      exitCallback?.({ exitCode, signal });
    },
  };

  return mockPty;
}

let mockPty: MockPty;

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockPty),
}));

describe('PtyManager', () => {
  let manager: PtyManager;

  beforeEach(() => {
    mockPty = createMockPty();
    manager = new PtyManager();
  });

  it('(a) spawn returns a SessionTerminal whose pid matches the mock (12345)', () => {
    const session = manager.spawn({
      sessionId: 'session-a',
      cwd: '/tmp',
      command: 'bash',
    });
    expect(session.pid).toBe(12345);
  });

  it('(b) data emitted via the mock onData callback appears on the output Readable stream', async () => {
    const session = manager.spawn({
      sessionId: 'session-b',
      cwd: '/tmp',
      command: 'bash',
    });

    const chunks: string[] = [];
    const dataPromise = new Promise<void>((resolve) => {
      session.output.on('data', (chunk: Buffer | string) => {
        chunks.push(chunk.toString());
        resolve();
      });
    });

    mockPty._triggerData('hello from pty');
    await dataPromise;

    expect(chunks).toContain('hello from pty');
  });

  it('(c) resize clamps cols/rows to minimum of 1 when called with {cols: 0, rows: -5}', () => {
    const session = manager.spawn({
      sessionId: 'session-c',
      cwd: '/tmp',
      command: 'bash',
    });

    session.resize({ cols: 0, rows: -5 });

    expect(mockPty.resize).toHaveBeenCalledWith(1, 1);
  });

  it('(d) after mock fires onExit, calling write is a no-op (pty.write not called)', () => {
    const session = manager.spawn({
      sessionId: 'session-d',
      cwd: '/tmp',
      command: 'bash',
    });

    mockPty._triggerExit(0);
    session.write('should be ignored');

    expect(mockPty.write).not.toHaveBeenCalled();
  });

  it('(e) spawn throws PtyError with code ALREADY_EXISTS when called twice with same sessionId', () => {
    manager.spawn({
      sessionId: 'session-e',
      cwd: '/tmp',
      command: 'bash',
    });

    expect(() =>
      manager.spawn({
        sessionId: 'session-e',
        cwd: '/tmp',
        command: 'bash',
      }),
    ).toThrow(
      expect.objectContaining({ code: 'ALREADY_EXISTS' }),
    );
  });

  it('(f) killAll calls kill on every active session', async () => {
    const mockPty1 = createMockPty();
    const mockPty2 = createMockPty();

    const { spawn: nodePtySpawn } = await import('node-pty');
    const spawnMock = vi.mocked(nodePtySpawn);

    spawnMock.mockReturnValueOnce(mockPty1 as unknown as ReturnType<typeof nodePtySpawn>);
    manager.spawn({ sessionId: 'session-f1', cwd: '/tmp', command: 'bash' });

    spawnMock.mockReturnValueOnce(mockPty2 as unknown as ReturnType<typeof nodePtySpawn>);
    manager.spawn({ sessionId: 'session-f2', cwd: '/tmp', command: 'bash' });

    const killAllPromise = manager.killAll('SIGKILL');
    // Advance timer to avoid waiting 2 seconds in tests
    await vi.waitFor(() => {}, { timeout: 50 }).catch(() => {});
    await killAllPromise;

    expect(mockPty1.kill).toHaveBeenCalledWith('SIGKILL');
    expect(mockPty2.kill).toHaveBeenCalledWith('SIGKILL');
  }, 10000);
});
