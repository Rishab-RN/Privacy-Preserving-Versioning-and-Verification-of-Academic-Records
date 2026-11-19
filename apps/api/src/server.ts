import { createApp } from './app.js';
import { readConfig } from './config.js';

const config = readConfig();
const server = createApp().listen(config.port, config.host, () => {
  console.info(`API listening at http://${config.host}:${config.port}`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`API could not start: ${error.code ?? 'UNKNOWN_ERROR'}`);
  process.exitCode = 1;
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;

  const deadline = setTimeout(() => {
    server.closeAllConnections();
    process.exitCode = 1;
  }, 10_000);
  deadline.unref();

  server.close((error) => {
    clearTimeout(deadline);
    if (error) process.exitCode = 1;
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
