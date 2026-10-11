# tern-awui (another web UI for Tern)

A phone-sized web app (PWA) for the Tern panes on one machine: the agents grouped by project, each one's chat, its screen, and two-way control, reached over your tailnet. It's meant as a stopgap until the official Tern mobile client ships.

After installing (see Install), open the pairing link the installer prints on each device. In Chrome on Android, use ⋮ → *Add to Home screen* to install it as an app.

## What it shows

Paths below use `<omp dir>` for omp's data folder (`~/.omp/agent` by default; `TERN_MOBILE_OMP_DIR`), `<notes dir>` for Tern's notes (`~/.local/state/tern/notes` on Linux; `TERN_MOBILE_NOTES_DIR`) and `<config dir>` for tern-mobile's own files (`~/.config/tern-mobile` on every OS; `TERN_MOBILE_CONFIG`); [Configuration](#configuration) has the defaults per OS.

- **List**: every Tern block, grouped by the git root (or folder) of its cwd, newest activity first within and between groups. A row shows the status (working: pulsing green, blocked: red diamond and tinted row, idle: ring), the title's Nerd Font icon (served as a PUA-only subset of `SymbolsNerdFont-Regular.ttf`), the `TAG:` prefix, a second line and the time in that status. The second line is omp's own recap for idle agents (the newest row of `session_recaps` in `<omp dir>/history.db`; italic, up to 2 lines, prefixed "Earlier:" when turns followed it), else the last prompt (scanned incrementally from the transcript). An omp session is known through its bridge connection, which reports its session id and its status live: *blocked* while an `ask` dialog or a tool approval waits, else *working*/*idle*; an idle session's time counts from its last transcript entry. Blocks without a bridged omp (shells, other agents) are terminals.
- **Collapsing projects**: tapping a project header folds its sessions away (▸/▾); the folded set is kept per device in `localStorage` (`tern-mobile:collapsed-projects`). A folded header still shows "N active" for its working or blocked sessions, and a filter shows matches inside folded projects too.
- **Hiding old sessions**: a clock button in the list header hides sessions whose time in their status is over a day (slashed while on, with the hidden count); kept per device in `localStorage` (`tern-mobile:hide-old`). Working, blocked, unseen and the open session always stay, as do blocks without a time (shells, notes), and a filter searches the hidden ones too.
- **Chat** (omp agents): the transcript tail from `<omp dir>/sessions/*/*_<id>.jsonl`, laid out like Tern's: prompts with an accent rail and `›`, assistant markdown full width, tool runs as one mono line (`▸ N tools · K failed  last intent`, tap to expand), and after each turn a right-aligned footer with duration, model and time that closes the turn. Body text is a step below white (bold stays white), with tight spacing inside a turn and extra space before each prompt. Each message hyphenates in its own language: `lang="hu"` when it contains ő/ű or more than 2 % accented vowels, else `lang="en"`. Tables are cards with row rules only, a small-caps header, faint zebra stripes and sideways scrolling; fenced code blocks are cards with their language in the corner. omp's figures render inline: ```` ```svg ```` blocks sanitized in place (with the `--fg`/`--accent`/`--c1`…`--c6` theme variables defined), ```` ```mermaid ```` blocks through mermaid (`securityLevel: strict`, dark theme), loaded as a separate chunk on first use; a diagram that fails to parse shows its source. Advisor notes (`custom_message` `advisor`) show as a card: severity and `Key` per note, tap for Evidence/Impact/Fix.
- **Prompt actions**: like omp in Tern, hovering a prompt (or tapping it on a phone) shows its time, **Copy** (the prompt text to the clipboard) and **Rewind**. Rewind, after a confirm and only while the session is idle, goes back to before that prompt and puts its text back in the composer: the server submits `/tern-mobile-rewind <entry id>`, a command the extension registers, because only command handlers may call `navigateTree`. The chat shows only the active path of the session tree, walked back by `parentId` from the leaf the bridge reports (a rewind moves it without writing the file), else from the file's last entry, so abandoned branches don't appear.
- **Questions**: an open `ask` is a card with the options, their descriptions, the recommended one, multi-select boxes and *Other…* with a text field. A single single-choice question sends on tap. The server replays omp's ask-dialog keyboard (recommended row start, ↑/↓, Space, Enter, the Other prompt, the Review tab), after checking that the ask is still open.
- **Images**: pasted images and images that tools read (screenshots) show as thumbnails under the prompt or tool line; tap opens them full screen. The transcript stores most as `blob:sha256:<hash>`, served by `/api/blob/<hash>?type=<mime>` from `<omp dir>/blobs/<hash>` (PNG/JPEG/WebP/GIF only); small ones sit inline and go to the page as `data:` URLs.
- **Pasting images**: an image pasted into the composer (omp sessions) shows as a preview with a × above the text, up to 8. PNG/JPEG/WebP/GIF under 3 MB go as they are; anything bigger or of another type is scaled to a 2048 px long edge and sent as JPEG. On send, the text and images reach omp as one user message through the bridge (`send` → `pi.sendUserMessage`: a new turn when idle, a steer while working), and the desktop draft is cleared. Shells and sessions without the bridge refuse images.
- **Screen**: omp agents: `tern capture --surfaces`, the last 160 lines of the main region (transcript text and progress; not overlay dialogs), reached through **Raw** at the start of the key bar (⌨); the button then reads **Chat** and switches back. Plain terminals: `tern capture --html`, one screen with colors, sanitized to `<pre>`/`<span style>`, polled every 450 ms; prompt glyphs come from the bundled symbols font. In terminals the composer types live onto the shell's own line (each edit becomes Backspaces plus new text, autocorrect off), the soft keyboard's Enter presses Enter, and the key bar is open by default, so interactive tools like `op`/fzf work: type to filter, ↑/↓, ⏎. Tab completion changes the line behind the composer; any key-bar key clears the composer.
- **Notes and files**: file blocks (`file` in `tern ls --json`) open read-only. Tern notes (`note:<id>`) are read from `<notes dir>/<id>.md` and rendered as markdown; other files (any absolute path) as text, first 512 KB.
- **New omp in any project**: **+ omp** in the header lists folders, filterable, with already-open ones marked and paths under the home folder shown as `~` (either separator); a tap opens an omp tab there and jumps into it. By default the folders are the cwds of the open Tern blocks, then those of past omp sessions (the `cwd` in each transcript's `session` header row), newest first, existing folders only; `TERN_MOBILE_PROJECTS` names a command whose output (one absolute folder per line) replaces that list.
- **Composer**: sends the prompt and Enter. ⌨ opens the key bar (Esc, ^C, arrows, Enter, Tab, ⇧Tab, Space). The model chip shows the model, effort and a non-standard tier; ⌖ focuses the block on the desktop, **+ omp** opens a new omp tab in the project.
- **Model picker** (tap the model chip): a bottom sheet on phones, a centered 560 px panel on desktop browsers. On top, **Effort** (the current model's thinking levels, from omp's `getSupportedThinkingLevels`) and **Priority** (its service tiers: Standard, Flex, Fast = `priority`; `pi.setServiceTier` for the model's family, session-only). Below a search field: the Ctrl+P roles first (`cycleOrder` → `modelRoles` from omp config, a pick applies the role's model and thinking), then the last 6 models picked on this device (`localStorage` `tern-mobile:recent-models`), then every chat model omp has credentials for (`modelRegistry.getAvailable("chat")`, ~1,700 here, cached 5 min by the server), folded by provider. A search matches every word against name and `provider/id`, the whole query in the name ranking first. Rows show the context window, $ per million in·out, reasoning and vision. The extension imports omp's `@oh-my-pi/pi-ai` shim with a literal specifier (omp's loader rewrites only literals; `omp-extension/pi-ai.d.ts` declares it for tsc).
- **Command hints**: while the text ends in a `/command`, `/skill:name` or `@path` token, the list above the composer shows omp's own autocomplete for it (built-in and extension commands, skills, prompt templates, files), with descriptions. A tap applies the suggestion in omp (`applyCompletion`), which also updates the desktop draft. Needs the bridge: the extension captures the editor's provider through `ctx.ui.addAutocompleteProvider` and answers `complete`/`apply` requests (`/api/blocks/<id>/complete`, `/completion`).
- **Context gauge**: like omp's own composer, the composer's top border is the context-window gauge of bridged omp sessions (`ctx.getContextUsage()`, sampled every 2 s by the extension): the used part in accent, the percent riding just past it, the window size at the right end; the percent turns red past 100 %. A tick marks where auto-compaction fires, computed by the server from `omp config` (`compaction.enabled`, `thresholdTokens`, `thresholdPercent`, `reserveTokens`, as omp's `resolveThresholdTokens` does; per-model thresholds are not read). The speculative-compaction marker is not drawn.
- **Stop**: while the agent works and the composer is empty, the send button turns into a stop square: `ctx.abort()` through the bridge (Escape without it). With text typed, it sends the text as a steer.
- **btw**: `/btw <question>` sent from the phone runs as an omp side turn (`ctx.runEphemeralTurn`, no tools, not added to the session's history); the answer streams into a card above the composer (`btw` SSE events), dismissed with ×. The desktop draft is cleared as for a sent prompt. One question at a time, no follow-up chain.
- **Git branch**: the session header shows the checked-out branch of the block's cwd (`git branch --show-current`, short sha when detached, cached 10 s per cwd); nothing outside a repo or for file blocks.
- **Badge and haptics**: the installed app's icon counts unseen updates: sessions that finished a turn or started waiting on you since the phone last opened them. Like Tern's tab icons, such a row's icon turns green (finished) or red (waiting on you) and its title goes bold; omp sessions without a title icon yet show Tern's `π` fallback, and only rows with no icon at all get a dot. Opening the session, the agent working again, or the pane closing clears its update. Set from the stream, and by the service worker from each push's `badge` count while the app is closed. Sends, stops, answers, picks and key-bar taps buzz briefly (`navigator.vibrate`, Android only).
- **Close**: the red ✕ in a session's header runs `tern close` after a confirmation (it closes the block on the desktop too; the dialog warns if the agent is working or waiting on you), then returns to the list.
- **Leaving**: on the list, the first back gesture only shows "Press back again to exit"; a second one within 2 s leaves the app. The list keeps a guard history entry for this. In a session, ‹ and the back gesture both return to the list.
- **Desktop browser**: at 1000 px and wider the list stays in a 360 px left sidebar (the open session highlighted) and the session fills the rest, its transcript, header and composer in a centered 780 px column. All of it lives behind one `@media (min-width: 1000px)` block and the `useWide()` switch in `App`; phones never match it. The back-to-exit guard and the ‹ button are phone-only.

Updates arrive over one SSE stream per screen, pushed rather than polled. The server follows `tern events` (any event except the `client_*` pair every CLI call logs), bridge changes (connect, disconnect, status, model, thinking, tier, context, session id, protocol, caps) and writes to `<omp dir>/history.db` (recaps); each batch (150 ms) rebuilds the list once and every open stream rechecks it. The open transcript or file is followed with a watch on its folder. Only terminal screens are still polled (Tern has no output event): every 450 ms for shells, 1.2 s for an omp's Raw screen, and only while one is open. A 15 s recheck backs up missed events.

The app holds a stream only while it is visible: 10 s after it is hidden (another app, screen off, a background tab) the stream closes and nothing flows; it reopens when the app comes back. With no phone watching, sessions also send no live text and count as unseen again. Closed or hidden, only Web Push notifications reach the phone.

- **Live text**: while a phone has a session open, the extension forwards the assistant message omp is writing (`message_update`, text parts only, at most every 200 ms) and the phone shows it below the transcript as it grows. When the message ends, the copy stays until the transcript write brings the final one, so nothing flickers. Sessions nobody watches send nothing (the server tells each omp with `watch` on/off).
- **Queued steers and follow-ups**: prompts sent while the agent works (from the phone or the desktop) show below the transcript until omp takes them: `↳` for a steer, `→` for a follow-up that waits for the turn to end. While the agent works and the composer has text, a `→` button next to send (Ctrl+Enter or Ctrl+Q on a keyboard, as in omp) sends it as a follow-up: `send` with `followUp` over the bridge → `pi.sendUserMessage(…, { deliverAs: "followUp" })`. Extensions can't read omp's queue, so the extension notes the text of each non-slash `input` (and each phone send) made while not idle, and drops them once `ctx.hasPendingMessages()` turns false (delivered, or pulled back with Alt+↑). Follow-ups queued with Ctrl+Q on the desktop show as `↳`: the `input` event doesn't say which key sent them. They travel as `queued` in the bridge state and a `queued` SSE event.
- **Tool intents**: a tool line shows the call's `i`; eval calls show their `title`; with neither, the first line of `command`/`path`/…/`code`.
- **Todo lists**: a tool line that ran `todo` carries omp's list as that call left it (`details.phases` of the tool result; the newest per tool group). The newest list in the chat shows every task: per-phase headings when there are several, `✓` done (faded), `▸` in progress, `○` pending, `!` blocked with its reason. Older ones collapse to one line (`done/total`, blocked count, the current task); a tap toggles either.
- **Subagents and background jobs**: the extension samples `ctx.getAsyncJobSnapshot()` once a second and reports the running jobs (id, type, label, agent name, start). A row with jobs gets a line like "2 subagents · 1 background job"; the session shows each one under the transcript (`⑂` subagent, `⧗` other job) with its name and run time. Names only: a subagent's own transcript isn't opened. Running `task`/`eval` subagents keep the session *working* even while its own turn has yielded to wait for them, so the list and "finished" notifications don't treat it as done; a backgrounded bash job (a watcher, a server) doesn't.
- **Table charts**: like omp in the terminal, a markdown table with numbers gets a bar chart under it (`web/charts.ts`): one panel per measure, one colored bar per option, each panel scaled on its own. Cells are read as number, range (`0.23–1.04 MB`, plotted at its middle) and unit (bytes, time, %, `$`, counts; a trailing parenthetical is ignored). Rows are the measures when each row keeps one unit and the columns mix them, else the columns are. The best value is marked only when the measure's name points one way (time, size, cost, errors… lower; accuracy, reusable, throughput, revenue… higher; "error rate"-style names that match both, and names that match neither, get no best). The headline is the "X is best on …" sweep when one option wins at least two measures; omp's model-picked headlines are not reproduced.

## Draft mirroring (omp extension)

`omp-extension/tern-mobile.ts`, symlinked to `~/.omp/agent/extensions/tern-mobile.ts`, runs in every omp started in a Tern pane (`$TERN_PANE`). It opens a WebSocket to `ws://127.0.0.1:4380/bridge` (`$TERN_MOBILE_BRIDGE` overrides), authenticated with `<config dir>/bridge-token` (created by the server, mode 600; the extension finds the folder as the server does, from `$TERN_MOBILE_CONFIG` or the home folder; `$TERN_MOBILE_TOKEN_FILE` overrides the file), and:

