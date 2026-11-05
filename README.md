# tern-awui (another web UI for Tern)

A web app for following and steering the [omp](https://github.com/can1357/oh-my-pi) agents running in [Tern](https://stencil.so/tern), from a phone or another browser.

**[Try the demo](https://materemias.github.io/tern-awui/)**: the real app in your browser with sample sessions. It needs no Tern or omp, and nothing leaves the browser.

I built it for how I work. Tern stays open on the desktop with its panes, tern-awui sits next to it in a browser tab, and the same app is installed on my Android phone as a PWA. When I step away, I can still see which agent finished, which one is waiting for an answer, and reply. It's a companion to Tern, not a replacement: a project-based, focused view of the sessions.

![tern-awui on a phone: a session waiting on an ask is answered with one tap, the running turn is steered, a swipe moves to the next session and the session wheel picks another, a voice call asks that session a question and reads back its answer, the screen goes black with the microphone on and comes back, and the eye hides sessions older than a day](docs/phone.gif)

tern-awui runs no agents of its own. Every session it shows is an omp running in a Tern pane on your desktop, so the desktop and the phone work on the same sessions together:

- **Whatever is open in Tern continues on the phone.** Read the reply, answer its question, steer the turn or send the next prompt, and the Tern pane shows it too.
- **A session started on the phone opens a Tern tab on the desktop.** **+ omp** picks a project folder and starts omp there in a new tab, waiting for you when you sit back down.
- **Both screens drive the same omp.** Drafts, answers, model changes and rewinds go to the omp in its Tern pane, so the two never disagree.

The same task can move between screens: started in Tern, finished in a desktop browser, answered on the phone and sent from Tern again.

![One omp task handed over: a prompt typed in a Tern pane, finished and sent from a desktop browser, an ask answered on the phone, the reply's stretches opened and deepened there and shown open in Tern, a reply started on the phone and sent from the Tern pane](docs/handover.gif)

<details>
<summary>Screenshots</summary>

| Phone: sessions | Phone: a session | Phone: a question |
|---|---|---|
| ![Session list on a phone](docs/phone-list.png) | ![An omp session on a phone](docs/phone-session.png) | ![An open ask on a phone](docs/phone-ask.png) |

![Desktop browser: session list and an open session](docs/desktop.png)

</details>

It has no login of its own. You reach it over a private network you control, such as Tailscale (see [Security](#security)).

## Features

- **Every omp session at a glance.** Working, waiting for you, or idle, with the time in that status, the session's title, icon and tag, and the last prompt or omp's own recap.
- **Grouped by project.** Sessions are grouped by git repository (or folder), the most recently active first. Projects fold away, and sessions untouched for a day can be hidden with one tap.
- **The conversation, not the terminal.** omp sessions show as a chat: Markdown, tool runs, todo lists, charts, Mermaid and SVG figures, images, and the reply streaming in as omp writes it. Code blocks and quotes each have a Copy button. While the agent works, omp's working row shows what it is doing right now, with the todo list's progress and current task; a tap there jumps to the list. A reply that missed the prompt cache is marked as in Tern, with the tokens it sent again.
- **Stretchtext replies.** With [omp-stretch](https://github.com/materemias/omp-stretch), replies arrive as their gist and a tap grows the detail in place, in sync with the Tern pane. Tap ✦ on an open stretch to ask the model for more.
- **Two-way control.** Send prompts, steer a running turn or queue a follow-up, stop the agent, answer `ask` questions with a tap, attach photos or paste a copied image, and use omp's `/command`, `/skill:` and `@file` completions.
- **The draft is shared.** Text typed on the phone appears in the Tern pane's prompt and the other way round, so you can start on one and finish on the other.
- **Talk to omp.** The microphone button starts omp's live voice mode with the phone as its microphone and speaker: say what you want, the voice model hands coding work to the session as ordinary turns, and reads back the result. The screen stays on while you talk, and the moon button turns it black for the pocket (cycling, walking) with the microphone still on; hold a finger on it for a second to bring the call back. Needs an omp newer than 18.13.3 and an OpenAI Codex sign-in in omp.
- **Session controls.** Switch model, effort or Ctrl+P role, watch the context gauge, rewind or copy, ask a side question with `/btw`, and read subagents' conversations, finished ones too, from **Subagents (N)** under the chat.
- **Swipe between sessions.** Swipe left or right on an open session to reach the next or previous omp session in the list's order, or between a session's subagents. Turn the finger up or down mid-swipe to pick any session from a wheel, and lift to open it. Back still leads to the list. On a keyboard, Alt+← and Alt+→ switch at once.
- **Notifications.** Optional push notifications when a session finishes or needs you, and an unread count on the app icon. Notifications dismiss when you open the session or start another turn, including on desktop, while the mobile app is active. Cleanup preserves newly arrived unread notifications. If the app is closed or suspended, dismissal waits until it resumes.
- **Shells and files too.** Plain terminals show their screen with a key bar (Esc, ^C, arrows, Tab), and Tern notes and opened files are readable, Markdown with its local images.

## Works with Tern

- **Close** a session from the web, and its pane closes in Tern.
- **Park** a session or shell from its header to put it away in Tern, still running. It leaves the list, except while it waits on you or has news you haven't seen. The **Parked** tab of the **+ omp** sheet lists parked panes, and a tap brings one back into a tab of its own and opens it. Files and notes can't be parked from the web: Tern stops listing them once parked.
- **+ omp** opens a new omp tab in Tern in any project folder and jumps to it.
- **Closed** in the same sheet lists the omp sessions you typed into that no Tern pane runs any more, newest first, with their title, recap and folder. Typing searches all your omp sessions on the server, plus Claude Code and Codex sessions; a tool's name (`claude`, `codex`, `omp`) shows only that tool's. A tap reopens one in a new Tern tab in its folder (`omp --resume`, `claude --resume`, `codex resume`), and × hides it from the list.
- **The monitor button** in a session's header focuses that pane in the Tern window on the desktop.

## Requirements

- [Bun](https://bun.sh) 1.4 or newer
- Tern and omp, with `tern` and `omp` on `PATH`
- [Tailscale](https://tailscale.com), logged in, with MagicDNS and HTTPS certificates enabled. The installer needs it; without it, see [Without Tailscale](#without-tailscale).
- git (optional, for grouping by repository and showing branches)

I use it daily on Linux with Chrome on Android. macOS is tested. iPhone (Safari) and Windows should work but are untested, and reports are welcome.

## Install

### With a coding agent

Paste this prompt into an agent (omp, Claude Code, Codex, …) running on the desktop where Tern runs:

```text
Install tern-awui (https://github.com/materemias/tern-awui) on this machine.

1. Read its README, especially Requirements, Install and Security.
2. Check every requirement and tell me what is missing instead of working around it.
   The installer needs Tailscale logged in with MagicDNS and HTTPS certificates enabled.
3. Clone it to ~/code/tern-awui (ask me if I want a different place), then run `bun install`.
4. Run `bun install.ts --dry-run`, summarize what it will write and run, and wait for my OK.
5. Run `bun install.ts` and give me the address it prints.

Never use Tailscale Funnel, port forwarding or a public tunnel.
At the end, remind me to run /restart in omp sessions that were already running.
```

### By hand

```bash
git clone https://github.com/materemias/tern-awui.git
cd tern-awui
bun install
bun install.ts            # add --dry-run to see every step first
```

The installer builds the web app, links the omp extension, starts a user service (systemd, launchd or Task Scheduler), publishes it on your tailnet with `tailscale serve`, and prints the address, e.g. `https://my-desktop.tailnet-name.ts.net:4380/`. On Linux the service process is named `tern-awui`, not `bun`, so scheduler rules for bun (such as ananicy-cpp's) don't push it to idle priority.

Open that address on each device while signed in to Tailscale. To install it as an app, use Chrome's ⋮ → *Add to Home screen* on Android or Safari's Share → *Add to Home Screen* on iPhone. The installer lets in only your own Tailscale login, so there is nothing to pair.

omp loads extensions only when it starts, so run `/restart` in sessions that were already running. The web app marks outdated sessions and offers a **Reload** button that does it for you.

### Without Tailscale

```bash
bun install && bun run build
bun server.ts                    # http://127.0.0.1:4380/, TERN_AWUI_PORT changes the port
```

Link `omp-extension/tern-mobile.ts` into `~/.omp/agent/extensions/` yourself. Reaching the server from other devices is up to you, so read [Security](#security) first.

### Updating and removing

```bash
git pull && bun install.ts      # rebuild, update and restart the service
bun install.ts --uninstall      # remove the service, the extension and the tailnet entry
```

## Security

**tern-awui has no authentication.** Anyone who can send it a request controls your terminals: they can type commands, read your agents' conversations and open files.

It listens on `127.0.0.1` only. What you put in front of that port decides who reaches it:

- **Loopback only** (no proxy): only programs on this machine.
- **Tailscale Serve** (what the installer sets up): only devices on your tailnet. `TERN_AWUI_ALLOW` (set by the installer) narrows that to your own Tailscale login.
- **Another authenticating proxy** (e.g. Cloudflare Access, an SSH tunnel): it must refuse everyone but you. Add the name it serves under to `TERN_AWUI_HOSTS`.

**Never expose it publicly:** no port forwarding, no Tailscale Funnel, no tunnel without its own login. It also assumes a single-user machine, since every local account can reach `127.0.0.1`.

What it does protect against, and why, is in [how it works](docs/architecture.md#security).

## Limits

- It is not a terminal emulator. Full-screen programs like vim or htop are only usable through the screen view and the key bar.
- Sessions without the extension show as plain terminals.
- The extension uses some omp internals; a new omp version can turn individual features off until the extension catches up.
- The Closed list knows a session is open only through the extension, so an omp running in another terminal, or one that hasn't connected yet, shows there too. If a Tern tab started with `omp` runs in the session's folder without the extension, resuming asks first. An omp typed by hand into a shell tab can't be told apart, so check before resuming it. The list skips sessions whose folder was deleted. Sessions from before this feature are found through omp's prompt history only, which misses a session whose every prompt was typed again later in another one.
- Claude Code and Codex sessions show up only in a search, only if you typed into them (their `history.jsonl`) and only while their transcript is on disk; Claude Code deletes transcripts after 30 days by default. Neither tool says whether a session is running, so a search lists running ones too; resuming one opens the Tern tab whose command names it, and asks first if a tab runs the tool in its folder. A resumed Claude Code or Codex session shows here as a plain terminal.
- Voice calls end when the session screen closes. With the screen off, Android keeps playing the voice but silences the phone's microphone until you unlock, so use the black screen instead of the power button. Phones may also cut a call when the app goes to the background (iOS Safari does), and the call stays on the phone that started it.
- Swiping between sessions follows the list's hidden-old and folded projects, but not a filter typed in the desktop sidebar. A swipe that starts on something that scrolls sideways (a wide code block or table), or within 24 px of the screen edge, scrolls or goes back instead.
- Parking needs Tern's plugins and the tern-awui plugin the installer links. When no Tern window is open, parking or unparking starts one.

## More

- [How it works](docs/architecture.md): every feature in detail, the extension's protocol, configuration, build and tests.
- [CHANGELOG](CHANGELOG.md)
- [CodexBar AgentView](https://github.com/materemias/codexbar-agentview): the desktop-side counterpart, with usage and agent counts in Tern's status line.
- License: [MIT](LICENSE). The bundled Nerd Font symbols are SIL OFL 1.1 ([license](assets/LICENSE-nerd-fonts-symbols)).
