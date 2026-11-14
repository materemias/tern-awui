# The workflow film's stand-in for CodexBar AgentView's `codexbar_waiting.py`: four set-aside
# sessions, one on you, and the commands the phone sends (`list`, `mark-seen`, `snooze`, `seen`),
# answered as the real CLI does: one JSON object on stdout, with the new view after a change, which
# is also written to waiting_view.json in its state folder. The take points the server at it with
# CODEXBAR_WAITING. Standard library only; the server runs it with `python3`.
import json
import os
import sys
from datetime import datetime, timedelta, timezone

STATE = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "codexbar-agentview")
ROWS = os.path.join(STATE, "film_rows.json")
VIEW = os.path.join(STATE, "waiting_view.json")
NOW = datetime.now(timezone.utc)


def at(minutes: float) -> str:
    """An ISO time `minutes` from now (negative: ago)."""
    return (NOW + timedelta(minutes=minutes)).isoformat(timespec="seconds").replace("+00:00", "Z")


def wait(id, kind, label, summary, ball, state="waiting", mark="⏳", due=None, reason=None, outcome=None):
    return {"id": id, "kind": kind, "label": label, "summary": summary, "ball": ball, "state": state, "mark": mark,
            "due_at": due, "reason": reason, "outcome": outcome, "overdue": False, "has_prompt": False, "repeat": None,
            "created_at": at(-300)}


def session(id, project, title, ball, waits, **more):
    row = {"session_id": id, "project": project, "cwd": f"~/code/{project}", "title": title, "ball": ball, "live": False,
           "pane": None, "agent_state": None, "unseen": False, "pinned": False, "size": None, "note": None,
           "suggested_note": None, "outcome": None, "headline": None, "threads": [], "still_waiting": [],
           "waiting_for": None, "due_at": None, "line": "", "next_step": None, "recap": None, "recap_at": None,
           "recap_stale": False, "set_aside_at": at(-300), "waits": waits, "history": [], "prs": [], "on_you": [],
           "stoppable": len(waits)}
    row.update(more)
    return row


def first_rows() -> list:
    review = wait("w-review", "pr", "PR #42 review", "PR#42 review", "on_me", state="fired", mark="✅", outcome="fulfilled")
    preview = wait("w-preview", "command", "Preview deploy", "preview deploy of PR#42", "on_machine", due=at(25))
    restore = wait("w-restore", "command", "Restore test", "restore test of last night's backup", "on_machine", due=at(40))
    return [
        session(
            "film-tax", "webshop", "\uf07a TAX: Fix checkout tax rounding", "on_me", [review, preview],
            unseen=True, outcome="fulfilled", headline="✅ PR #42 approved by Dóra",
            threads=["✅ PR#42 approved", "⏳ preview deploy of PR#42"], still_waiting=["⏳ preview deploy of PR#42"],
            note="Merge once the preview looks right on a phone.",
            next_step="Merge PR #42 and tag the 2.4.1 release.",
            set_aside_at=at(-190), due_at=at(25),
            recap="Tax is rounded once per order now, so totals match the receipt. 38 checkout tests pass; PR #42 is open.",
            recap_at=at(-190),
            history=[
                {"at": at(-190), "kind": "set_aside", "text": "Set aside: waiting on review"},
                {"at": at(-120), "kind": "note", "text": "Preview deploy started"},
                {"at": at(-6), "kind": "fired", "text": "PR #42 approved by Dóra"},
            ],
            prs=[{"repo": "acme/webshop", "number": 42, "url": "https://github.com/acme/webshop/pull/42", "source": "created",
                  "title": "Round tax once per order", "state": "open", "review": "approved", "checks": "passing"}],
            on_you=[{"id": "w-review", "label": "PR #42 review", "mark": "✅", "text": "approved by Dóra", "report": None}],
        ),
        session(
            "film-backup", "homelab", "\uf1c0 BACKUP: Verify nightly backups", "on_machine", [restore],
            threads=[f"⏳ restore test until {(NOW + timedelta(minutes=40)).astimezone():%H:%M}"], due_at=at(40), set_aside_at=at(-75),
            note="If the restore passes, drop the old snapshots.",
        ),
        session(
            "film-post", "blog", "\uf040 POST: Draft offline notes post", "on_someone",
            [wait("w-anna", "something", "Anna's review", "Anna's review of the draft", "on_someone")],
            waiting_for="Anna's review of the draft", set_aside_at=at(-60 * 26),
        ),
        session(
            "film-cart", "storefront", "\U000f011c UI: Review the new cart screens", "on_my_time",
            [wait("w-later", "later", "When I have time", "when I have time", "on_my_time", mark="📌")],
            pinned=True, size="M", note="Try it on the iPad too.", set_aside_at=at(-60 * 50),
        ),
    ]


def load() -> list:
    try:
        with open(ROWS) as f:
            return json.load(f)
    except FileNotFoundError:
        return first_rows()


def view(rows: list) -> dict:
    on_me = sum(1 for r in rows if r["ball"] == "on_me")
    return {"ok": True, "now": at(0), "counts": {"on_me": on_me}, "sessions": rows, "panes": [],
            "health": {"checked_at": at(0), "error": None}}


def save(rows: list) -> dict:
    """Keeps the rows and rewrites the view by renaming, as the real CLI does."""
    os.makedirs(STATE, exist_ok=True)
    with open(ROWS, "w") as f:
        json.dump(rows, f)
    v = view(rows)
    with open(VIEW + ".tmp", "w") as f:
        json.dump(v, f)
    os.replace(VIEW + ".tmp", VIEW)
    return v


def opt(args: list, name: str):
    return args[args.index(name) + 1] if name in args else None


def main(args: list) -> int:
    rows = load()
    if not args or args[0] == "list":
        print(json.dumps(save(rows)))
        return 0
    row = next((r for r in rows if r["session_id"] == opt(args, "--session")), None)
    if row is None:
        print(json.dumps({"ok": False, "error": "not on the waiting list"}))
        return 2
    command = args[0]
    if command == "mark-seen":
        # What came is closed; the row goes back to what it still waits on.
        seen = {o["id"] for o in row["on_you"]}
        row["waits"] = [w for w in row["waits"] if w["id"] not in seen]
        row["threads"] = row["still_waiting"]
        row.update(on_you=[], outcome=None, headline=None, still_waiting=[], unseen=False, stoppable=len(row["waits"]))
        row["ball"] = row["waits"][0]["ball"] if row["waits"] else "on_my_time"
        row["history"].append({"at": at(0), "kind": "seen", "text": "Seen from the phone"})
    elif command == "snooze":
        w = next(w for w in row["waits"] if w["id"] == opt(args, "--wait"))
        due = datetime.fromisoformat((w["due_at"] or at(0)).replace("Z", "+00:00")) + timedelta(days=1)
        w["due_at"] = row["due_at"] = due.isoformat(timespec="seconds").replace("+00:00", "Z")
        row["threads"] = [f"⏳ {w['label'].lower()} tomorrow at {due.astimezone():%H:%M}"]
        row["history"].append({"at": at(0), "kind": "snoozed", "text": f"Snoozed the {w['label'].lower()} for a day"})
    elif command == "seen":
        row["unseen"] = False
    else:
        print(json.dumps({"ok": False, "error": f"the film's CLI doesn't do {command}"}))
        return 2
    print(json.dumps({"ok": True, "view": save(rows)}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