- polls `ctx.ui.getEditorText()` every 100 ms and sends the draft, model, thinking level and idle state when they change;
- applies `set` (phone keystrokes → `setEditorText`), `model` (`provider/id[:thinking]` → `pi.setModel` + `setThinkingLevel`), `thinking`, `tier` (`pi.setServiceTier`), and answers `models` with the catalog;
- reports the current model's thinking `levels`, `tiers` and active `tier`;
- while watched, sends the message being written (`live`) and its end;
- reports the prompts waiting in omp's queue (`queued`) and the session's leaf entry (`leaf`, `-` for none);
- registers `/tern-mobile-rewind`, which the phone's Rewind submits.

The phone shows a green dot by the model chip while mirroring. Its own edits win for 800 ms over echoes from the desktop. Submitting sets the draft to the final text, waits for omp's acknowledgment, then sends Enter, so slash commands work as typed.

omp loads extensions at startup: sessions started before the extension was installed don't mirror until restarted. Without the bridge, the composer types the prompt with `tern send` and the model sheet can only cycle (Ctrl+P).

Tern's CLI can't read a pane's editor (`tern capture` returns only the main surface region), and the plugin API's `surface()` returns nothing for hidden panes, so the draft is read from omp.

## Notifications

The bell in the list header turns on Web Push for that device (service worker `sw.js`, VAPID keys in `~/.config/tern-mobile/vapid.json`, subscriptions in `push.json`, both mode 600). It has three looks: slashed (off, or blocked in site settings), dimmed and pulsing (pending: asking for permission, subscribing, or waiting for the server to store the subscription; taps are ignored), and a green dot (on: the server confirmed it). The choice is kept per device in `localStorage` (`tern-mobile:push`); on every load a device that chose *on* checks its subscription, silently makes a new one if the browser dropped it or it belongs to another VAPID key, and re-sends it to the server, so updates and reloads don't turn notifications off. Bridged omp sessions trigger them:

