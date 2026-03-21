/**
 * Task execution conditions — check system state before running a task.
 *
 * Conditions form an expression tree: leaf conditions, `{ and: [...] }`,
 * and `{ or: [...] }` nodes. A flat array at the top level is implicit AND.
 */
import { execSync } from 'child_process';

import { CronExpressionParser } from 'cron-parser';

import { SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Leaf condition — a single system check. */
export type TaskCondition =
  // Power
  | { type: 'battery_charging'; retry_intervals?: number }
  | {
      type: 'battery_level';
      operator: '>=' | '<=' | '>' | '<';
      value: number;
      retry_intervals?: number;
    }
  | { type: 'low_power_mode'; active: boolean; retry_intervals?: number }
  // Network
  | { type: 'wifi_connected'; ssid?: string; retry_intervals?: number }
  | { type: 'network_reachable'; host: string; retry_intervals?: number }
  | { type: 'vpn_connected'; retry_intervals?: number }
  // System
  | {
      type: 'cpu_usage';
      operator: '>=' | '<=' | '>' | '<';
      value: number;
      retry_intervals?: number;
    }
  | {
      type: 'process_running';
      name: string;
      negate?: boolean;
      retry_intervals?: number;
    }
  | { type: 'screen_asleep'; active: boolean; retry_intervals?: number }
  | { type: 'do_not_disturb'; active: boolean; retry_intervals?: number }
  // Time
  | { type: 'schedule_window'; cron: string; retry_intervals?: number };

/**
 * A condition expression is either a leaf condition or a logical group.
 * Top-level storage accepts `ConditionExpr | ConditionExpr[]` (array = implicit AND).
 */
export type ConditionExpr =
  | TaskCondition
  | { and: ConditionExpr[] }
  | { or: ConditionExpr[] };

/** Result of evaluating a condition expression. */
export interface ConditionResult {
  passed: boolean;
  reason: string;
  /** Multiplier for SCHEDULER_POLL_INTERVAL to compute retry delay. */
  retry_intervals: number;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse a JSON conditions column. Returns null for null/empty (backward compat). */
export function parseConditions(json: string | null): ConditionExpr | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (parsed === null || parsed === undefined) return null;
    // Flat array = implicit AND
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return null;
      if (parsed.length === 1) return parsed[0] as ConditionExpr;
      return { and: parsed as ConditionExpr[] };
    }
    return parsed as ConditionExpr;
  } catch (err) {
    logger.warn({ json, err }, 'Malformed conditions JSON');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shell helpers (macOS)
// ---------------------------------------------------------------------------

const SHELL_TIMEOUT = 2000; // 2 seconds

function execShell(cmd: string): string {
  return execSync(cmd, { timeout: SHELL_TIMEOUT, encoding: 'utf-8' });
}

/** Battery info from a single `pmset -g batt` call. */
export async function checkBattery(): Promise<{
  charging: boolean;
  level: number;
}> {
  try {
    const output = execShell('pmset -g batt');
    const charging = /charging/i.test(output) || /AC Power/i.test(output);
    const levelMatch = output.match(/(\d+)%/);
    const level = levelMatch ? parseInt(levelMatch[1], 10) : 0;
    return { charging, level };
  } catch (err) {
    logger.warn({ err }, 'Failed to check battery');
    return { charging: false, level: 0 };
  }
}

export async function checkLowPowerMode(): Promise<boolean> {
  try {
    const output = execShell('pmset -g');
    return /lowpowermode\s+1/i.test(output);
  } catch (err) {
    logger.warn({ err }, 'Failed to check low power mode');
    return false;
  }
}

export async function checkWifi(): Promise<{
  connected: boolean;
  ssid: string | null;
}> {
  try {
    const output = execShell('networksetup -getairportnetwork en0');
    if (/not associated/i.test(output)) {
      return { connected: false, ssid: null };
    }
    const ssidMatch = output.match(/Current Wi-Fi Network:\s*(.+)/);
    return {
      connected: true,
      ssid: ssidMatch ? ssidMatch[1].trim() : null,
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to check WiFi');
    return { connected: false, ssid: null };
  }
}

export async function checkNetworkReachable(host: string): Promise<boolean> {
  try {
    execShell(`ping -c 1 -W 2 ${host}`);
    return true;
  } catch {
    return false;
  }
}

export async function checkVpn(): Promise<boolean> {
  try {
    const output = execShell('scutil --nc list');
    return /\(Connected\)/i.test(output);
  } catch (err) {
    logger.warn({ err }, 'Failed to check VPN');
    return false;
  }
}

export async function checkCpuUsage(): Promise<number> {
  try {
    const output = execShell('top -l 1 -n 0');
    const idleMatch = output.match(/CPU usage:.*?([\d.]+)%\s*idle/);
    if (idleMatch) {
      return 100 - parseFloat(idleMatch[1]);
    }
    return 0;
  } catch (err) {
    logger.warn({ err }, 'Failed to check CPU usage');
    return 0;
  }
}

export async function checkProcessRunning(name: string): Promise<boolean> {
  try {
    execShell(`pgrep -x ${name}`);
    return true;
  } catch {
    return false;
  }
}

export async function checkScreenAsleep(): Promise<boolean> {
  try {
    const output = execShell('ioreg -r -k AppleDisplayIsAsleep -d 1');
    return /"AppleDisplayIsAsleep"\s*=\s*1/.test(output);
  } catch (err) {
    logger.warn({ err }, 'Failed to check screen state');
    return false;
  }
}

export async function checkDoNotDisturb(): Promise<boolean> {
  try {
    const output = execShell(
      'defaults read com.apple.controlcenter "NSStatusItem Visible FocusModes"',
    );
    return output.trim() === '1';
  } catch {
    // Command fails when key doesn't exist = DND off
    return false;
  }
}

/**
 * Check if current time falls within a cron schedule window.
 * Passes if the most recent match of the cron pattern is within
 * the last SCHEDULER_POLL_INTERVAL.
 */
export function checkScheduleWindow(
  cron: string,
  pollInterval: number = SCHEDULER_POLL_INTERVAL,
): boolean {
  try {
    const interval = CronExpressionParser.parse(cron, { tz: TIMEZONE });
    const prev = interval.prev().getTime();
    return Date.now() - prev < pollInterval;
  } catch (err) {
    logger.warn({ cron, err }, 'Invalid schedule_window cron expression');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function compare(
  actual: number,
  operator: '>=' | '<=' | '>' | '<',
  target: number,
): boolean {
  switch (operator) {
    case '>=':
      return actual >= target;
    case '<=':
      return actual <= target;
    case '>':
      return actual > target;
    case '<':
      return actual < target;
  }
}

/** Evaluate a single leaf condition. */
async function evaluateLeaf(
  condition: TaskCondition,
  batteryCache: { value: { charging: boolean; level: number } | null },
): Promise<ConditionResult> {
  const retryIntervals = condition.retry_intervals ?? 1;

  switch (condition.type) {
    case 'battery_charging': {
      if (!batteryCache.value) batteryCache.value = await checkBattery();
      const { charging } = batteryCache.value;
      logger.debug({ type: 'battery_charging', charging }, 'Condition check');
      return {
        passed: charging,
        reason: charging ? 'Battery is charging' : 'Battery is not charging',
        retry_intervals: retryIntervals,
      };
    }

    case 'battery_level': {
      if (!batteryCache.value) batteryCache.value = await checkBattery();
      const { level } = batteryCache.value;
      const passed = compare(level, condition.operator, condition.value);
      logger.debug(
        {
          type: 'battery_level',
          actual: level,
          required: `${condition.operator}${condition.value}`,
        },
        'Condition check',
      );
      return {
        passed,
        reason: passed
          ? `Battery level ${level}% meets ${condition.operator}${condition.value}%`
          : `Battery level ${level}% does not meet ${condition.operator}${condition.value}%`,
        retry_intervals: retryIntervals,
      };
    }

    case 'low_power_mode': {
      const active = await checkLowPowerMode();
      const passed = active === condition.active;
      logger.debug(
        { type: 'low_power_mode', actual: active, required: condition.active },
        'Condition check',
      );
      return {
        passed,
        reason: passed
          ? `Low power mode is ${active ? 'on' : 'off'} as required`
          : `Low power mode is ${active ? 'on' : 'off'}, expected ${condition.active ? 'on' : 'off'}`,
        retry_intervals: retryIntervals,
      };
    }

    case 'wifi_connected': {
      const wifi = await checkWifi();
      let passed = wifi.connected;
      if (passed && condition.ssid) {
        passed = wifi.ssid === condition.ssid;
      }
      logger.debug(
        {
          type: 'wifi_connected',
          connected: wifi.connected,
          ssid: wifi.ssid,
          requiredSsid: condition.ssid,
        },
        'Condition check',
      );
      return {
        passed,
        reason: passed
          ? `WiFi connected${condition.ssid ? ` to ${wifi.ssid}` : ''}`
          : condition.ssid
            ? `WiFi not connected to ${condition.ssid} (current: ${wifi.ssid || 'disconnected'})`
            : 'WiFi not connected',
        retry_intervals: retryIntervals,
      };
    }

    case 'network_reachable': {
      const reachable = await checkNetworkReachable(condition.host);
      logger.debug(
        { type: 'network_reachable', host: condition.host, reachable },
        'Condition check',
      );
      return {
        passed: reachable,
        reason: reachable
          ? `${condition.host} is reachable`
          : `${condition.host} is not reachable`,
        retry_intervals: retryIntervals,
      };
    }

    case 'vpn_connected': {
      const connected = await checkVpn();
      logger.debug({ type: 'vpn_connected', connected }, 'Condition check');
      return {
        passed: connected,
        reason: connected ? 'VPN is connected' : 'VPN is not connected',
        retry_intervals: retryIntervals,
      };
    }

    case 'cpu_usage': {
      const usage = await checkCpuUsage();
      const passed = compare(usage, condition.operator, condition.value);
      logger.debug(
        {
          type: 'cpu_usage',
          actual: usage,
          required: `${condition.operator}${condition.value}`,
        },
        'Condition check',
      );
      return {
        passed,
        reason: passed
          ? `CPU usage ${usage.toFixed(1)}% meets ${condition.operator}${condition.value}%`
          : `CPU usage ${usage.toFixed(1)}% does not meet ${condition.operator}${condition.value}%`,
        retry_intervals: retryIntervals,
      };
    }

    case 'process_running': {
      const running = await checkProcessRunning(condition.name);
      const passed = condition.negate ? !running : running;
      logger.debug(
        {
          type: 'process_running',
          name: condition.name,
          running,
          negate: condition.negate,
        },
        'Condition check',
      );
      return {
        passed,
        reason: passed
          ? condition.negate
            ? `Process ${condition.name} is not running (as required)`
            : `Process ${condition.name} is running`
          : condition.negate
            ? `Process ${condition.name} is still running`
            : `Process ${condition.name} is not running`,
        retry_intervals: retryIntervals,
      };
    }

    case 'screen_asleep': {
      const asleep = await checkScreenAsleep();
      const passed = asleep === condition.active;
      logger.debug(
        { type: 'screen_asleep', actual: asleep, required: condition.active },
        'Condition check',
      );
      return {
        passed,
        reason: passed
          ? `Screen is ${asleep ? 'asleep' : 'awake'} as required`
          : `Screen is ${asleep ? 'asleep' : 'awake'}, expected ${condition.active ? 'asleep' : 'awake'}`,
        retry_intervals: retryIntervals,
      };
    }

    case 'do_not_disturb': {
      const dnd = await checkDoNotDisturb();
      const passed = dnd === condition.active;
      logger.debug(
        {
          type: 'do_not_disturb',
          actual: dnd,
          required: condition.active,
        },
        'Condition check',
      );
      return {
        passed,
        reason: passed
          ? `Do Not Disturb is ${dnd ? 'on' : 'off'} as required`
          : `Do Not Disturb is ${dnd ? 'on' : 'off'}, expected ${condition.active ? 'on' : 'off'}`,
        retry_intervals: retryIntervals,
      };
    }

    case 'schedule_window': {
      const passed = checkScheduleWindow(condition.cron);
      logger.debug(
        { type: 'schedule_window', cron: condition.cron, passed },
        'Condition check',
      );
      return {
        passed,
        reason: passed
          ? `Within schedule window (${condition.cron})`
          : `Outside schedule window (${condition.cron})`,
        retry_intervals: retryIntervals,
      };
    }

    default: {
      // Unknown condition type — skip gracefully (future-proofing)
      const unknownType = (condition as { type: string }).type;
      logger.warn({ type: unknownType }, 'Unknown condition type, skipping');
      return {
        passed: true,
        reason: `Unknown type: ${unknownType}`,
        retry_intervals: 1,
      };
    }
  }
}

function isAndNode(expr: ConditionExpr): expr is { and: ConditionExpr[] } {
  return 'and' in expr && Array.isArray((expr as { and: unknown }).and);
}

function isOrNode(expr: ConditionExpr): expr is { or: ConditionExpr[] } {
  return 'or' in expr && Array.isArray((expr as { or: unknown }).or);
}

/**
 * Recursively evaluate a condition expression tree.
 *
 * - AND: all children must pass. Fail retry = max of failing children.
 * - OR: at least one child must pass. Fail retry = min of failing children.
 * - Leaf: run the individual check.
 *
 * Battery checks share a single `pmset -g batt` call via `batteryCache`.
 */
export async function evaluateConditions(
  expr: ConditionExpr,
  batteryCache: { value: { charging: boolean; level: number } | null } = {
    value: null,
  },
): Promise<ConditionResult> {
  if (isAndNode(expr)) {
    const results = await Promise.all(
      expr.and.map((child) => evaluateConditions(child, batteryCache)),
    );
    const failures = results.filter((r) => !r.passed);
    if (failures.length === 0) {
      return { passed: true, reason: 'All conditions met', retry_intervals: 1 };
    }
    // AND fails: use max retry_intervals (wait for slowest blocker)
    const maxRetry = Math.max(...failures.map((f) => f.retry_intervals));
    const reasons = failures.map((f) => f.reason).join('; ');
    return { passed: false, reason: reasons, retry_intervals: maxRetry };
  }

  if (isOrNode(expr)) {
    const results = await Promise.all(
      expr.or.map((child) => evaluateConditions(child, batteryCache)),
    );
    const successes = results.filter((r) => r.passed);
    if (successes.length > 0) {
      return {
        passed: true,
        reason: successes[0].reason,
        retry_intervals: 1,
      };
    }
    // OR fails: use min retry_intervals (retry sooner since any branch could unblock)
    const minRetry = Math.min(...results.map((r) => r.retry_intervals));
    const reasons = results.map((r) => r.reason).join('; ');
    return { passed: false, reason: reasons, retry_intervals: minRetry };
  }

  // Leaf condition
  return evaluateLeaf(expr, batteryCache);
}
