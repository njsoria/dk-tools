/**
 * Starts the webhook monitor. monitor.ts has the routes and what they do.
 *
 * It needs nothing installed and nothing from the rest of this repository, so
 * Railway can run it as a service of its own (root directory: monitor).
 * MONITOR_TOKEN opens the page; HOOK_KEY, optional, goes in the address.
 */

import { readFileSync } from 'node:fs';
import { createMonitor } from './monitor.ts';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const token = process.env.MONITOR_TOKEN?.trim() ?? '';
const hookKey = process.env.HOOK_KEY?.trim() ?? '';

if (hookKey && !/^[\w.~-]+$/.test(hookKey)) {
  console.log('HOOK_KEY may hold only letters, digits and - _ . ~; the monitor is not started.');
  process.exit(1);
}

const server = createMonitor({ version, token, hookKey });
const port = Number(process.env.PORT) || 3000;
// Every interface, not only localhost: the host's router reaches it from outside the container.
server.listen(port, '0.0.0.0', () => {
  console.log(`webhook monitor ${version} listening on ${port}`);
  console.log(`address under test: ${hookKey ? `/hook/${hookKey}` : '/hook (anyone who knows it can send to it: set HOOK_KEY)'}`);
  if (!token) console.log('the page is off: MONITOR_TOKEN is not set');
});

// A deploy replaces the container with SIGTERM.
process.on('SIGTERM', () => server.close(() => process.exit(0)));
