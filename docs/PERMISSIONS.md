# Permission Control Design — MeshCentral MCP

Status: **proposal / not yet implemented**
Scope: `meshcentral-mcp` (all layers), plus configuration guidance for the MeshCentral server itself.

---

## 1. The problem

The MCP server currently registers **58 tools unconditionally**. Every one of them is
handed to the model the moment the server starts, and every one executes against a single
MeshCentral account supplied through `MESH_USERNAME` / `MESH_PASSWORD`. There is no
allow-list, no tiering, no confirmation step, no audit trail and no scoping. In practice
that means an agent session is granted, by default:

| Capability | Tool | Consequence |
|---|---|---|
| Arbitrary code execution as SYSTEM/root on any managed device | `mesh_run_command`, `mesh_agent_console` | Full estate compromise |
| Arbitrary read of any remote file | `mesh_file_read`, `mesh_file_download` | Mass data exfiltration |
| Arbitrary write/delete on any remote file | `mesh_file_write`, `mesh_file_delete`, `mesh_file_upload` | Destruction, persistence, ransomware-equivalent |
| Arbitrary **local** file read/write on the MCP host | `mesh_file_download` (`local_path`), `mesh_file_upload` (`local_path`) | The agent can write anywhere the MCP process can — including its own config, shell profiles, SSH keys |
| Agent removal / core replacement | `mesh_uninstall_agent`, `mesh_distribute_core` | Loss of management plane, code push to every agent |
| Identity and access management | `mesh_create_user`, `mesh_add_user_to_group`, `mesh_add_device_user` | Privilege escalation and persistence |
| Server console | `mesh_server_console` | Server-level administration |

Two further points sharpen the risk:

1. **Tool output is untrusted input.** File contents, process names, device notes,
   clipboard contents and event logs all come from managed endpoints. A single
   compromised device can plant text that steers the agent into using the destructive
   tools against the rest of the estate. Read-only access is therefore not a safe
   resting state if write tools are also registered.
2. **`runcommands` has no user-consent prompt.** MeshCentral's device-group consent
   flags gate the interactive terminal/desktop/files sessions, but
   `meshuser.js` dispatches `runcommands` to the agent after only a rights-bitmask
   check (`MESHRIGHT_REMOTECOMMAND`, `0x20000`). Nobody on the endpoint sees a prompt.

The goal of this work is to invert the default: **the agent starts with read-only
inventory access, and every capability beyond that is explicitly granted, scoped,
and recorded.**

---

## 2. Design principles

1. **Deny by default.** An unlisted tool is not registered at all.
2. **Don't register what you won't allow.** Filtering at registration time is stronger
   *and* cheaper than filtering at call time — the model never sees the tool, so it never
   plans around it, and the tool-list tokens are saved.
3. **Defence in depth, with the real boundary on the server.** Anything enforced only
   inside the MCP process is bypassed by whoever controls that process. The MeshCentral
   account's own rights bitmask is the only control an attacker with the `.env` cannot
   talk their way past. Do both.
