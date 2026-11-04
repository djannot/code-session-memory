# Deferred ideas

Ideas surfaced while working on the codebase but deliberately not implemented yet.

## Hook runtime under GUI-launched apps (2026-09-16)

Implemented: absolute `node` path in every hook/MCP command, an env snapshot at
`~/.config/code-session-memory/env.json`, a login-shell fallback, and a hook log.
Deferred from that work:

- **Windows environment fallback.** The login-shell probe is POSIX-only
  (`$SHELL -lic`). A Windows user who installs from a shell without
  `OPENAI_API_KEY` gets a clear error and must run `config set-env`. A PowerShell
  profile probe (`powershell -NoProfile -Command`… reading the user profile)
  would close that gap.
- **Runtime health in the web UI.** `src/status.ts` (used by `code-session-memory
  web`) does not expose the node-path / env-snapshot / hook-log checks that the
  CLI `status` command now prints. The web dashboard should show the same
  "Runtime" section.
- **Self-healing node path.** If the recorded node binary disappears (nvm/fnm
  version removed), `status` reports it but nothing repairs it. A tiny launcher
  script owned by us (`csm-hook.sh` / `.cmd`) could fall back to a PATH lookup
  and to common install locations, at the cost of one more indirection.
- **Keychain instead of a file.** The env snapshot stores the API key in a 0600
  file. Using the OS keychain (Keychain Access / Credential Manager /
  libsecret) would avoid the plaintext copy, but adds a native dependency and a
  per-platform code path.
- **Automatic re-install on package upgrade.** Hook commands embed absolute paths
  into the installed package directory, so an `npx`-cached upgrade can leave
  stale paths. A postinstall check could detect and rewrite them.

## Antigravity 2.x support (2026-11-04)

Implemented: `antigravity` source, JSONL transcript parser, `Stop` lifecycle
hook, MCP entry in `~/.gemini/config/mcp_config.json`, skill, status and
uninstall. Deferred from that work:

- **Better session titles.** `~/.gemini/<surface>/antigravity/conversation_summaries.db`
  holds an Antigravity-generated `title` per conversation (plus an FTS index over
  `user_body` / `agent_body`). We derive the title from the first user prompt
  instead, to avoid reading another product's live SQLite file (WAL) from a hook.
  Reading it opportunistically, read-only, would give nicer titles.
- **A real model name.** The hook payload's `modelName` is often `"auto"` rather
  than the model that actually served the turn, and the transcript does not carry
  the resolved name — only a `<USER_SETTINGS_CHANGE>` note in the first user step
  when the user picks one by hand. Per-model analytics for Antigravity are
  therefore only as good as that field, and a web-UI re-index drops it entirely
  (the transcript has no model at all).
- **Backfilling existing conversations.** `BACKFILL_SOURCES` still covers only
  claude-code, opencode and codex. Antigravity transcripts are discoverable by
  conversation id, so `backfill-analytics` could include them.
- **Indexing conversations that predate the install.** Only turns that end after
  the hook is installed are indexed. A one-off import walking
  `~/.gemini/<surface>/brain/*/` would pick up the existing history.
- **The two older surfaces.** The installer writes one global `hooks.json` that
  all three surfaces read, but only the 2.x app was exercised end to end; the IDE
  (`antigravity-ide`) and CLI (`antigravity-cli`) are covered by path handling
  and unit tests only.
