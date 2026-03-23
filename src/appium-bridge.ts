/**
 * Appium MCP Bridge for NanoClaw
 *
 * Runs appium-mcp as a stdio child process on the host and exposes it
 * as an HTTP-based MCP server that container agents can reach over the
 * bridge network. Follows the same security pattern as credential-proxy.ts:
 * token auth, bound to bridge interface only.
 *
 * Protocol: MCP Streamable HTTP (JSON-RPC over POST /mcp)
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { ChildProcess, spawn } from 'child_process';

import { logger } from './logger.js';

const RESPAWN_DELAY_MS = 2000;
const MAX_RESPAWN_DELAY_MS = 30000;
const REQUEST_TIMEOUT_MS = 120000;

interface PendingRequest {
  resolve: (data: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Starts the Appium MCP bridge HTTP server.
 * Spawns appium-mcp as a child process and proxies JSON-RPC messages
 * between HTTP clients and the stdio transport.
 */
export function startAppiumBridge(
  port: number,
  host: string,
  proxyToken: string,
): Promise<Server> {
  let child: ChildProcess | null = null;
  let respawnDelay = RESPAWN_DELAY_MS;
  let stopping = false;

  // Buffer for partial lines from stdout
  let stdoutBuffer = '';

  // Pending JSON-RPC requests keyed by id
  const pending = new Map<string | number, PendingRequest>();

  // Queue for requests while child is (re)starting
  const waitingForChild: Array<() => void> = [];

  function spawnChild(): void {
    if (stopping) return;

    const npxPath = process.env.NPX_PATH || 'npx';
    child = spawn(npxPath, ['-y', 'appium-mcp@latest'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // appium-mcp needs these
        ANDROID_HOME: process.env.ANDROID_HOME,
        JAVA_HOME: process.env.JAVA_HOME,
        PATH: process.env.PATH,
      },
    });

    const pid = child.pid;
    logger.info({ pid }, 'Appium MCP child process spawned');

    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        if (line) handleStdoutLine(line);
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) logger.debug({ source: 'appium-mcp' }, text);
    });

    child.on('exit', (code, signal) => {
      logger.warn({ code, signal }, 'Appium MCP child process exited');
      child = null;

      // Reject all pending requests
      for (const [id, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error(`Appium MCP process exited (code=${code})`));
        pending.delete(id);
      }

      if (!stopping) {
        logger.info({ delayMs: respawnDelay }, 'Respawning appium-mcp');
        setTimeout(() => {
          spawnChild();
          // Unblock any queued requests
          while (waitingForChild.length) waitingForChild.shift()!();
        }, respawnDelay);
        respawnDelay = Math.min(respawnDelay * 2, MAX_RESPAWN_DELAY_MS);
      }
    });

    // Reset backoff on successful start
    setTimeout(() => {
      if (child && !child.killed) respawnDelay = RESPAWN_DELAY_MS;
    }, 5000);

    // Unblock any queued requests
    while (waitingForChild.length) waitingForChild.shift()!();
  }

  function handleStdoutLine(line: string): void {
    let msg: { id?: string | number; jsonrpc?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      logger.debug({ line }, 'Non-JSON stdout from appium-mcp');
      return;
    }

    if (msg.id != null && pending.has(msg.id)) {
      const req = pending.get(msg.id)!;
      clearTimeout(req.timer);
      pending.delete(msg.id);
      req.resolve(line);
    }
    // Notifications (no id) are logged but not routed back
  }

  function sendToChild(jsonRpcLine: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const send = () => {
        if (!child || !child.stdin || child.stdin.destroyed) {
          reject(new Error('Appium MCP process not available'));
          return;
        }

        let parsed: { id?: string | number };
        try {
          parsed = JSON.parse(jsonRpcLine);
        } catch {
          reject(new Error('Invalid JSON-RPC request'));
          return;
        }

        const id = parsed.id;
        if (id == null) {
          // Notification — fire and forget
          child.stdin.write(jsonRpcLine + '\n');
          resolve('');
          return;
        }

        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Request timeout'));
        }, REQUEST_TIMEOUT_MS);

        pending.set(id, { resolve, reject, timer });
        child.stdin.write(jsonRpcLine + '\n');
      };

      if (child && !child.killed) {
        send();
      } else {
        waitingForChild.push(send);
      }
    });
  }

  // Spawn the child immediately
  spawnChild();

  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // Token auth
      const authHeader = req.headers['authorization'];
      if (authHeader !== `Bearer ${proxyToken}`) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }

      // Only accept POST /mcp
      if (req.method !== 'POST' || !req.url?.startsWith('/mcp')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      // Read request body
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks).toString();
        try {
          const response = await sendToChild(body);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(response);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Internal error';
          logger.error({ err }, 'Appium bridge request failed');
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message },
            id: null,
          }));
        }
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Appium bridge started');
      resolve(server);
    });

    server.on('error', reject);

    // Cleanup helper
    const origClose = server.close.bind(server);
    server.close = (cb?: (err?: Error) => void) => {
      stopping = true;
      if (child) {
        child.kill('SIGTERM');
        child = null;
      }
      for (const [id, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error('Bridge shutting down'));
        pending.delete(id);
      }
      return origClose(cb);
    };
  });
}
