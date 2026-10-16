# Changelog

## Unreleased

- Releases: pushing a `vX.Y.Z` tag publishes a GitHub release with that version's section of this changelog as its notes (`.github/workflows/release.yml`). 0.2.0 and 0.3.0 have releases too.

## 0.3.0 (2026-10-16)

- A config file cut off by a crash no longer stops the server for good. An unreadable `push.json` starts with no subscriptions (phones that chose *on* subscribe again on their next check). Unreadable VAPID keys are replaced, and their subscriptions dropped. An empty `bridge-token` gets a new token instead of refusing every omp session. The server writes these files through a temporary file and a rename, mode 600.
- A slow or hanging `TERN_AWUI_PROJECTS` command no longer freezes the server (streams, bridges, every request) while it runs: it runs in the background and is killed after 5 s, which lists no folders. The `omp config` reads behind the model picker's roles and the context gauge's compaction tick no longer block the server either (about 0.4 s every 5 minutes before).
- `bun install.ts --uninstall` keeps an extension link that points to another checkout instead of deleting it.
- Commands sent to an omp whose bridge connection closes (a `/restart`, say) fail at once instead of after the 2 s reply deadline.
- Leaving a session with images still attached frees their previews.
- The Linux systemd unit is now `tern-awui.service`, matching the macOS launchd label and the Windows task. `bun install.ts` stops, disables and removes the old `tern-mobile.service` before starting the new one; `--uninstall` removes either. The config folder, extension file and headers keep their `tern-mobile` names.
- Stretchtext replies: a reply holding `{{short|long}}` markup (from an omp stretchtext extension, `stretch.ts`) shows its short forms as links; a tap grows the long form in place and `«` closes it. Live text shows the short forms, btw answers the long forms. When the pane's omp runs stretch.ts, phone and desktop share what is open: a tap opens it in the Tern pane too (and counts for the model's read note), and a phrase opened on the desktop opens on the phone. The extension reports the open stretches in its snapshot and applies a new `stretch` bridge message; restart omp sessions to load it.
- Desktop sidebar minimizes to a 56 px rail: hover the "tern" brand in the list header and it turns into `«` in the same box (one click minimizes), or press Ctrl+\ (⌘\ on macOS); `»` expands it again, and the choice is remembered on the device. The rail keeps a button per session (its title icon, else its tag, else the title's first two letters), ringed green while working and red while blocked, with the unseen dot, an accent bar on the open one and the row's text as a tooltip. Project labels collapse and expand their groups; the connection dot, blocked count, bell and `+` (new omp) stay. Phones are unchanged.
- The list header's counts are a status dot and a number each (the rows' red diamond for blocked, green dot for working, grey ring for idle); hovering one shows "N working" etc. The header fits on one line in the desktop sidebar again.
- The hide-old-sessions toggle is an eye instead of a clock. While it hides sessions it is lit, with the hidden count next to the eye instead of a corner badge.
- Image previews in the chat show the whole image at its own aspect ratio (up to 180 px high and 480 px wide, never upscaled), as Tern does, instead of a 96 px square cropped from the middle. In prompts the images come before the text. A wide screenshot no longer looks like an unrelated sliver, which made a prompt's image and a tool's screenshot look like the same image twice.
- **Subagents (N)** under a session's transcript shows only while a subagent runs; once all have finished it goes away with them.
- A subagent's prompts (task briefs and session updates written by its parent agent) render as Markdown with every stretch drawn open, not as raw text with `###`, `**` and `{{…|…}}` showing.
- omp's idle recaps show in the session's chat too, not only on its list row: each one as an italic `※` line where the terminal prints it, after the turn it sums up and before the next prompt. All of a session's recaps come from `history.db` and merge into the chat by time; a recap written while the session sits idle reaches an open chat without a transcript change.
- CI fixes: the sanitizer binds to the current window (a test file loading it under another file's DOM left it sanitizing nothing, depending on file order); path expectations use the OS separator; installer `main()` tests, which run shell-script fakes, skip on Windows; the cold-start PowerShell test gets 30 s.
- README security section: never expose the app publicly; Tailscale is the recommended setup. Other private setups are described with their requirements: an authenticating proxy (such as Cloudflare Access) must set an allowed `Tailscale-User-Login` itself, overwriting the client's, and `TERN_AWUI_DEV=1` is for loopback-only use.
- README screenshots show Opus 5.5.
- `bun run assets` and `bun docs/screenshots.ts` run `optipng` when it is installed (about 25% smaller PNGs, pixel-identical).
- README install: a copy-paste prompt to have a coding agent do the install, with the manual steps as fallback.
- README/docs: macOS is tested (install, launchd service, `tailscale serve`, omp extension on macOS 26, Apple Silicon).
- Attach button in the composer of omp sessions: it opens the phone's picker (camera, photos, files) and adds the chosen images to the same tray as pasted ones (up to 8, large or unusual formats re-encoded to JPEG). Before this, images could only be pasted, since mobile browsers don't drag and drop.
- Notifications stay on more reliably. A device that turned them on re-registers with the server every time the app comes back to the foreground or the network returns, not only when the app loads. Before this, an app left open in the background stayed unregistered once the server had dropped its subscription. A failed recheck no longer shows the bell as off. The service worker also registers a subscription the browser replaced by itself (`pushsubscriptionchange`), even when the app is closed.

## 0.2.0 (2026-10-13)

- README links the companion CodexBar AgentView Tern extension.
- **Breaking:** environment variables are renamed from `TERN_MOBILE_*` to `TERN_AWUI_*` (`TERN_AWUI_PORT`, `TERN_AWUI_ALLOW`, `TERN_AWUI_CONFIG`, `TERN_AWUI_OMP_DIR`, `TERN_AWUI_NOTES_DIR`, `TERN_AWUI_PROJECTS`, `TERN_AWUI_VAPID_SUBJECT`, `TERN_AWUI_DEV`, `TERN_AWUI_BRIDGE`, `TERN_AWUI_TOKEN_FILE`, `TERN_AWUI_SYMBOLS_FONT`). Run `bun install.ts` again to rewrite the service with the new names. The config folder, service, extension file and headers keep their `tern-mobile` names.
- GitHub Actions CI: typecheck, the full suite with browser tests and the build on Linux; the platform-dependent suites on macOS and Windows (non-blocking for now).
- Untitled file blocks are named after their file with a Markdown, note or file icon, show their folder (named from the project) instead of the full path, and drop the shell status ring. Opened documents use page-sized headings.
- README rewritten for users: features, how it differs from and integrates with Tern, platforms, install including the omp extension. The technical reference moved to `docs/architecture.md`. README screenshots come from invented sessions (`bun docs/screenshots.ts`).
- Bare `/btw` now opens saved native omp btw history in a read-only web sheet rather than falling through to normal prompt submission. Questions, answers, statuses and follow-up turns come from the session's native history files; viewing history does not invoke a model. Existing transient web `/btw <question>` cards are unchanged.
- Interactive desktop `->`/`=>` queue commands now display as follow-ups with clean message text, matching explicit web follow-ups instead of showing a steer plus a literal prefix. Input delivery is unchanged; whitespace-prefixed, embedded and RPC arrows remain literal.
- Widened the desktop session content column to 1100 px, keeping the transcript, header, composer, extension notice and subagent list on the same width setting. Sidebar, desktop breakpoint and mobile layout are unchanged.
- Removed the table-cell width cap that squeezed descriptive tables to half the available desktop width. Prose columns now use the conversation width; mobile wrapping and local horizontal scrolling for wide tables remain intact, with browser regressions for both.
- The app icon (the "T" with a green dot) is now rendered from `assets/icon.svg` by `bun run assets`, with rounded-corner and maskable variants under versioned `icon-v2-*` names so installed apps pick it up.
- Assistant Markdown screenshots with absolute local paths now render through the authenticated blob API, including reference-style images. Supported raster files are validated and cached within bounded memory; evicted bytes reload only from previously indexed, unchanged files with the same hash. Original Markdown, ordinary links and code remain unchanged.
- Added real-browser regressions for inline assistant screenshots and the 393×852 mobile layout, including long links and horizontally scrolling code without page-wide clipping.
- API commands reject malformed JSON and report explicit extension failures instead of submitting rejected drafts or caching failed model catalogs. Terminal edits erase the full requested text in bounded key batches; ask choices reject fractional indices.
- Bridge ownership/session changes clear old streamed output and notification state. Closing the last pane clears its badge; stale push failures cannot delete a replacement subscription. Transcript replacements and permission recovery refresh open views, and unavailable transcripts no longer break the whole session list.
- Project discovery retries incomplete transcript headers, refreshes cached repository roots, and excludes non-directories from configured project lists.
- Fixed prompt loss when typing the next draft during a pending submission, duplicate ask answers, stale live text after SSE reconnect, stuck new-session controls after network errors, and delayed close responses navigating away from another session.
- Queued skill and image markers now use the bundled symbols font. Chart currency parsing handles `k`/`M` suffixes correctly, and malformed saved model/project preferences no longer crash the picker or corrupt collapsed groups.
- Transcript readers detect file replacement and same-size rewrites, preserve complete rows at tail boundaries, and return independent snapshots for concurrent readers. An explicit rewind leaf outside the bounded tail no longer displays an abandoned branch.
- Extension session changes clear old queued prompts, blocked state, jobs, context and completions. Stale completion results and side-turn output cannot leak into a replacement session; asynchronous command errors return replies. Context token/window changes refresh even when their percentage stays unchanged.
- The installer writes local bridge discovery settings so independently started omp sessions find custom ports and config directories, resolves relative data paths, and explicitly disables development-mode auth bypass in installed services. Uninstall continues when optional commands are unavailable and preserves unrelated discovery settings. Corrected systemd executable quoting for dollar signs.
- Builds prepare replacement assets before removing the previous `dist/`, preserving the working bundle when compilation or asset copying fails.
- Added persistent Chromium browser tests for phone and desktop navigation, draft syncing and submission, asks, model selection, rewind, streaming replies and read-only subagents. They build and run against temporary files and fake Tern/omp processes, without using the live service.
- Server integration tests now run through an isolated `startServer()` instance, making server coverage measurable. Shutdown closes owned resources and prevents late stream initialization or push failures from modifying a stopped instance.
- Split the web entry into importable components and hooks, with behavioral tests for composer races, image uploads, chat rendering, project filters, model selection, SSE lifecycle and notification preferences.
- Added installer execution tests for install, uninstall, dry runs, environment overrides and command failures using temporary directories and fake commands.
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