- **Needs you**: the status turns *blocked* (an `ask` or a tool approval); the body is the question.
- **Finished**: *working* → *idle* that stays idle for 3 s; the body is the start of the last reply.

One notification per session (a newer one replaces it); tapping opens that session. A fresh bridge connection (restarted omp) never notifies. Payloads are end-to-end encrypted, but they travel through the browser's push service (FCM for Chrome), which also sees the VAPID subject: `mailto:` the first allowed login when it is an address, else a placeholder (`TERN_MOBILE_VAPID_SUBJECT` overrides). Subscriptions the push service reports as gone (404/410) are dropped.

## Requirements

On every OS: [Bun](https://bun.sh) (1.4 tested), Tern with its `tern` CLI on `PATH`, omp (`omp` on `PATH`), and Tailscale logged in with MagicDNS and HTTPS certificates enabled for the tailnet (Tailscale Serve needs both). git is optional: without it projects group by folder and no branch shows. Building needs nothing beyond Bun (see [Build](#build)).

- **Linux** (Arch, verified): a systemd user session. The service runs while you're logged in; `loginctl enable-linger $USER` keeps it running after logout and starts it at boot.
- **macOS** (not run): launchd. If `tailscale` isn't on `PATH`, the installer uses the App Store / standalone app's CLI at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
- **Windows** (not run): Task Scheduler (`schtasks`), Windows Script Host (`wscript.exe`) and PowerShell, all built in. No admin rights: the task runs as you, at your logon. The extension is copied, not linked (symlinks need Developer Mode), so re-run the installer after updating the checkout.

## Install

```bash
bun install
bun run install-service           # = bun install.ts [--port N] [--dry-run]
bun install.ts --uninstall        # [--dry-run]
```

`install.ts` installs a per-user service for this checkout. In order, it:

1. builds `dist/` (`bun build.ts`);
2. puts the omp extension into `<omp dir>/extensions/tern-mobile.ts` (`~/.omp/agent` unless `TERN_MOBILE_OMP_DIR`): a symlink to `omp-extension/tern-mobile.ts` on Linux and macOS, a copy on Windows;
3. runs `bun server.ts pair`, which creates the access token in the config dir if missing and prints `/pair?code=<token>`;
4. writes the service, with the absolute paths of bun and the checkout, a `PATH` starting with the folders of `tern`, `omp` and bun, the port and the allowed logins, and starts it (a re-run restarts it with the new settings):
   - Linux: `~/.config/systemd/user/tern-mobile.service` (a real file; a symlink left there is replaced), `systemctl --user daemon-reload`, `enable`, `restart`;
   - macOS: `~/Library/LaunchAgents/dev.tern-awui.plist` (`RunAtLoad`, `KeepAlive`, log in `~/Library/Logs/tern-awui.log`), `launchctl bootout` + `bootstrap gui/<uid>`;
   - Windows: a launcher `tern-awui.vbs` in the config dir that runs bun with no window and restarts it 3 s after it exits, and a scheduled task `tern-awui` that starts it at your logon (`schtasks /Create /XML`, then `/Run`);
5. runs `tailscale serve --bg --https=<port> http://127.0.0.1:<port>`;
6. prints the pairing link: `https://<this machine's tailnet name>:<port>/pair?code=…`.

The allowed login is the device's own Tailscale user (`tailscale status --json`) unless `TERN_MOBILE_ALLOW` is set. `TERN_MOBILE_PORT` (or `--port`) and any of `TERN_MOBILE_CONFIG`, `TERN_MOBILE_OMP_DIR`, `TERN_MOBILE_NOTES_DIR`, `TERN_MOBILE_PROJECTS`, `TERN_MOBILE_VAPID_SUBJECT` set when the installer runs are written into the service. `--dry-run` prints every file it would write (with its content) and every command, and changes nothing. `--uninstall` stops and removes the service, the extension link or copy and the serve entry; the config dir (tokens, VAPID keys, subscriptions) stays.

**Pairing.** Open the printed link on the phone, signed in to Tailscale as an allowed login. It sets the `tern_awui` cookie (HttpOnly, Secure, SameSite=Strict, long-lived) and redirects to the app; in Chrome on Android, ⋮ → *Add to Home screen* installs it. The link holds the access token: anyone with it and an allowed login gets in, so don't share it. To pair another device later, run `bun server.ts pair` in the checkout and put the same `https://<name>:<port>` in front. Deleting `access-token` from the config dir and restarting the service unpairs every device.

omp loads extensions at startup, so omp sessions already running don't bridge until restarted (`touch ~/.omp/agent/restart-all`).

For development, without the service and **without any auth** (everything that can reach the port gets a shell; loopback only, never behind Tailscale Serve):

```bash
bun run build && TERN_MOBILE_DEV=1 TERN_MOBILE_PORT=4381 bun server.ts
```

## Build

`bun run build` (`bun build.ts`) bundles `web/app.tsx` into `dist/` and copies the static files from `web/` and the prebuilt binaries from `assets/`; it needs no other tools. `assets/` is committed:

- `icon-192.png`, `icon-512.png`: `web/icon.svg` rendered by `rsvg-convert`;
- `symbols.woff2`: the private use areas of Symbols Nerd Font (`SymbolsNerdFont-Regular.ttf`, Nerd Fonts 3.5.1) subset by `pyftsubset`, for the Nerd Font icons in pane titles; its license is `assets/LICENSE-nerd-fonts-symbols` (SIL OFL 1.1 for the fonts, MIT for Nerd Fonts' code).

`bun run assets` (`bun assets.ts`) regenerates them after changing the icon or updating the font. It needs `rsvg-convert` (librsvg), `pyftsubset` (fonttools with brotli) and the font at `/usr/share/fonts/TTF/SymbolsNerdFont-Regular.ttf` or `TERN_MOBILE_SYMBOLS_FONT`.

`bun test` runs the test suites, `bun run typecheck` runs `tsc`.

## Configuration

The server reads these from its environment; the installer writes them into the service.

| Env | Default | |
|---|---|---|
| `TERN_MOBILE_PORT` | `4380` | loopback port, and the HTTPS port Tailscale Serve uses |
| `TERN_MOBILE_ALLOW` | — (required; the installer uses the device's Tailscale login) | comma-separated Tailscale logins |
| `TERN_MOBILE_CONFIG` | `~/.config/tern-mobile`, on every OS | `bridge-token`, `access-token`, `vapid.json`, `push.json` (mode 600 where the OS has modes) |
| `TERN_MOBILE_OMP_DIR` | as omp: `$PI_CODING_AGENT_DIR`, else `~/.omp/agent`, or `$XDG_DATA_HOME/omp` on Linux/macOS once it exists | omp's data: `sessions/`, `blobs/`, `history.db`. The installer puts the extension into `<dir>/extensions/` (default `~/.omp/agent`) |
| `TERN_MOBILE_NOTES_DIR` | Linux: `$XDG_STATE_HOME/tern/notes` or `~/.local/state/tern/notes`; macOS: `~/Library/Application Support/Tern/notes`; Windows: `%LOCALAPPDATA%\Tern\notes` (macOS/Windows unverified) | Tern notes |
| `TERN_MOBILE_PROJECTS` | the cwds of open Tern blocks and omp sessions, newest first | command printing one folder per line for **+ omp**; a `.py` path runs with `python3` |
| `TERN_MOBILE_VAPID_SUBJECT` | `mailto:<first allowed login>` if it contains `@`, else `https://tern-mobile.invalid` | Web Push contact |
| `TERN_MOBILE_DEV` | — | `1` turns off all auth (login and pairing). Unsafe: dev on loopback only |
| `TERN_MOBILE_SYMBOLS_FONT` | `/usr/share/fonts/TTF/SymbolsNerdFont-Regular.ttf` | `bun run assets` only |

## Security

This is a remote shell into the desktop.

- The server listens only on `127.0.0.1`. The only way in from outside is Tailscale Serve, which sets `Tailscale-User-Login`, and every request must carry an allowed login. Tagged devices get no login header, so they are refused. **Never enable Funnel.**
- `/api/*` (the stream included) also needs the pairing cookie `tern_awui`, whose value is the access token in `<config dir>/access-token` (32 random bytes, compared in constant time). `/pair?code=<token>` with the right code sets it (HttpOnly, Secure, SameSite=Strict, 400 days) and redirects to `/`; a wrong code gets a 403 page and no cookie. Without the cookie `/api` answers 401 `{"error":"not paired"}` and the app shows how to pair; its own files (page, scripts, icons, manifest, service worker) need only the login. `bun server.ts pair` prints the link's path (creating the token if needed) without starting the server. Deleting `access-token` and restarting the server unpairs every device.
- POSTs require an `x-tern-mobile: 1` header, which blocks cross-site form posts. Key names are allowlisted.
- `/bridge` refuses requests carrying a Tailscale login header (anything proxied from outside) and requires the bridge token (`<config dir>/bridge-token`); it doesn't use the pairing cookie.
- `TERN_MOBILE_DEV=1` turns off both the login and the cookie check: anyone who can reach the port gets a shell. Use it only on loopback, never behind Tailscale Serve.
- tern can report errors with exit status 0, so non-WARN stderr counts as failure and is returned to the phone.
- Agent markdown goes through DOMPurify. Only `http(s)` and `mailto` links are kept, and raw HTML is shown as text.

## Limits

- It is not a terminal emulator. Full-screen TUIs (vim, htop) only work through the screen capture and the key bar.
- Status, chat, model picks and images need the omp to be connected to the bridge: omp sessions started before the extension's current version show as terminals until restarted (`touch ~/.omp/agent/restart-all`).
- Features the session's omp lacks (the extension reports them as `caps`) are turned off in the app, and the server refuses Rewind, the model catalog and tier changes for them with 409. An extension without `caps` (before versioning) is taken to support everything, as before.
- Linux is the only OS this has run on. The macOS and Windows locations of omp's and Tern's files follow their sources (omp's directory resolver, the strings in the tern binary) and are unverified; `TERN_MOBILE_OMP_DIR` and `TERN_MOBILE_NOTES_DIR` set them by hand. omp profiles (`OMP_PROFILE`) are not followed.
- Only main sessions bridge (`ctx.agent.kind === "main"`). Older extension versions also bridged subagents under the same pane, which took over the pane's status (idle while the main session still worked) and, on exit, unbridged it; the server now keeps every connection per pane and hands the pane back to the remaining one (`sync`).
