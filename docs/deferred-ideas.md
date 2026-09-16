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
