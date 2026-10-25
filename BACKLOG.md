# Backlog

Ideas not yet started. Each should help someone away from the desk see which agent needs them, or reply to and steer it.

## Run a code block from a reply

A Run button on shell code blocks in omp's answers runs the block in the pane's folder and shows its output underneath, as Tern 0.6.0 does in its own omp view. On a phone, "run `bun test` to confirm" becomes one tap instead of typing the command into a shell pane.

- Runs arbitrary commands, so it asks for confirmation first and shows the command in full.
- Needs a timeout and a Stop, like every other external call.

## Park instead of Close, and parked sessions

A non-destructive "put away" next to Close. Tern 0.6.0 added parked panes that keep running out of sight; users asked for this instead of closing omp sessions and running `/resume` later.

- Check what the CLI offers first (`tern dock` is the likely command) and whether `tern ls --json` reports parked panes.
- Show parked sessions in the list, marked as parked, and offer bringing one back.
- Stays close to multiplexer territory: keep it to park and unpark, no layout control.

## Better shell handling

Plain terminals are second-class today: a screen view and a key bar.

- **Prompts count as "needs you".** A shell waiting on `[y/N]` or a password shows as blocked and gets Yes/No buttons. Tern 0.8.4 detects such prompts in command blocks, and 0.7.0's OSC 7501 status reports waiting, finished and failed for any program. Check whether `tern events` passes either on.
- **Failed commands show as failed**, apart from finished, and can trigger a notification.
- **Full-screen programs** (vim, htop) open in Tern's own web client (`tern web serve`) instead of the screen view.
