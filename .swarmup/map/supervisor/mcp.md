---
kind: flow
summary: MCP servers on roles (W8); server config, secrets.yml, the run grant, the mcp exec proxy and resolve route
covers:
  - packages/core/src/mcp.ts
  - packages/supervisor/src/mcp-api.ts
  - packages/cli/src/mcp-cmd.ts
  - packages/desktop/ui/src/ui/mcp.tsx
links: [prompts, index, /core/defs, /desktop/ui, /cli]
---

# MCP servers

## Purpose

Gives a run the MCP servers its role file names (`mcp`) that this machine defines and grants,
without a secret ever being an argument, in the run record or in an API answer to a person.

## How it works

- `core/mcp.ts`: `checkMcpConfig` reads `swarmupd.mcp` (`strict`, `servers.<name>` with
  `command`, `args`, `env` with `{secret: NAME}`, `roots`, `agents`, `tools.allow/deny`,
  `publish`). `mcpGrant` intersects a role's names with the defined servers, scoped by root and
  agent; `publish` servers are never granted. `secrets.yml` sits next to the user config
  (`readSecrets`, `setSecret` writes mode 600, `secretsExposure` for doctor).
- `mcp-api.ts`: `prepareMcpRun` (called by `launch`) records the grant, writes
  `mcp-token.json` (run token, state folder) and, for Claude, `mcp.json` into the scratch folder,
  and returns the runtime's part for `invocation` plus the prompt note for missing servers.
  `resolveMcp` serves `POST /api/mcp/resolve` to a run token only, for a server it was granted
  that the machine still grants. `mcpView`, `saveMcpServer`, `deleteMcpServer`, `setMcpSecret`
  and `setMcpStrict` serve **Settings**; they return secret names, never values.
- `runtimes.ts` (see `prompts`): Claude gets `--mcp-config <file> --strict-mcp-config` and
  `mcp__<name>`; Codex gets `-c mcp_servers.<name>.*` with TOML literal strings.
- `cli/mcp-cmd.ts`: `swarmup mcp exec NAME --run-dir DIR` fetches the spec, starts the server
  with the secrets in its environment only (no run token), and `McpFilter` filters `tools/list`
  and refuses denied `tools/call`, logging tool names and argument hashes to `mcp.log`.
- `ui/mcp.tsx`: **Settings > MCP servers**.

## Invariants

- No secret in arguments, the run record, prompts or person-facing API answers.
- The judge gets no MCP server.
- Validate and doctor warn about role `mcp` names the machine does not define.

## Gotchas

- Codex still loads servers from the person's own `~/.codex/config.toml`; `strict` covers Claude
  only.
