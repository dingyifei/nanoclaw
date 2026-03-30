/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN: 'docker' | 'container' = 'docker';

/**
 * Address containers use to reach the host machine.
 * Docker Desktop (macOS/WSL): host.docker.internal is auto-resolved.
 * Apple Container (macOS): uses 192.168.64.1 — the well-known bridge gateway.
 * Docker (Linux): host.docker.internal added via --add-host flag.
 */
export const CONTAINER_HOST_GATEWAY = detectHostGateway();

function detectHostGateway(): string {
  if (CONTAINER_RUNTIME_BIN === 'container' && os.platform() === 'darwin') {
    return '192.168.64.1';
  }
  return 'host.docker.internal';
}

/**
 * Address the credential proxy binds to.
 * Apple Container (macOS): 192.168.64.1 — the bridge100 gateway. ensureBridge100()
 *   must be called before binding to create the interface via a throwaway container.
 * Docker Desktop (macOS/WSL): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  // Apple Container: bind to bridge100 gateway (not 0.0.0.0) to avoid exposing
  // the credential proxy on WiFi/external interfaces.
  if (CONTAINER_RUNTIME_BIN === 'container' && os.platform() === 'darwin') {
    return '192.168.64.1';
  }

  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** Check whether bridge100 (Apple Container vmnet bridge) has an IPv4 address. */
function hasBridge100(): boolean {
  const ifaces = os.networkInterfaces();
  const bridge = ifaces['bridge100'];
  return !!bridge?.some((a) => a.family === 'IPv4');
}

/**
 * Ensure the bridge100 interface exists before binding the credential proxy.
 * Apple Container creates bridge100 via vmnet only when the first container runs,
 * so we spawn a throwaway container to trigger it, then poll until it appears.
 * Returns the address the proxy should bind to.
 */
export async function ensureBridge100(): Promise<string> {
  // Only needed for Apple Container on macOS
  if (CONTAINER_RUNTIME_BIN !== 'container' || os.platform() !== 'darwin') {
    return PROXY_BIND_HOST;
  }

  // Respect explicit env override
  if (process.env.CREDENTIAL_PROXY_HOST) {
    return process.env.CREDENTIAL_PROXY_HOST;
  }

  if (hasBridge100()) {
    logger.info('bridge100 already exists');
    return '192.168.64.1';
  }

  // Spawn throwaway container to force vmnet to create bridge100
  logger.info('Spawning throwaway container to create bridge100...');
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} run --rm alpine /bin/true`, {
      stdio: 'pipe',
      timeout: 30000,
    });
  } catch (err) {
    logger.warn(
      { err },
      'Throwaway container failed (bridge100 may still appear)',
    );
  }

  // Poll for bridge100 (up to 5 seconds)
  for (let i = 0; i < 10; i++) {
    if (hasBridge100()) {
      logger.info('bridge100 is now available');
      return '192.168.64.1';
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Fallback with warning — token auth (Mitigation B) still protects
  logger.warn(
    'bridge100 did not appear after throwaway container. ' +
      'Falling back to 0.0.0.0 — proxy will be exposed on all interfaces. ' +
      'Set CREDENTIAL_PROXY_HOST=192.168.64.1 to override once bridge100 exists.',
  );
  return '0.0.0.0';
}


/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return [
    '--mount',
    `type=bind,source=${hostPath},target=${containerPath},readonly`,
  ];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  if (CONTAINER_RUNTIME_BIN === 'container') {
    // Apple Container: use `container system status` / `container system start`
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
      logger.debug('Container runtime already running');
    } catch {
      logger.info('Starting container runtime...');
      try {
        execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
          stdio: 'pipe',
          timeout: 30000,
        });
        logger.info('Container runtime started');
      } catch (err) {
        logger.error({ err }, 'Failed to start container runtime');
        throw new Error('Container runtime is required but failed to start');
      }
    }
  } else {
    // Docker/OrbStack: verify with `docker info`
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} info`, {
        stdio: 'pipe',
        timeout: 10000,
      });
      logger.debug('Container runtime already running');
    } catch (err) {
      logger.error({ err }, 'Docker is not running');
      throw new Error(
        'Container runtime is required but failed to start. Ensure Docker/OrbStack is running.',
      );
    }
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    let orphans: string[];
    if (CONTAINER_RUNTIME_BIN === 'container') {
      // Apple Container: JSON output with { status, configuration.id }
      const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      const containers: { status: string; configuration: { id: string } }[] =
        JSON.parse(output || '[]');
      orphans = containers
        .filter(
          (c) =>
            c.status === 'running' &&
            c.configuration.id.startsWith('nanoclaw-'),
        )
        .map((c) => c.configuration.id);
    } else {
      // Docker: use --filter and --format to list running nanoclaw containers
      const output = execSync(
        `${CONTAINER_RUNTIME_BIN} ps --filter "name=nanoclaw-" --format "{{.Names}}"`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
      );
      orphans = output
        .trim()
        .split('\n')
        .filter((n) => n.startsWith('nanoclaw-'));
    }
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
