# Changelog

## Unreleased

### Features

- Voice calls: the microphone button in an omp session starts omp's live voice mode with the phone as microphone and speaker. Coding requests run as turns of that session, and the bar above the composer shows what omp is doing, the last thing each side said, mute and hang up. The screen stays on during a call. Needs an omp newer than 18.13.3; restart running omp sessions to load the updated extension.
- omp's welcome mark stays at the top of an omp session once its first turn starts, and the chat follows right below it.

### Fixes

- On touch screens, tapping the π in an empty omp session plays its stomp and wiggle, which before only hover set off.
- The ↑ and ↓ prompt buttons show only once you scroll up from the end of the chat.

## 0.8.0 (2026-10-27)

### Fixes

- Session notifications dismiss when you open the session or start another turn on either device, once the mobile app is active.
- New unread notifications stay visible when they arrive during notification cleanup.
- The service runs at normal CPU priority under load: on Linux it is no longer named `bun`, which ananicy-cpp idles, and on Windows the scheduled task no longer runs below normal. Re-run `bun install.ts` to apply.
- A slow git, as on Windows, no longer stalls the server: git runs in the background, gives up after 2 s, and once per folder instead of two or three times.
- omp settings are read with one `omp config list --json` instead of six `omp config get` runs.
- A working agent's context gauge goes only to the phones showing that session, without rebuilding and resending the session list or rerunning `tern ls`.
- Chat messages with images are no longer re-rendered on every transcript update.
- Several phones on one session share one screen capture and one transcript read.
- omp's prompt-history writes to `history.db` no longer rebuild the list; only new recaps do.
- The server's caches drop closed sessions and folders instead of growing with uptime.
- Clocks on the page stop while it is hidden.
- The web app is sent brotli-compressed (about a third of its size), and reloads of an unchanged build download nothing.
- After the first full copy, session list updates carry only the rows that changed.

## 0.7.0 (2026-10-25)

### Features

- omp's working row under the chat: spinner, the turn's running time and the current tool's intent.
- Context gauge details card on hover or tap: percent used, tokens, auto-compact threshold.
- Context gauge styled like omp's: grey fill, faint compaction tick, a glint while the agent works.
- The full-screen image view pages through all of a turn's images (swipe, ‹ ›, arrow keys); Back closes it.
- Session header has drawn icons for focus on the desktop (a monitor) and close.
- **+ omp** is omp's blocky π with a plus; hovered, π stomps and wiggles.
- An empty omp session shows omp's welcome mark.
- Sidebar minimize/expand: "tern" folds into « and » unfolds back into "tern".

### Fixes

- A chat scrolled to the bottom stays there when the working row, jobs, images or a btw card grow it.

### Docs

- README opens with a film of one task handed from Tern to a browser to the phone and back.
- Shorter README: screenshots folded under the film, technical detail moved to `docs/architecture.md`.

### Internal

- Editing a released section of this changelog updates its GitHub release notes on push to main.

## 0.6.0 (2026-10-25)

### Features

- **+ omp** starts the new session without asking.
- A starting omp session takes a prompt that becomes omp's draft once it connects.
- Copy on agent replies, with every stretch open.

### Internal

- Stretchtext parser synced with omp-stretch.

## 0.5.0 (2026-10-22)

### Features

- omp-stretch's ✦: tap it on a fully open stretch to ask the pane's model for more, in sync with Tern (bridge protocol 3).
- **+ omp** lists folders by last use, each folder once.

### Fixes

- A ✦ answer after a table or code fence starts its own paragraph.

### Docs

- README names omp-stretch as the extension behind stretchtext replies.

### Internal

- Stretchtext parser is an unchanged copy of omp-stretch's.

## 0.4.0 (2026-10-20)

### Breaking

- No authentication of its own: without `TERN_AWUI_ALLOW` the server starts with no login check; `TERN_AWUI_DEV` is gone.
- Requests must name a known host; re-run `bun install.ts` to add the tailnet name to `TERN_AWUI_HOSTS`.

### Features

- Syntax highlighting for opened files and fenced code in opened markdown.
- ↑ and ↓ buttons jump between prompts in a chat.
- Open pages reload by themselves after `bun run build`.
- omp's injected rules show as quiet `• inject:` lines.
- Free-form advisor notes show their own text as markdown.
- Notifications recover by themselves after updates, restarts and lost permissions.
- A blocked notification permission says where to allow it.
- The installed Android app shows when Android has taken its notifications away.
- Releases are published from this changelog when a version tag is pushed.

