# Changelog

## Unreleased

- Pairing is removed: no access token, no `tern_awui` cookie, no `/pair` route (now just an unknown path that falls to the app's index), no `bun server.ts pair`, no "Not paired" screen, and the installer prints the plain app URL `https://<tailnet name>:<port>/`. The protection is the server listening on `127.0.0.1` only, reached through `tailscale serve` (tailnet only, never Funnel), with every request carrying an allowed `Tailscale-User-Login` (`TERN_MOBILE_ALLOW`). An existing `access-token` file in the config dir is left in place, unused.
- Subagents are viewable, read-only: tapping a running subagent in a session's `⑂` strip opens its chat, and **Subagents (N)** lists all of them, finished ones too, with their result and age. A subagent's chat uses the session's chat renderer without composer, prompt actions or answerable questions, shows the text it yields as its final reply, and updates while it runs. Routes `#/b/<block>/sub` and `#/b/<block>/sub/<name>`; ‹ returns to the screen it was opened from. Server: `GET /api/blocks/<id>/subagents`, and `/api/stream` with `view=subagents` or `sub=<name>`; names are validated strictly (no paths, no advisor transcripts, no symlinks).
- Windows install/uninstall no longer kill whatever owns the port: they stop only tern-awui's own processes, bun running our `server.ts` and wscript/cscript running our launcher `.vbs` (never the helper itself or, say, an editor open on `server.ts`). If another program holds the port, install fails with a conflict message; uninstall leaves it alone.
- The app says when omp's extension doesn't match the server, and how to fix it. A banner tops the session list when `<omp dir>/extensions/tern-mobile.ts` is missing, a stale copy or a link to another checkout, with the command to copy (`cd <checkout> && bun install.ts`, PowerShell form on Windows). The extension now reports its build (a sha256 prefix of the file omp loaded) with bridge protocol 2; a session that loaded an older build or protocol gets a notice under its header, a `!` on its row and a count in the list header. Its fix is **Reload** (omp's `/restart`: restarts omp in the pane and resumes the session; offered while idle, after a confirm, when that omp has it), else `omp --resume <id>` after quitting. A newer extension than the server asks for `git pull && bun install.ts`. This replaces the "extension outdated" line. Server: `state.extension` (install status, path, link target, checkout, Windows) and per session `live.build`, `live.mismatch` (`older`/`newer`/null) and `live.restart`.

## 0.1.0 (2026-10-11)

First release. tern-awui is a phone-sized web app (PWA) for the Tern panes on one machine, served over Tailscale.

### App

- Session list grouped by git root or folder, newest activity first: live status (working, blocked, idle), the title's Nerd Font icon, omp's recap or the last prompt, time in status. Projects fold; sessions idle for over a day can be hidden.
- Chat for omp agents laid out like Tern's: prompts, markdown replies, grouped tool lines with intents, per-turn footers, tables with bar charts, inline SVG and mermaid figures, advisor notes, todo lists, images and image paste, live text while the agent writes, queued steers and follow-ups, subagents and background jobs.
- Control: send, steer, follow-up, stop, `/btw` side questions, answering `ask` dialogs, rewinding to before a prompt, omp's own command and file autocomplete, the key bar, and a model picker with effort and priority tiers.
- Screen capture for terminals with live typing on the shell's line; read-only notes and files; new omp tabs in any project; closing blocks; the git branch and the context-window gauge in the session.
- Web Push notifications for sessions that need you or finished, an unseen-updates badge and haptics.
- Desktop browser layout at 1000 px and wider.
- Updates over one SSE stream per screen, open only while the app is visible.

### omp extension

- `omp-extension/tern-mobile.ts` bridges each omp in a Tern pane to the server over a local WebSocket: draft mirroring, status, model, thinking and tier, context usage, live text, queue, session leaf, jobs, rewind and autocomplete.
- Capabilities and protocol: the extension reports its bridge protocol version and the features it detects in the running omp (model list, service tiers, jobs, queue, rewind, `/btw`, autocomplete, thinking levels). The server refuses and the phone turns off what that omp lacks, and the phone flags an extension older than its protocol so the omp gets restarted. Extensions from before versioning keep working as before.

### Security

- Pairing (removed again in Unreleased): besides an allowed Tailscale login, every `/api` request and stream needed the `tern_awui` cookie set by a one-time visit to `/pair?code=<access token>`.
- `TERN_MOBILE_DEV=1` still turns off all auth and is documented as unsafe.

### Install and build

- `install.ts` (`bun run install-service`): builds, installs the omp extension (symlink on Linux/macOS, copy on Windows), reads the allowed login and DNS name from Tailscale, writes and starts a per-user service (systemd user unit on Linux, LaunchAgent on macOS, a logon scheduled task on Windows), runs `tailscale serve` and prints the app's URL (0.1.0 printed a pairing link). `--dry-run` prints the plan, `--uninstall` reverses it.
- Cross-platform paths: the config dir is `~/.config/tern-mobile` on every OS (`TERN_MOBILE_CONFIG`), found via the OS home directory rather than `$HOME`; omp's data dir follows omp's own resolution (`TERN_MOBILE_OMP_DIR`); Tern's notes dir is per OS (`TERN_MOBILE_NOTES_DIR`); the **+ omp** project list defaults to the open blocks' and sessions' folders (`TERN_MOBILE_PROJECTS`); the VAPID subject defaults to the first allowed login.
- The icon PNGs and the Nerd Font symbols subset are committed in `assets/` (with the Nerd Fonts license), so `bun run build` needs only Bun; `bun run assets` regenerates them with `rsvg-convert` and `pyftsubset`.
- The hardcoded `tern-mobile.service` is gone from the repo; the installer writes the unit.

### Tests

- `bun test` covers the server (HTTP API, auth, bridge, SSE) against fixtures, the omp extension against a fake omp, the web client's logic and components under happy-dom, the pure modules in `lib/`, and the installer's plans for Linux, macOS and Windows.
