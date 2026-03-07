import http from 'node:http';
import { createApp } from './app.js';
import type { AppDeps } from './app.js';
import { attachWebSocketServer } from './ws/ws-server.js';

export async function startServer(deps: AppDeps, port: number): Promise<http.Server> {
  const { app, validateProxyUpgrade } = await createApp(deps);
  const server = http.createServer(app);

  attachWebSocketServer(server, deps, validateProxyUpgrade);

  const registerShutdown = (signal: NodeJS.Signals): void => {
    process.on(signal, () => {
      process.stderr.write(`[server] Received ${signal}, shutting down gracefully\n`);

      // Forced-exit fallback after 10 seconds
      const forceExit = setTimeout(() => {
        process.stderr.write('[server] Forced exit after 10s timeout\n');
        process.exit(1);
      }, 10_000);
      forceExit.unref();

      server.close(() => {
        void deps.sessionEngine.stopAllSessions().finally(() => {
          process.exit(0);
        });
      });
    });
  };

  registerShutdown('SIGTERM');
  registerShutdown('SIGINT');

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}
