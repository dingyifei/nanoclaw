# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| Incoming messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (lightweight Linux VMs), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

**Read-Only Project Root:**

The main group's project root is mounted read-only. Writable paths the agent needs (group folder, IPC, `.claude/`) are mounted separately. This prevents the agent from modifying host application code (`src/`, `dist/`, `package.json`, etc.) which would bypass the sandbox entirely on next restart.

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credential Isolation (OneCLI Agent Vault)

Real API credentials **never enter containers**. NanoClaw uses [OneCLI's Agent Vault](https://github.com/onecli/onecli) to proxy outbound requests and inject credentials at the gateway level.

**How it works:**
1. Credentials are registered once with `onecli secrets create`, stored and managed by OneCLI
2. When NanoClaw spawns a container, it calls `applyContainerConfig()` to route outbound HTTPS through the OneCLI gateway
3. The gateway matches requests by host and path, injects the real credential, and forwards
4. Agents cannot discover real credentials — not in environment, stdin, files, or `/proc`

**Per-agent policies:**
Each NanoClaw group gets its own OneCLI agent identity. This allows different credential policies per group (e.g. your sales agent vs. support agent). OneCLI supports rate limits, and time-bound access and approval flows are on the roadmap.

**NOT Mounted:**
- Channel auth sessions (`store/auth/`) — host only
- Mount allowlist — external, never mounted
- Any credentials matching blocked patterns
- `.env` is shadowed with `/dev/null` in the project root mount

### 6. Appium MCP Bridge (Optional)

When `APPIUM_BRIDGE_ENABLED=true`, the host exposes `appium-mcp` to containers for physical device control (Android/iOS over USB). Security follows the credential proxy pattern:

- **Network binding** — Bound to the bridge interface (`PROXY_BIND_HOST`), not WiFi-facing
- **Token auth** — Same per-session 32-byte hex token as the credential proxy; every request must include `Authorization: Bearer <token>`
- **Per-group opt-in** — Only groups with `containerConfig.appium: true` receive the bridge URL; other groups have no access
- **No credential exposure** — Containers never see ADB keys (`~/.android/`) or device pairing secrets
- **Physical device access** — ADB over USB uses RSA key pairing (device must explicitly trust the host); WiFi ADB is not used

**Risk:** A container with appium access can interact with any app on the connected device. This is by design — the feature is opt-in per group and intended for trusted (main group) use only.

### 7. GitHub Token (Direct Injection)

When `GITHUB_TOKEN` is set in `.env`, it is read via `readEnvFile()` and passed directly to containers as an environment variable. This deliberately does **not** use the credential proxy pattern because:

- **`gh` CLI requires a real token** — it authenticates via `gh auth login --with-token`, not through an HTTP proxy
- **Different protocols** — git push uses git-over-HTTPS, `gh` uses the GitHub REST API; neither can be routed through the Anthropic credential proxy

**Defense in depth (three layers):**

1. **Token scoping** — Use a fine-grained PAT limited to specific repositories with minimal permissions (Contents: Write, Pull requests: Write, Metadata: Read)
2. **Client-side wrapper** — `safe-git.sh` blocks force push, direct push to protected branches, `reset --hard`, and remote branch deletion before they reach the network
3. **Server-side enforcement** — GitHub branch protection rules reject force pushes and require PR reviews regardless of token permissions

**Log redaction** — Container args containing `GITHUB_TOKEN` are redacted in host-side log output to prevent token leakage to disk.

**Risk:** A container with `GITHUB_TOKEN` can perform any git/GitHub operation within the token's scope. Mitigated by token scoping, the safe-git wrapper, and branch protection rules.

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (ro) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| GitHub access | If GITHUB_TOKEN set | If GITHUB_TOKEN set |
| MCP tools | All | All |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Incoming Messages (potentially malicious)                         │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • Credential proxy (injects auth headers)                       │
│  • Appium bridge (optional, token-authed device control)        │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only, no secrets
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • API calls routed through credential proxy                     │
│  • Device control via Appium bridge (if enabled)                │
│  • GitHub access via GITHUB_TOKEN (if configured, redacted in   │
│    logs, scoped by safe-git wrapper)                             │
│  • No Anthropic credentials in environment or filesystem        │
└──────────────────────────────────────────────────────────────────┘
```
