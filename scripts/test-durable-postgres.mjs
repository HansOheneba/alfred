import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, access } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function startLocalCluster({ Client, binaryDirectory } = {}) {
  if (!Client) throw new Error('Provide the repository pg Client constructor.');
  if (!binaryDirectory || !isAbsolute(binaryDirectory)) throw new Error('An explicit absolute local --bin-dir is required; URLs and database credentials are unsupported.');
  const bins = resolve(binaryDirectory);
  const root = await mkdtemp('/tmp/alfred-durable-pg-');
  if (!root.startsWith('/tmp/alfred-durable-pg-')) throw new Error('Only dedicated /tmp/alfred-durable-pg-* fixture clusters are allowed.');
  const data = join(root, 'data'), socket = join(root, 'socket'), log = join(root, 'postgres.log');
  await mkdir(socket, { recursive: true, mode: 0o700 });
  let initialized = true;
  try { await access(join(data, 'PG_VERSION')); } catch { initialized = false; }
  if (!initialized) {
    const init = spawnSync(join(bins, 'initdb'), ['-D', data, '-U', 'alfred_test', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8', '--no-instructions'], { encoding: 'utf8' });
    if (init.status !== 0) throw new Error(`Local initdb failed: ${init.stderr || init.error || init.stdout}`);
  }
  let server;
  const clients = new Set();
  async function connect(applicationName = 'alfred-local-fixture') {
    if (!/^\/tmp\/alfred-durable-pg-[^/]+\/socket$/.test(socket)) throw new Error('Refusing a non-fixture database socket.');
    const client = new Client({ host: socket, port: 55439, user: 'alfred_test', password: 'fictional-local-only', database: 'postgres', application_name: applicationName, ssl: false, connectionTimeoutMillis: 1000 });
    client.on('error', () => {});
    await client.connect();
    clients.add(client);
    client.on('end', () => clients.delete(client));
    return client;
  }
  async function launch() {
    const output = await open(log, 'a');
    server = spawn(join(bins, 'postgres'), ['-D', data, '-h', '', '-k', socket, '-p', '55439', '-c', 'unix_socket_permissions=0700', '-c', 'max_connections=20', '-c', 'shared_buffers=16MB', '-c', 'fsync=on', '-c', 'full_page_writes=on', '-c', 'synchronous_commit=on', '-c', 'deadlock_timeout=100ms'], { stdio: ['ignore', output.fd, output.fd] });
    await output.close();
    let spawnFailure;
    server.on('error', error => { spawnFailure = error; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (spawnFailure || server.exitCode !== null) throw new Error(`Local postgres failed: ${spawnFailure ?? server.exitCode}\n${await readFile(log, 'utf8')}`);
      try { const ready = await connect('alfred-ready-probe'); await ready.end(); return; } catch {}
      await delay(50);
    }
    throw new Error(`Local postgres did not become ready: ${await readFile(log, 'utf8')}`);
  }
  async function awaitExit(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((yes, no) => {
      const timer = setTimeout(() => no(new Error('Local postgres shutdown deadline exceeded')), 10000);
      child.once('exit', () => { clearTimeout(timer); yes(); });
    });
  }
  async function crashAndRestart() {
    const owned = server;
    owned.kill('SIGQUIT');
    await awaitExit(owned);
    await Promise.allSettled([...clients].map(client => client.end()));
    clients.clear();
    await launch();
  }
  async function stop() {
    await Promise.allSettled([...clients].map(client => client.end()));
    clients.clear();
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      await awaitExit(server);
    }
  }
  try { await launch(); } catch (error) { await stop().catch(() => {}); throw error; }
  return { root, data, socket, log, connect, crashAndRestart, stop };
}

// Opt-in real PostgreSQL integration checks. No URL or external database is accepted.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let binaryDirectory, output;
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === '--bin-dir') binaryDirectory = args[index + 1];
    else if (args[index] === '--output') output = args[index + 1];
    else throw new Error('Only --bin-dir and --output are supported; no database URL is accepted.');
  }
  void import('../tests/durable-real-postgres.integration.mjs').then(({ runIntegratedPostgresChecks }) => runIntegratedPostgresChecks({ binaryDirectory, output })).catch(error => { console.error(error); process.exitCode = 1; });
}