### Fixes

- Text starting with `-` reaches the pane as written.
- The app reconnects by itself after the server restarts.
- Fewer lost desktop drafts when typing on both sides.
- A prompt sent with no model selected stays in the composer with an error.
- `/new` and `/resume` reset the previous session's gauge, jobs and queue.
- A Content-Security-Policy stops agent markdown from loading images from other sites.
- Very long texts are refused instead of making the bridge reconnect.
- Hung `git` lookups can't freeze the server.
- The Subagents view reads less, using far less memory on big sessions.
- Mermaid isn't redrawn in streaming text; failed library loads retry.
- Fix commands are quoted correctly for POSIX and PowerShell.
- The bridge token is created atomically.
- Installer fixes for port changes, uninstall and Windows.

## 0.3.0 (2026-10-16)

### Breaking

- The Linux service is now `tern-awui.service`; `bun install.ts` replaces the old one.

### Features

- Stretchtext replies: tap a phrase to grow it in place, in sync with the Tern pane.
- The desktop sidebar minimizes to a rail of session icons (Ctrl+\).
- List header counts are status dots with numbers.
- The hide-old-sessions toggle is an eye with the hidden count.
- Image previews show the whole image at its own aspect ratio.
- **Subagents (N)** shows only while a subagent runs.
- Subagent prompts render as markdown.
- omp's idle recaps show in the chat.
- An attach button adds images from the camera or gallery.
- Notifications re-register whenever the app returns to the foreground.

### Fixes

- A config file cut off by a crash no longer stops the server.
- A slow `TERN_AWUI_PROJECTS` command or `omp config` read no longer freezes the server.
- `--uninstall` keeps an extension link to another checkout.
- Commands to an omp whose bridge closed fail at once.
- Leaving a session frees attached image previews.
- CI fixes for test order, path separators and Windows.

### Docs

- README: security section, an install prompt for coding agents, macOS tested, screenshots with Opus 5.5.

### Internal

- `optipng` shrinks the generated PNGs when installed.

## 0.2.0 (2026-10-13)

### Breaking

- Environment variables are renamed from `TERN_MOBILE_*` to `TERN_AWUI_*`; re-run `bun install.ts`.
- Pairing is removed; access is the tailnet plus `TERN_AWUI_ALLOW`.

### Features

- Subagents are viewable, read-only.
- The app says when omp's extension doesn't match the server, with a **Reload** fix.
- Bare `/btw` opens the session's saved btw history.
- Untitled file blocks are named after their file.
- Desktop `->` / `=>` queue commands show as follow-ups.
- A wider desktop session column, and tables use the full width.
- A new app icon.
- Agent markdown screenshots with local paths render inline.

### Fixes

- Malformed requests and extension failures are reported instead of submitting rejected drafts.
- Session and bridge changes clear stale output, queue and notifications.
- Project discovery, transcript reading and rewind edge cases.
- Lost drafts, duplicate answers, stale live text and stuck controls.
- Symbols font for queued markers, chart currency parsing, broken saved preferences.
- Installer discovery settings, uninstall and systemd quoting.
- A failed build keeps the previous `dist/`.
- Windows install no longer kills whatever owns the port.

### Docs

- README rewritten for users; the technical reference is in `docs/architecture.md`.
- README links CodexBar AgentView.

### Internal

- GitHub Actions CI on Linux, macOS and Windows.
- Browser tests in Chromium, an isolated `startServer()`, split web components, installer tests.

## 0.1.0 (2026-10-11)

First release: a phone-sized web app for the Tern panes on one machine, served over Tailscale.

### Features

- Session list grouped by project, with live status, icon, recap and time.
- omp chats laid out like Tern's: replies, tools, tables, figures, todos, images, live text, queue, subagents and jobs.
- Send, steer, stop, `/btw`, answer asks, rewind, autocomplete, key bar and model picker.
- Terminal screens with live typing, notes and files, new omp tabs, closing blocks.
- Web Push notifications, an unseen badge and haptics.
- Desktop layout from 1000 px.
- The omp extension bridges each omp to the server and reports its capabilities.
- `install.ts` sets up the service and `tailscale serve` on Linux, macOS and Windows.
