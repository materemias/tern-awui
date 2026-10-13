# tern-awui (another web UI for Tern)

A web app for following and steering the [omp](https://github.com/can1357/oh-my-pi) agents running in [Tern](https://stencil.so/tern), from a phone or another browser, over your Tailscale network.

I built it for how I work. Tern stays open on the desktop with its panes, tern-awui sits next to it in a browser tab, and the same app is installed on my Android phone as a PWA. When I step away, I can still see which agent finished, which one is waiting for an answer, and reply. It's a companion to Tern, not a replacement, and a stopgap until Tern's official mobile client ships.

| Phone: sessions | Phone: a session | Phone: a question |
|---|---|---|
| ![Session list on a phone](docs/phone-list.png) | ![An omp session on a phone](docs/phone-session.png) | ![An open ask on a phone](docs/phone-ask.png) |

![Desktop browser: session list and an open session](docs/desktop.png)

The screenshots show invented sessions; `bun docs/screenshots.ts` regenerates them.

## Features

- **Every omp session at a glance.** Working, waiting for you, or idle, with the time in that status, the session's title, icon and tag, and the last prompt or omp's own recap.
- **Grouped by project.** Sessions are grouped by git repository (or folder), the most recently active first. Projects fold away, and sessions untouched for a day can be hidden with one tap.
- **The conversation, not the terminal.** omp sessions show as a chat: prompts, Markdown answers, collapsed tool runs, todo lists, tables with bar charts, SVG and Mermaid figures, images and screenshots, advisor notes, and the reply streaming in as omp writes it.
- **Two-way control.** Send prompts, steer a running turn or queue a follow-up, stop the agent, answer `ask` questions by tapping an option, paste images, and use omp's own `/command`, `/skill:` and `@file` completions.
- **The draft is shared.** Text typed on the phone appears in the Tern pane's prompt, and text typed on the desktop appears on the phone, so you can start on one and finish on the other.
- **Model and effort.** Switch the model, thinking effort and service tier, or pick one of your Ctrl+P roles. A gauge shows how full the context window is and where compaction will start.
- **Notifications.** Optional push notifications when a session finishes or needs you, and an unread count on the app icon.
- **Rewind and side questions.** Copy or rewind to an earlier prompt, ask a quick `/btw` question without touching the session, and browse the session's saved btw history with bare `/btw`.
- **Subagents.** See running subagents and background jobs, and read any subagent's conversation.
- **Shells and files too.** Plain terminals show their screen with a key bar (Esc, ^C, arrows, Tab), and Tern notes and opened files are readable.
- **Phone and desktop.** On a phone it is one column; in a desktop browser the session list stays in a sidebar next to the open session.

## How it differs from Tern

Tern is a full terminal multiplexer. tern-awui looks only at what I need away from the keyboard:

- **omp first.** An omp pane shows as a conversation instead of a terminal screen. Other panes are still there, but secondary.
- **No tabs or splits.** All panes are in one flat list, grouped by project, regardless of which Tern window or tab they live in.
- **Recent work in front.** The newest activity is on top, old sessions can be hidden, and idle sessions show what they did last.
- **Status and notifications.** It is built around "who needs me", with counts in the header, red for waiting, green for finished and unread markers.

It works with Tern rather than beside it:

- **Close** a session from the web, and its pane closes in Tern.
- **+ omp** opens a new omp tab in Tern in any project folder and jumps to it.
- **⌖** focuses that pane in the Tern window on the desktop.
- Drafts, model changes, answers and rewinds happen in the real omp session in its Tern pane, so the desktop and the web never disagree.

## Platforms

- **Linux** with Tern and Chrome on Android: what I use every day.
- **iPhone (Safari), macOS and Windows** should work. The installer has macOS and Windows support, but none of these have been tested yet. Reports are welcome.

## Requirements

- [Bun](https://bun.sh) 1.4 or newer
- Tern, with the `tern` command on `PATH`
- omp, with the `omp` command on `PATH`
- [Tailscale](https://tailscale.com), logged in, with MagicDNS and HTTPS certificates enabled for the tailnet
- git (optional, for grouping by repository and showing branches)

## Install

```bash
git clone <this repository> tern-awui
cd tern-awui
bun install
bun install.ts            # add --dry-run to see every step first
```

The installer does everything once:

1. builds the web app;
2. installs the omp extension (see below);
3. creates a background service for your user (systemd on Linux, launchd on macOS, Task Scheduler on Windows) and starts it;
4. publishes it on your tailnet with `tailscale serve`;
5. prints the address, e.g. `https://my-desktop.tailnet-name.ts.net:4380/`.

Open that address on each device while signed in to Tailscale. On Android, use Chrome's ⋮ → *Add to Home screen* to install it as an app. On iPhone, use Safari's Share → *Add to Home Screen*. Only your own Tailscale login is let in, so there is nothing to pair.

### The omp extension

Most features (status, chat, shared drafts, model picker, notifications) come from a small omp extension that connects each omp session to the server. The installer puts it in place. The best way, which the installer uses on Linux and macOS, is a **symlink** from omp's extension folder to the checkout:

```bash
ln -s "$PWD/omp-extension/tern-mobile.ts" ~/.omp/agent/extensions/tern-mobile.ts
```

That way a `git pull` updates the extension as well. On Windows the installer copies the file instead, so run `bun install.ts` again after updating.

omp loads extensions only when it starts, so **sessions that were already running need a restart**. In each one, run `/restart`: omp restarts in the same pane and continues the session. The web app marks sessions running an outdated extension and offers a **Reload** button that does this for you.

### Updating and removing

```bash
git pull && bun install.ts      # rebuild, update and restart the service
bun install.ts --uninstall      # remove the service, the extension and the tailnet entry
```

## Security

This is a remote shell into your desktop. The server listens only on `127.0.0.1` and is reachable only through `tailscale serve` on your tailnet, and only for the allowed Tailscale logins. **Never expose it with Tailscale Funnel.** Details are in [how it works](docs/architecture.md#security).

## Limits

- It is not a terminal emulator. Full-screen programs like vim or htop are only usable through the screen view and the key bar.
- Sessions without the extension show as plain terminals.
- Desktop Ctrl+Q follow-ups without a `->` prefix show as steers, because omp doesn't tell extensions which key sent a prompt.
- Answers to `/btw <question>` asked from the web aren't saved in omp's btw history.
- The extension uses some omp internals; a new omp version can turn individual features off until the extension catches up.

## More

- [How it works](docs/architecture.md): every feature in detail, the extension's protocol, configuration, build and tests.
- [CHANGELOG](CHANGELOG.md)
- License: [MIT](LICENSE). The bundled Nerd Font symbols are SIL OFL 1.1 ([license](assets/LICENSE-nerd-fonts-symbols)).