4. **Be honest about what a confirmation is worth.** A confirm-token the *model* echoes
   back is a guard against accidental one-shot invocation, not against a determined or
   prompt-injected agent. Only a prompt that reaches a human (MCP elicitation, or the
   host client's own permission dialogue) is a real control.
5. **Everything mutating is auditable**, independently of MeshCentral's own event log.

---

## 3. Layer 0 — MeshCentral-side least privilege (do this first)

This layer needs no code and delivers most of the risk reduction.

### 3.1 A dedicated, non-admin service account

Create an `mcp-bot` user with `siteadmin = 0`. Never point the MCP at a full site
administrator. Grant device access per group through a user group link with an explicit
bitmask rather than `MESHRIGHT_ADMIN` (`0xFFFFFFFF`).

Relevant rights from `meshuser.js`:

| Right | Value | Grant when the agent must… |
|---|---|---|
| `MESHRIGHT_EDITMESH` | `0x1` | edit group properties |
| `MESHRIGHT_MANAGEUSERS` | `0x2` | manage group membership |
| `MESHRIGHT_MANAGECOMPUTERS` | `0x4` | edit/remove/move devices |
| `MESHRIGHT_REMOTECONTROL` | `0x8` | open any remote session |
| `MESHRIGHT_AGENTCONSOLE` | `0x10` | use `mesh_agent_console` (needs `0x18` together with the above) |
| `MESHRIGHT_WAKEDEVICE` | `0x40` | wake-on-LAN |
| `MESHRIGHT_SETNOTES` | `0x80` | write device notes |
| `MESHRIGHT_UNINSTALL` | `0x8000` | uninstall agents |
| `MESHRIGHT_REMOTECOMMAND` | `0x20000` | **run shell commands — withhold this and `mesh_run_command` is dead server-side** |
| `MESHRIGHT_DEVICEDETAILS` | `0x100000` | read hardware/software inventory |

And the negative rights, which subtract capability even when remote control is granted:

| Non-right | Value | Effect |
|---|---|---|
| `MESHRIGHT_NOTERMINAL` | `0x200` | blocks the terminal relay (`p=1`) |
| `MESHRIGHT_NOFILES` | `0x400` | **blocks the file relay (`p=5`) — kills all eleven `mesh_file_*` tools** |
| `MESHRIGHT_NOAMT` | `0x800` | blocks Intel AMT |
| `MESHRIGHT_NODESKTOP` | `0x10000` | blocks desktop |
| `MESHRIGHT_NOREGISTRY` | `0x400000` | blocks the registry relay (`p=4`) |
| `MESHRIGHT_NOSOFTWARE` | `0x800000` | blocks the software-inventory relay (`p=6`) |
| `MESHRIGHT_LIMITEVENTS` | `0x2000` | the account sees only its own events |
| `MESHRIGHT_RESETOFF` | `0x40000` | blocks reset/power-off |

Suggested starting bitmasks:

- **Read-only inventory bot:** `MESHRIGHT_DEVICEDETAILS | MESHRIGHT_LIMITEVENTS | MESHRIGHT_NOTERMINAL | MESHRIGHT_NOFILES | MESHRIGHT_NODESKTOP | MESHRIGHT_NOAMT | MESHRIGHT_NOREGISTRY | MESHRIGHT_RESETOFF` = `0x552E00` (the negative rights are belt-and-braces here: without `MESHRIGHT_REMOTECONTROL` the relays are unreachable anyway, but they keep the mask correct if remote control is later added)
- **Support bot (read + scripted remediation, no file transfer):** add `MESHRIGHT_REMOTECONTROL | MESHRIGHT_REMOTECOMMAND | MESHRIGHT_SETNOTES | MESHRIGHT_WAKEDEVICE`, keep `NOFILES`/`NODESKTOP`.

Verify each mask against a throwaway device group before rolling it out; the bitmask is
the boundary, so it deserves a test.

### 3.2 Device-group consent flags

For the groups the agent can reach, enable the "prompt user" consent flags on
terminal/desktop/file sessions. This puts a human on the endpoint in the loop for
interactive sessions. Note the caveat from §1: it does **not** cover `runcommands`, so
consent flags complement but do not replace withholding `MESHRIGHT_REMOTECOMMAND`.

### 3.3 Login tokens instead of a password — and a bug to fix

MeshCentral supports login tokens (`createLoginToken` in `meshuser.js`): a
`tokenUser` / `tokenPass` pair with an optional expiry, which can be revoked without
touching the account password. This is the right credential for an MCP service account.

**The current `MESH_TOKEN` plumbing does not work.** `src/index.js` does:

```js
username: MESH_USERNAME || 'token',
password: MESH_TOKEN || MESH_PASSWORD,
```

A MeshCentral login token is a *pair*; the literal string `'token'` is not a valid
username, and a `tokenPass` alone will not authenticate. Fix this as part of the work:
introduce `MESH_TOKEN_USER` / `MESH_TOKEN_PASS` (the values returned by
`createLoginToken`) and pass them as the `x-meshauth` username/password, deprecating the
single `MESH_TOKEN` variable. Also set a non-zero `expire` so a leaked token dies on its own.

---

## 4. Layer 1 — Capability tiers and the policy engine

### 4.1 Tier classification (all 58 tools)

| Tier | Meaning | Tools |
|---|---|---|
| **R** — read / inventory | No change to any system | `mesh_server_info`, `mesh_server_version`, `mesh_server_stats`, `mesh_server_errors`, `mesh_traffic_stats`, `mesh_list_groups`, `mesh_list_devices`, `mesh_get_device`, `mesh_get_device_info`, `mesh_get_sysinfo`, `mesh_get_network_info`, `mesh_get_power_timeline`, `mesh_get_lastconnects`, `mesh_list_processes`, `mesh_list_software`, `mesh_list_users`, `mesh_list_user_groups`, `mesh_get_events`, `mesh_get_notes`, `mesh_file_list`, `mesh_file_find`, `mesh_scan_amt` |
| **RF** — remote data read | Exfiltration risk | `mesh_file_read`, `mesh_file_download`, `mesh_get_clipboard` |
| **W** — low-impact write | Reversible, metadata-level | `mesh_set_notes`, `mesh_send_toast`, `mesh_set_clipboard`, `mesh_edit_device`, `mesh_wake_devices` |
| **X** — remote code execution | Endpoint compromise potential | `mesh_run_command`, `mesh_agent_console`, `mesh_kill_process` |
| **WF** — remote file write | Destruction / persistence | `mesh_file_write`, `mesh_file_upload`, `mesh_file_delete`, `mesh_file_mkdir`, `mesh_file_rename`, `mesh_file_copy`, `mesh_file_move` |
| **P** — disruptive / agent lifecycle | Service impact, loss of management | `mesh_power_action`, `mesh_uninstall_agent`, `mesh_distribute_core`, `mesh_update_agents` |
| **A** — estate / IAM administration | Privilege escalation, persistence | `mesh_create_group`, `mesh_delete_group`, `mesh_edit_group`, `mesh_remove_device`, `mesh_change_device_group`, `mesh_create_user`, `mesh_delete_user`, `mesh_create_user_group`, `mesh_delete_user_group`, `mesh_add_user_to_group`, `mesh_remove_user_from_group`, `mesh_add_device_user`, `mesh_create_invite_link`, `mesh_server_console` |

`mesh_scan_amt` is classed R but is network-active; sites that care about scan traffic
should move it to W in their own policy.

### 4.2 Built-in profiles

| Profile | Tiers registered | Confirmation |
|---|---|---|
| `readonly` **(new default)** | R | — |
| `support` | R, RF, W, X | X confirmed |
| `operations` | R, RF, W, X, WF, P | X, WF, P confirmed |
| `admin` | all | X, WF, P, A confirmed |
| `custom` | whatever the policy file lists | per rule |

Changing the default to `readonly` is the single most important change in this document:
it is what turns "the agent is given a lot by default" into "the agent is given nothing
dangerous by default".

### 4.3 Policy file

Loaded from `MESH_POLICY_FILE` (default `./mesh-policy.json`), overridable in part by env
vars for container deployments. Deny always beats allow.

```jsonc
{
  "profile": "support",
  "tools": {
    "allow": ["mesh_file_read"],            // additions on top of the profile
    "deny":  ["mesh_server_console", "mesh_distribute_core"]
  },
  "targets": {
    "groups":    { "allow": ["mesh//Workstations"], "deny": ["mesh//Domain Controllers"] },
    "nodes":     { "deny": ["node//abc123..."] },
    "tags":      { "deny": ["production", "pci"] },
    "max_devices_per_call": 5
  },
  "run_command": {
    "deny_types": [4],                       // no agent console
    "allow_run_as_user": [0, 1, 2],
    "max_length": 2000,
    "deny_patterns": [
      "(?i)\\b(format|mkfs|diskpart)\\b",
      "(?i)Remove-Item\\s+.*-Recurse",
      "(?i)\\b(vssadmin|bcdedit|cipher\\s+/w)\\b",
      "(?i)(Invoke-Expression|IEX|curl\\s+.*\\|\\s*(ba)?sh|Invoke-WebRequest.*\\|)",
      "(?i)\\bnet\\s+(user|localgroup)\\b"
    ],
    "allow_patterns": []                     // if non-empty, acts as a strict allow-list
  },
  "files": {
    "remote": {
      "read_deny":  ["**/.ssh/**", "/etc/shadow", "**/NTDS/**", "**/*.pfx", "**/*.kdbx"],
      "write_allow": ["C:/ProgramData/Support/**", "/opt/support/**"],
      "write_deny":  ["C:/Windows/**", "/etc/**", "/usr/**", "/boot/**"],
      "max_read_bytes": 10485760
    },
    "local": {
      "root": "./mcp-files",                 // jail for local_path on download/upload
      "max_write_bytes": 52428800
    }
  },
  "server_console": { "allow": ["help", "dbstats", "agentstats", "heap", "certexpire", "usersessions", "args"] },
  "confirm": { "mode": "elicit", "tiers": ["X", "WF", "P", "A"], "ttl_seconds": 120 },
  "limits": { "writes_per_minute": 10, "exec_per_minute": 5, "devices_per_session": 25 },
  "audit": { "file": "./audit.jsonl", "include_args": true, "redact": ["password", "tokenPass"] },
  "dry_run": false
}
```

Env overrides for simple deployments: `MESH_PROFILE`, `MESH_DRY_RUN`, `MESH_AUDIT_FILE`,
`MESH_LOCAL_FILE_ROOT`, `MESH_DISABLED`.

### 4.4 Registration-time gating

Replace the 58 bare `server.tool(...)` calls with a single wrapper:

```js
// src/register.js
export function defineTool(server, policy, spec) {
  // spec: { name, tier, description, schema, handler, guards: [] }
  if (!policy.allowsTool(spec.name)) return;              // never registered
  const description = policy.annotate(spec);              // appends the active limits
  server.tool(spec.name, description, spec.schema, async (args, extra) => {
    const decision = await policy.check(spec, args, extra);
    if (decision.denied)  return errorResult(decision.reason);
    if (decision.needsConfirmation) return await confirm(decision, spec, args, extra);
    if (policy.dryRun && spec.tier !== 'R') return dryRunResult(spec, args);
    const result = await spec.handler(args, extra);
    audit.record(spec, args, decision, result);
    return policy.wrapUntrusted(spec, result);
  });
}
```

This keeps the 58 handler bodies untouched — only their registration changes — so the
diff stays mechanical and reviewable.

---

## 5. Layer 2 — Argument-level guards

Tool-level gating is too coarse on its own: `mesh_run_command` is either off or it is
arbitrary SYSTEM-level RCE. Guards run after tool admission, on the resolved arguments.

- **Target scoping.** Resolve `node_id` → node → `meshid` (a cached `nodes` response,
  refreshed on TTL and on cache miss), then match against the `targets` allow/deny lists
  by group, node, tag and OS. Reject calls whose `nodeids` array exceeds
  `max_devices_per_call` — a blast-radius cap.
- **Command policy.** Length cap, denied command types (type `4` = agent console),
  denied patterns, and an optional strict allow-list for locked-down sites. Patterns are
  a speed bump against obviously destructive commands, not a shell-escaping sandbox —
  document them as such and do not let them substitute for withholding
  `MESHRIGHT_REMOTECOMMAND` where RCE is not wanted.
- **Remote path policy.** Glob allow/deny on `remote_path` / `remote_dir` for all eleven
  `mesh_file_*` tools, separate read and write lists, plus `max_read_bytes`. Normalise
  separators and reject `..` traversal before matching.
- **Local path jail.** `mesh_file_download.local_path` and `mesh_file_upload.local_path`
  must resolve inside `files.local.root` after `fs.realpathSync` — closing the "agent
  writes to its own `.env`, or to `~/.ssh/authorized_keys`" hole flagged in §1.
- **Server console allow-list.** `mesh_server_console` accepts only the listed
  diagnostic commands; anything else is denied with the allow-list echoed back.
- **Self-protection.** Deny any IAM call whose target is the MCP's own account, and any
  `mesh_edit_group` that would widen the account's own rights.

---

## 6. Layer 3 — Confirmation and the human in the loop

Three mechanisms, in descending order of actual strength:

1. **The host client's own permission prompt** (Claude Code / Claude Desktop asking the
   user to approve a tool call). This is already the strongest control available and it
   is free — but only if the dangerous tools are *rare*, so the user reads the prompt
   instead of click-fatiguing through it. Layers 1 and 2 exist largely to keep this
   prompt meaningful.
