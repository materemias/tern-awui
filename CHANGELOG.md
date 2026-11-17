# Changelog

## Unreleased

### Fixes

- A sentence the model wrapped in `{{…}}` without a short form opens from the words before it instead of showing raw braces.

## 0.12.1 (2026-11-16)

### Features

- Images pasted into an ask's option notes (omp 18.21+) show on the answered card; tap a marker to open one.

## 0.12.0 (2026-11-16)

### Features

- Deny a tool call with a reason the agent reads next; a short line confirms each answered approval or ask.
- Share screenshots, text or links from Android to the app and pick the session; long-press the icon for Waiting.
- Tool runs show their result after the intent, like "412 passed · 3 failed", "no type errors" or "4 results in 2 files".
- A stopped-on-limit session shows when it resets, with Continue now or when it resets. Reason and Continue need /restart in omp.

### Fixes

- A prompt resent after a lost reply no longer runs twice.

## 0.11.1 (2026-11-15)

### Features

- The guide now also tours a session: composer, question and approval cards, voice call, park and show on desktop.
- The guide explains Waiting, skips what this device doesn't show, and survives moving between list and session.
- The demo opens on a session waiting for an approval, and its notification bell switches on (it sends nothing).
- The demo's second Tern session is called "weekend".

## 0.11.0 (2026-11-15)

### Features

- The demo shows every feature, including approvals, Waiting, Tern session chips, Closed, voice, `/btw`, ✦ and rewind.
- Allow or deny omp's tool approvals from the phone, seeing the tool, the reason and what the call would do.
- With CodexBar AgentView, a **Waiting** strip and popup show set-aside sessions, grouped by who acts next.
- A session set aside in Waiting shows its wait above the composer, as in Tern; a tap opens its Waiting page.
- Icon buttons, including the composer's, say what they do on hover.
- With the command or skill list open, Enter picks the highlighted entry instead of sending; ↑ ↓ move, Esc closes.
- Chips under the list's header pick which Tern session it shows. Unparking needs `tern plugin reload tern-awui`.
- Each turn folds its work behind one line such as `Worked 7m12s · 38 tools`, between the prompt and the final reply.
- A turn that edited files ends with a card listing them with line counts.
- A short first-run guide walks through the session list; **Guide** in the dock opens it again.
- Session rows take one line; press and hold (or hover) for the recap or last prompt.
- Notifications, **Hide old** and **Guide** sit in a floating dock at the lower right.
- On the phone the filter opens from a search button.
- On the phone, Park and Show on desktop sit in a session's ⋯ menu.
- Prompts look like omp's band, fold past six lines and show their images as small thumbnails.
- The chat's ↑ and ↓ buttons show only once you scroll up, with a dot for new output.
- A question with one field opens with that question.
- Stretchtext short forms are a muted blue, as in omp's TUI.
- Tool lines, todo lists and rules use the body font.
- On the desktop the chat keeps to a 720 px column.
- The new-omp sheet's first tab is called **New**.

### Fixes

- Images in replies no longer run wider than the chat.
- An answer that drew an advisor note stays in view.
- Mermaid diagrams no longer flicker when a stretch opens.
- Images a reply names as `local://<name>` show.
- The **+ omp** sheet keeps one height across its tabs.
- Short project names in Parked and Closed are no longer cut.
- Panes parked in a closed Tern session are listed apart and can be closed. Needs `tern plugin reload tern-awui`.
- Parked and Closed rows lead with their project.
- Tern session chips that don't fit fade at the edge.
- Answered asks show the notes on chosen options (omp 18.18.8 and newer).
- A markdown link in a stretch opens whole, including URLs with parentheses or a title.

### Docs

- The phone film no longer opens on an "outdated extension" warning.
- The phone film shows the current app.
- The README recommends omp-stretch, CodexBar AgentView and omp-compact, with install commands.
- The README opens with why to pick tern-awui over Tern's mobile app.
- The handover film shows the current app.
- A new film shows a tool approval and the Waiting popup handled from a phone.

## 0.10.0 (2026-11-09)

### Features

- The new-omp sheet's **Closed** tab lists ended sessions, searches omp, Claude Code and Codex, and resumes one in a tap.
- A working session's row shows todo progress and the current task, e.g. `2/5 · Add the light palette`.
- **Subagents (N)** under the chat stays after every subagent has finished.
- An open chat receives only changed entries after its first load, using far less mobile data.
- A static demo with sample sessions runs in any browser, deployed to GitHub Pages.
- The session wheel opens on the current session, so a quick swipe moves to the next or previous one.
- Park a session or shell to put it away in Tern while it keeps running; the **Parked** tab brings it back. Run `bun install.ts` again.
- The chat marks omp's cache misses like Tern does, e.g. `Cache miss · 124k tokens`.

### Fixes

- A sideways swipe low on the screen no longer buzzes on and on.
- Resending after a failed send no longer runs the prompt twice. omp sessions need `/restart`.
- Opened Markdown files show their embedded images, including relative ones.
- Stretchtext parser synced with omp-stretch, fixing several stretch and ✦ answer display bugs.
- Asks work again with omp 18.18.3 and newer, shown as a form you can answer from the phone.
- An ask answer omp refuses no longer hangs on "Sent, waiting for omp…"; it can be sent again.

### Docs

- The phone film shows a voice call and the black screen.
- The README explains up front that the desktop and the phone share the same Tern sessions.
- The README links to the live demo on GitHub Pages.

## 0.9.0 (2026-10-30)

### Features

- The microphone button starts a voice call with the omp session (needs omp newer than 18.13.3).
- During a call, the moon button blacks out the screen so the microphone keeps working in a pocket.
- omp's welcome mark stays at the top of a session once its first turn starts.
- On touch screens, the image button can paste an image from the clipboard.
- Swipe sideways on an open session or subagent to reach the next one, or turn mid-swipe to pick from a wheel.
- Code blocks and quotes have their own Copy button.

### Fixes

- Tapping the π in an empty omp session plays its animation on touch screens.
- The ↑ and ↓ prompt buttons only show once you scroll up from the end of the chat.

### Docs

- The README has a second film showing the app on a phone.

## 0.8.0 (2026-10-27)

### Fixes

- Session notifications dismiss when you open the session or start another turn on either device.
- New unread notifications stay visible when they arrive during notification cleanup.
- The service runs at normal CPU priority under load. Re-run `bun install.ts` to apply.
- A slow git, as on Windows, no longer stalls the server.
- omp settings are read with one `omp config list --json` instead of six `omp config get` runs.
- A working agent's context gauge no longer resends the session list.
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

- omp-stretch's ✦: tap it on a fully open stretch to ask the model for more, in sync with Tern.
- **+ omp** lists folders by last use, each folder once.

### Fixes

- A ✦ answer after a table or code fence starts its own paragraph.

### Docs

- README names omp-stretch as the extension behind stretchtext replies.

### Internal

- Stretchtext parser is an unchanged copy of omp-stretch's.

## 0.4.0 (2026-10-20)

### Breaking

- No authentication of its own: without `TERN_AWUI_ALLOW` there's no login check; `TERN_AWUI_DEV` is gone.
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
