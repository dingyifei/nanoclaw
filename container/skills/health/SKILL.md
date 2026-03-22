---
name: health
description: Task health dashboard — deferral tracking, run statistics, recent failures, and stale task detection. Use when the user asks about task health or runs /health.
---

# /health — Task Health Dashboard

Generate a read-only health report of the task scheduler.

**Main-channel check:** Only the main channel has `/workspace/project` mounted. Run:

```bash
test -d /workspace/project && echo "MAIN" || echo "NOT_MAIN"
```

If `NOT_MAIN`, respond with:
> This command is available in your main chat only. Send `/health` there to check task health.

Then stop — do not generate the report.

## How to gather the information

### 1. Load health data

Call the MCP tool:

```
Call mcp__nanoclaw__get_task_health to get task health data.
```

If no data is available, fall back to reading the file directly:

```bash
cat /workspace/ipc/task_health.json 2>/dev/null || echo "NO_HEALTH_DATA"
```

If still no data, report "No health data available. Health data is generated when tasks run."

### 2. Analyze the data

From the health snapshot JSON:

- **Stale tasks**: tasks where `stale` is `true` — conditions have not been met for an extended period
- **Recent failures**: the `recent_failures` array — tasks that errored recently
- **Per-task stats**: each task's `run_stats` (total_runs, success_count, error_count, avg_duration_ms)
- **Deferral info**: each task's `deferral` object (count, since, reason) — how many times conditions blocked execution

## Report format

Present as a clean, readable message:

```
*Task Health Dashboard*

*Overview:*
- Active tasks: N
- Stale tasks: N (conditions unmet for extended period)
- Recent failures: N

*Stale Tasks:*
- [task-abc123] "Check weather..." — deferred 15x since 2026-03-22 08:00
  Reason: WiFi not connected to Office

*Recent Failures:*
- [task-def456] failed at 2026-03-22 09:15 — Container timed out
- [task-ghi789] failed at 2026-03-22 08:00 — API rate limited

*Task Stats:*
| Task | Runs | Success | Avg Duration |
|------|------|---------|-------------|
| [task-abc123] Check weather... | 45 | 98% | 12s |
| [task-def456] Sync files... | 20 | 85% | 45s |
```

Adapt based on what you find:
- If no tasks exist: "No scheduled tasks to monitor."
- If all healthy: "All N tasks healthy — no stale tasks or recent failures."
- If a task has 0 runs: show "No runs yet" instead of stats.
- Omit empty sections (e.g., skip "Stale Tasks" if none are stale).

**See also:** `/status` for system-level health check.