2. **MCP elicitation** (`server.server.elicitInput`). The lockfile already resolves
   `@modelcontextprotocol/sdk` to 1.30.0, which supports it. Use it for tiers in
   `confirm.tiers`, presenting a rendered summary: tool, resolved device name, group,
   and the exact command or path. Client support for elicitation varies, so detect
   capability at handshake and fall back to (3).
3. **Confirm token.** First call returns `{ status: "confirmation_required", token,
   summary }`; the caller must re-invoke with `confirm_token`. Tokens are single-use,
   TTL-bound, and keyed to a hash of `(tool, normalised args)` so a token issued for one
   command cannot approve another. **State plainly in the docs that this stops accidents,
   not adversaries** — the model can echo the token back to itself. Its real value is
   that it forces the destructive action into a second, separately-auditable turn.

---

## 7. Layer 4 — Audit, limits and the off switch

- **Audit log.** JSONL to `audit.file`, one record per attempt: timestamp, tool, tier,
  resolved target (node id, name, group), decision (`allow` / `deny` / `confirm`), the
  matching policy rule, redacted arguments, outcome and duration. Because it records
  *denials* too, it doubles as the detection signal for a prompt-injected agent probing
  its boundaries.
- **Rate limits.** Token buckets for `writes_per_minute` and `exec_per_minute`, plus a
  per-session distinct-device cap. A legitimate support session touches a handful of
  machines; a runaway one touches hundreds.
