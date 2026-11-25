import { createApp } from './app.js';
import { readConfig } from './config.js';
import { openDataRuntime, readDataConfig } from './data-runtime.js';
import { openGraph } from './provenance/graph.js';

const config = readConfig();
let runtime: Awaited<ReturnType<typeof openDataRuntime>> | undefined;
try {
  const data = readDataConfig();
  if (data) runtime = await openDataRuntime(data);
} catch {
  console.error('Data API startup failed; verify access:setup and local service availability');
  process.exit(1);
}
let graph: ReturnType<typeof openGraph>;
try {
  if (runtime) graph = openGraph();
} catch {
  console.error('Provenance is unavailable because its configuration is invalid');
}
const close = () => Promise.allSettled([runtime?.close(), graph?.close()]);
const server = createApp(runtime?.platform, graph).listen(config.port, config.host, () => {
  console.info(`API listening at http://${config.host}:${config.port}`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`API could not start: ${error.code ?? 'UNKNOWN_ERROR'}`);
  process.exitCode = 1;
  void close();
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
    void close();
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
