# Task Execution Conditions

Conditions let you defer scheduled tasks until the system is in the right state — for example, only run a heavy sync when charging and on WiFi, or only send notifications when Do Not Disturb is off.

When conditions aren't met, the task is delayed and retried later. There's no max retries — conditions are transient (battery will charge, WiFi will reconnect), so the task keeps waiting.

## Condition Types

### Power

| Type | Parameters | Description |
|------|-----------|-------------|
| `battery_charging` | — | Device is plugged in (charging or on AC power) |
| `battery_level` | `operator`: `>=`, `<=`, `>`, `<`; `value`: number (0–100) | Battery percentage meets threshold |
| `low_power_mode` | `active`: boolean | Low Power Mode is on/off |

### Network

| Type | Parameters | Description |
|------|-----------|-------------|
| `wifi_connected` | `ssid?`: string | WiFi is connected (optionally to a specific network) |
| `network_reachable` | `host`: string | Host is reachable via ping |
| `vpn_connected` | — | Any VPN connection is active |

### System

| Type | Parameters | Description |
|------|-----------|-------------|
| `cpu_usage` | `operator`: `>=`, `<=`, `>`, `<`; `value`: number (0–100) | CPU usage percentage meets threshold |
| `process_running` | `name`: string; `negate?`: boolean | Process is running (or not, if `negate: true`) |
| `screen_asleep` | `active`: boolean | Screen is asleep/awake |
| `do_not_disturb` | `active`: boolean | Focus/Do Not Disturb is on/off |

### Time

| Type | Parameters | Description |
|------|-----------|-------------|
| `schedule_window` | `cron`: string (standard cron) | Current time matches the cron pattern |

#### `schedule_window` examples
- `* 9-17 * * 1-5` — weekdays 9am–5pm
- `* * * * 1-5` — weekdays only
- `* 22-23,0-5 * * *` — overnight only

## Composition (AND/OR)

Conditions can be composed into trees using AND and OR nodes.

### Flat array (implicit AND)

A top-level array is treated as AND — all conditions must pass:

```json
[
  { "type": "battery_charging" },
  { "type": "wifi_connected" }
]
```

### Explicit AND/OR

```json
{
  "or": [
    {
      "and": [
        { "type": "battery_charging" },
        { "type": "wifi_connected" }
      ]
    },
    { "type": "battery_level", "operator": ">=", "value": 80 }
  ]
}
```

This means: *(charging AND WiFi) OR (battery >= 80%)*.

### Nesting

You can nest AND/OR to any depth (though 2–3 levels is typical):

```json
{
  "and": [
    { "type": "schedule_window", "cron": "* 9-17 * * 1-5" },
    {
      "or": [
        { "type": "battery_charging" },
        { "type": "battery_level", "operator": ">=", "value": 50 }
      ]
    }
  ]
}
```

## Retry Behavior

Each condition accepts an optional `retry_intervals` field (default: 1). This is a multiplier for the scheduler's poll interval (`SCHEDULER_POLL_INTERVAL`, default 60 seconds) that determines how long to wait before checking again.

```json
{ "type": "battery_charging", "retry_intervals": 5 }
```

This delays the retry by 5 × 60s = 5 minutes when the condition isn't met.

### Retry in AND/OR groups

- **AND**: uses the **max** `retry_intervals` of failing children (wait for the slowest blocker)
- **OR**: uses the **min** `retry_intervals` of failing children (retry sooner since any branch could unblock)

## Stale Detection & Reminders

When conditions are never met, a task can be deferred indefinitely. Stale detection alerts the user when this happens.

### Configuration

Wrap conditions in an object to configure per-task stale alerts:

```json
{
  "conditions": [
    { "type": "wifi_connected", "ssid": "Office" },
    { "type": "battery_charging" }
  ],
  "stale_after": 10,
  "remind_interval": "1h"
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `stale_after` | number or duration string | `10` | Deferrals before alerting. Number = deferral count. String = time duration (e.g., `"30m"`, `"2h"`, `"1d"`). |
| `remind_interval` | duration string | `"1h"` | How often to re-alert after the first stale warning. |

Duration strings support: `ms`, `s`, `m`, `h`, `d` (e.g., `"30m"` = 30 minutes, `"2h"` = 2 hours).

### Backward compatibility

Bare conditions (without the wrapper object) still work. They use the global default threshold (`NANOCLAW_STALE_THRESHOLD` env var, default 10 deferrals) and 1-hour reminders.

```json
[{ "type": "battery_charging" }]
```

is equivalent to:

```json
{
  "conditions": [{ "type": "battery_charging" }],
  "stale_after": 10,
  "remind_interval": "1h"
}
```

### Behavior

1. Each time conditions fail, the deferral count increments.
2. When the threshold is reached, the user receives a chat message with the blocking condition.
3. After the first alert, reminders repeat at `remind_interval` until conditions pass.
4. When conditions pass and the task runs, the deferral counter resets.
5. Deferral counts are in-memory — they reset on process restart.

### Example: alert after 30 minutes, remind every 2 hours

```json
{
  "conditions": { "type": "wifi_connected", "ssid": "Office" },
  "stale_after": "30m",
  "remind_interval": "2h"
}
```

## Examples

### Run only when charging and on WiFi

```json
[
  { "type": "battery_charging" },
  { "type": "wifi_connected" }
]
```

### Run only during business hours

```json
{ "type": "schedule_window", "cron": "* 9-17 * * 1-5" }
```

### Run when CPU is idle

```json
{ "type": "cpu_usage", "operator": "<", "value": 20 }
```

### Run when screen is locked (user away)

```json
{ "type": "screen_asleep", "active": true }
```

### Run when a specific process isn't running

```json
{ "type": "process_running", "name": "Xcode", "negate": true }
```

## Adding a New Condition Type

1. Add a new union member to `TaskCondition` in `src/conditions.ts`
2. Add a checker function (e.g., `checkMyCondition()`)
3. Add a case in `evaluateLeaf()` that calls your checker
4. Update the MCP tool descriptions in `container/agent-runner/src/ipc-mcp-stdio.ts`

No arbitrary shell commands are allowed — conditions execute on the host, and allowing arbitrary commands would break the container security boundary.

## Limitations

- **macOS only**: Shell commands use macOS-specific tools (`pmset`, `networksetup`, `ioreg`, etc.)
- **No custom shell conditions**: For security, only predefined condition types are supported
- **Best-effort checks**: If a shell command fails (timeout, command not found), the condition is treated as not met and a warning is logged