- **Dry run.** `dry_run: true` makes every non-R tool return the payload it *would* have
  sent. This is the right mode for demos, evaluation and first rollout.
- **Kill switch.** `MESH_DISABLED=true` degrades to R-only; `SIGHUP` reloads the policy
  file without restarting, so a policy can be tightened mid-incident.

---

## 8. Treating tool output as untrusted

Device-sourced content (`mesh_file_read`, `mesh_get_notes`, `mesh_get_clipboard`,
`mesh_list_processes`, `mesh_get_events`, command stdout) is attacker-controllable.
`policy.wrapUntrusted` should:

- fence the payload in an explicit `<untrusted_device_output device="…">` delimiter with
  a one-line note that its contents are data, not instructions;
- strip ANSI escape sequences and control characters;
- truncate to a configured maximum with an explicit truncation marker.

This does not make injection impossible; it removes the easy version of it and it makes
the boundary visible in the transcript.

---

## 9. Implementation phases

| Phase | Work | Value |
|---|---|---|
| **1 — Server-side hardening** *(no code)* | `mcp-bot` account, per-group bitmasks, consent flags, login token | Largest single risk reduction; survives MCP compromise |
| **2 — Tiers + profiles + registration gating** | `src/policy/profiles.js`, `src/policy/index.js`, `src/register.js`; rewrite the 58 registrations; default `readonly` | Flips the default; removes dangerous tools from the model's view entirely |
| **3 — Argument guards** | `src/policy/targets.js`, `paths.js`, command policy, **local path jail**, `MESH_TOKEN` fix | Makes `support`/`operations` safe to actually enable |
| **4 — Confirmation** | `src/policy/confirm.js`, elicitation with token fallback | Human in the loop where it counts |
| **5 — Audit, limits, dry run, kill switch** | `src/audit.js`, limiter, `SIGHUP` reload | Detection, blast-radius caps, safe rollout |
| **6 — Untrusted output wrapping + docs** | `wrapUntrusted`, README rewrite, example policies per profile | Injection hardening; makes the model honest about its own limits |

