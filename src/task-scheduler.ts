import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ConditionsConfig,
  evaluateConditions,
  parseConditions,
} from './conditions.js';
import {
  ContainerOutput,
  HealthSnapshot,
  TaskHealthData,
  runContainerAgent,
  writeHealthSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getRecentFailures,
  getTaskById,
  getTaskRunStats,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

// ---------------------------------------------------------------------------
// Deferral tracking
// ---------------------------------------------------------------------------

export interface DeferralState {
  count: number;
  firstDeferredAt: number;
  lastReason: string;
  alertedAt: number | null;
  lastRemindedAt: number | null;
}

const deferralCounts = new Map<string, DeferralState>();

export function getDeferralStates(): ReadonlyMap<string, DeferralState> {
  return deferralCounts;
}

/** Check whether a task is stale given its deferral state and config. */
function isTaskStale(state: DeferralState, config: ConditionsConfig): boolean {
  if (config.staleAfter.type === 'deferrals') {
    return state.count >= config.staleAfter.value;
  }
  return Date.now() - state.firstDeferredAt >= config.staleAfter.ms;
}

/** Build a HealthSnapshot from current state. */
export function buildHealthSnapshot(
  tasks: Array<{
    id: string;
    group_folder: string;
    prompt: string;
    status: string;
    schedule_type: string;
    schedule_value: string;
    next_run: string | null;
    last_run: string | null;
    conditions?: string | null;
  }>,
): HealthSnapshot {
  const healthTasks: TaskHealthData[] = tasks.map((t) => {
    const deferral = deferralCounts.get(t.id);
    const config = parseConditions(t.conditions ?? null);
    return {
      taskId: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      status: t.status,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      next_run: t.next_run,
      last_run: t.last_run,
      conditions: t.conditions ?? null,
      deferral: deferral
        ? {
            count: deferral.count,
            since: new Date(deferral.firstDeferredAt).toISOString(),
            reason: deferral.lastReason,
          }
        : null,
      stale: deferral && config ? isTaskStale(deferral, config) : false,
      run_stats: getTaskRunStats(t.id),
    };
  });

  const recentFailures = getRecentFailures(10);

  return {
    generated_at: new Date().toISOString(),
    tasks: healthTasks,
    recent_failures: recentFailures.map((f) => ({
      task_id: f.task_id,
      run_at: f.run_at,
      error: f.error,
    })),
  };
}

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  const taskRows = tasks.map((t) => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run,
    conditions: t.conditions,
  }));
  writeTasksSnapshot(task.group_folder, isMain, taskRows);
  writeHealthSnapshot(task.group_folder, isMain, buildHealthSnapshot(tasks));

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Evaluate execution conditions before enqueueing
        const config = parseConditions(currentTask.conditions ?? null);
        if (config) {
          const result = await evaluateConditions(config.expr);
          if (!result.passed) {
            const state = deferralCounts.get(currentTask.id) ?? {
              count: 0,
              firstDeferredAt: Date.now(),
              lastReason: '',
              alertedAt: null,
              lastRemindedAt: null,
            };
            state.count++;
            state.lastReason = result.reason;
            deferralCounts.set(currentTask.id, state);

            // Check if stale and send reminders
            if (isTaskStale(state, config)) {
              const now = Date.now();
              const shouldRemind =
                !state.alertedAt ||
                now - (state.lastRemindedAt ?? state.alertedAt) >=
                  config.remindIntervalMs;

              if (shouldRemind) {
                if (!state.alertedAt) state.alertedAt = now;
                state.lastRemindedAt = now;
                logger.warn(
                  {
                    taskId: currentTask.id,
                    deferralCount: state.count,
                    reason: result.reason,
                  },
                  'Task stale',
                );
                deps
                  .sendMessage(
                    currentTask.chat_jid,
                    `⚠️ Task "${currentTask.prompt.slice(0, 50)}..." deferred ${state.count}x since ${new Date(state.firstDeferredAt).toLocaleString()}. Condition: ${result.reason}`,
                  )
                  .catch(() => {});
              }
            }

            const delayMs = result.retry_intervals * SCHEDULER_POLL_INTERVAL;
            const retryAt = new Date(Date.now() + delayMs).toISOString();
            updateTask(currentTask.id, { next_run: retryAt });
            logger.info(
              {
                taskId: currentTask.id,
                reason: result.reason,
                retryAt,
                deferralCount: state.count,
              },
              'Conditions not met, delaying',
            );
            continue;
          }
          // Conditions passed — reset deferral
          deferralCounts.delete(currentTask.id);
          logger.info({ taskId: currentTask.id }, 'All conditions met');
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
  deferralCounts.clear();
}