Phases 1 and 2 are independently useful and should ship first. Phase 3's local path jail
and `MESH_TOKEN` fix are bug fixes on top of the design and should not wait for the rest
of the phase.

Testing: unit tests per guard (path globbing, command patterns, target resolution, token
lifecycle), plus a table-driven test asserting the exact registered tool set for each
built-in profile — that test is the regression guard for "a new tool silently arrives in
`readonly`". A new tool with no tier assignment should fail the build rather than default
to permitted.

---

## 10. Decisions needed

1. **Default profile** — this document proposes `readonly`. Confirm, or pick `support`
   if the agent's day-one job is remediation rather than inventory.
2. **Is remote code execution in scope at all?** If the agent never needs to run
   commands, withholding `MESHRIGHT_REMOTECOMMAND` on the service account is a far
   stronger control than any pattern list, and most of §5's command policy becomes
   belt-and-braces.
3. **One profile or several deployments?** A single `mcp-bot` shared by every agent
   session cannot be scoped per task. Separate MeshCentral accounts + separate MCP
   server entries (`meshcentral-readonly`, `meshcentral-support`) give per-session least
   privilege at the cost of more configuration.
4. **Confirmation mechanism** — elicitation only (strong, but client-dependent), token
   fallback (universal, weak), or rely on the host client's own tool-permission prompts.
5. **Policy distribution** — file on disk, or fetched from MeshCentral (e.g. encoded in
   the service account's device-group memberships) so policy and rights cannot drift apart.
