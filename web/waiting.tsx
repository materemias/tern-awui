// The Waiting popup: sessions set aside in CodexBar AgentView, grouped by who holds the next step.
// Its list says in one line where each stands; a tap opens the session in full, with its actions at
// the bottom. It shows what `codexbar_waiting.py` reports and sends the taps back to it through the
// server. Its way in is the strip under the list's filter (an hourglass on the rail).
import { useEffect, useRef, useState } from "preact/hooks";
import { launchAgent, post, type Item, type Waiting, type WaitingRow } from "./api";
import { blockOf, closeOf, groupRows, headlineText, rowId, snoozeTarget, type Close, type Health, type Outcome, type Pr } from "../lib/waiting-view";
import { splitTitle } from "../lib/title";
import { age } from "./lib";
import { goBack, useNow } from "./hooks";
import { buzz } from "./parts";

function Hourglass() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5.5 3h9M5.5 17h9M6.5 3v2.5C6.5 7.5 10 8.5 10 10s-3.5 2.5-3.5 4.5V17M13.5 3v2.5C13.5 7.5 10 8.5 10 10s3.5 2.5 3.5 4.5V17" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** How many rows wait on the user, and how many on anything else; null with nothing to show. */
function tally(waiting: Waiting | null): { onMe: number; more: number } | null {
  if (!waiting?.available || !waiting.rows.length) return null;
  const onMe = waiting.rows.filter((r) => r.ball === "on_me").length;
  return { onMe, more: waiting.rows.length - onMe };
}

/**
 * The way in under the list's filter: one tap target, with what waits on you. Nothing without waits.
 * `compact`: a pill beside the Tern session chips, with the on-you count (else every set-aside one).
 */
export function WaitingStrip({ waiting, compact = false }: { waiting: Waiting | null; compact?: boolean }) {
  const n = tally(waiting);
  if (!n) return null;
  const rest = n.onMe ? `${n.more} more` : `${n.more} set aside`;
  const label = ["Waiting", n.onMe && `${n.onMe} on you`, n.more && rest].filter(Boolean).join(", ");
  if (compact)
    return (
      <a class={`wait-strip compact${n.onMe ? " on-me" : ""}`} href="#/waiting" aria-label={label} title={label}>
        <Hourglass />
        <span class="wait-strip-name">Waiting</span>
        <span class={n.onMe ? "wait-strip-me" : "muted"}>{n.onMe || n.more}</span>
      </a>
    );
  return (
    <a class={`wait-strip${n.onMe ? " on-me" : ""}`} href="#/waiting" aria-label={label}>
      <Hourglass />
      <span class="wait-strip-name">Waiting</span>
      {n.onMe > 0 && <span class="wait-strip-me">{n.onMe} on you</span>}
      {n.more > 0 && <span class="muted">{n.onMe ? `· ${rest}` : rest}</span>}
      <span class="wait-strip-go" aria-hidden="true">
        ›
      </span>
    </a>
  );
}

/** The rail's way in, where the strip doesn't fit: the hourglass with what waits on you as its badge. */
export function WaitingIcon({ waiting }: { waiting: Waiting | null }) {
  const n = tally(waiting);
  if (!n) return null;
  const label = n.onMe ? `Waiting: ${n.onMe} on you` : "Waiting";
  return (
    <a class="icon-btn waiting-btn" href="#/waiting" aria-label={label} title={label}>
      <Hourglass />
      {n.onMe > 0 && <span class="waiting-count">{n.onMe}</span>}
    </a>
  );
}

/** What a mark stands for. One small icon set for all of them, instead of the CLI's emoji. */
type Kind = "done" | "attention" | "overdue" | "waiting" | "timer" | "working" | "manual" | "later";

const MARK_KIND: Record<string, Kind> = { "✅": "done", "⚠️": "attention", "⚠": "attention", "⏰": "overdue", "⏳": "waiting", "⏲": "timer", "⏲️": "timer", "🔧": "working" };
const OUTCOME_KIND: Record<Outcome, Kind> = { fulfilled: "done", attention: "attention", overdue: "overdue" };

/** A thread as the CLI writes it, `⏳ PR#12 review on head`, as its kind and its words. */
export function parseThread(raw: string): { kind: Kind; text: string } {
  const m = /^(\S+)\s+(.*)$/su.exec(raw);
  // A leading word with letters or digits is no mark.
  if (!m || /[\p{L}\p{N}]/u.test(m[1])) return { kind: "waiting", text: raw };
  return { kind: MARK_KIND[m[1]] ?? "waiting", text: m[2] };
}

const GLYPH: Record<Kind, preact.JSX.Element> = {
  done: <path d="M6.5 10.2 9 12.6l4.5-5" />,
  attention: (
    <>
      <path d="M10 6.5v4.2" />
      <path d="M10 13.6v.1" />
    </>
  ),
  overdue: <path d="M10 6.5V10l2.4 1.6" />,
  waiting: <path d="M7.6 6.8h4.8L7.6 13.2h4.8Z" />,
  timer: <path d="M10 6.8V10h2.6" />,
  working: <path d="M7.4 10h.1M10 10h.1M12.6 10h.1" />,
  manual: <path d="M7 12.8 12.6 7.2l.9.9L7.9 13.7 6.7 14Z" />,
  later: <path d="M7.5 6.5h5v7.5L10 12.2 7.5 14Z" />,
};

/** A wait's state as a ringed icon, coloured by its kind. */
function Glyph({ kind }: { kind: Kind }) {
  return (
    <svg class={`wglyph k-${kind}`} viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7.6" />
      {GLYPH[kind]}
    </svg>
  );
}

/** "in 12m", "in 3h", "in 2d 4h". Whole minutes up to the hour, then the nearest hour, so never "in 60m" or "in 24h". */
function leftUntil(due: number, now: number): string {
  const m = Math.ceil((due - now) / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

/** The time beside a session: how long ago its wait came, overdue, due now, time left, else how long it has been set aside. */
function rowTime(row: WaitingRow, now: number): { text: string; cls: string } {
  const came = row.outcome === "fulfilled" ? row.history.findLast((h) => h.fired)?.at : 0;
  if (came) return { text: `${age(came, now)} ago`, cls: "" };
  if (row.waits.some((w) => w.overdue)) return { text: "overdue", cls: "t-warn" };
  if (row.due) return row.due <= now ? { text: "due now", cls: "t-warn" } : { text: leftUntil(row.due, now), cls: "" };
  return { text: row.since ? age(row.since, now) : "", cls: "" };
}

/** "13:09" today, else "Nov 12, 13:09". */
function clock(ms: number, now: number): string {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${hm}`;
}

/**
 * Where a session stands, in one sentence: what came (and what the wait that came asks of you),
 * else what it waits on. `rest`: the other threads it still waits on.
 */
export type Standing = { kind: Kind; text: string; detail: string; rest: { kind: Kind; text: string }[] };

export function standing(row: WaitingRow): Standing {
  // The free-text wait is shown and edited on its own; the group already says "When I have time".
  const later = row.ball === "on_my_time";
  const listed = (t: { text: string }) => !(row.waitingFor && t.text.endsWith(row.waitingFor)) && !(later && /^when i have time$/i.test(t.text));
  const threads = row.threads.map(parseThread).filter(listed);
  const mine = row.waits.find((w) => w.ball === "on_me" && w.outcome) ?? row.waits.find((w) => w.ball === "on_me");
  const detail = mine ? [mine.label, mine.reason].filter(Boolean).join(": ") : "";
  if (row.outcome) {
    const text = headlineText(row) ?? threads[0]?.text ?? "";
    // Only what is still open: other threads may have come too.
    return { kind: OUTCOME_KIND[row.outcome], text, detail, rest: row.stillWaiting.map(parseThread).filter(listed) };
  }
  if (row.ball === "on_me") return { kind: "attention", text: mine?.reason || mine?.label || threads[0]?.text || "Needs you", detail: mine?.reason ? mine.label : "", rest: threads };
  if (threads.length) return { kind: threads[0].kind, text: threads[0].text, detail: "", rest: threads.slice(1) };
  if (row.waitingFor) return { kind: "manual", text: row.waitingFor, detail: "", rest: [] };
  // The group already says "When I have time": only a size is news.
  return { kind: "later", text: row.size ? `Size ${row.size}` : "", detail: "", rest: [] };
}

/** How a row is tinted: what came, what needs a look, or quiet. */
function tone(row: WaitingRow): string {
  if (row.outcome === "fulfilled") return "done";
  return row.outcome || row.ball === "on_me" ? "warn" : "calm";
}

/** The project, the title's icon and tag, and the title, as the session list writes them. */
function Name({ row }: { row: WaitingRow }) {
  const t = splitTitle(row.title);
  return (
    <span class="wname">
      {row.project && <span class="wname-project">{row.project}</span>}
      {t.icon && <span class="nf">{t.icon}</span>}
      {t.tag && <span class="tag">{t.tag}</span>}
      <span class="wname-title">{t.title}</span>
    </span>
  );
}

/** The commands a session's buttons send, with what is in flight and what failed. */
function useActions(row: WaitingRow) {
  const [busy, setBusy] = useState(false);
  const target = row.session === null ? { pane: row.pane } : { session: row.session };
  async function act(action: string, extra: Record<string, unknown> = {}): Promise<boolean> {
    setBusy(true);
    buzz();
    const err = await post(`/api/waiting/${action}`, { ...target, ...extra });
    setBusy(false);
    if (err) alert(err);
    return !err;
  }
  return { busy, act };
}

const DoneIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M5.5 10.4 8.6 13.4 14.5 7" />
  </svg>
);

const CLOSE_TAG: Record<Close["verdict"], string> = { safe: "closable", manual: "you reopen", park: "park only" };

/** Whether closing it keeps its waits, in a word; the full sentence on hover. Park warns. */
function CloseTag({ close }: { close: Close | null }) {
  if (!close) return null;
  return (
    <span class={`tag wclose${close.verdict === "park" ? " t-warn" : ""}`} title={close.text}>
      {CLOSE_TAG[close.verdict]}
    </span>
  );
}

/** A session on the list: who, where it stands, your note. Rows with something on you get Seen right there. */
function Row({ row, health, now }: { row: WaitingRow; health: Health | null | undefined; now: number }) {
  const { busy, act } = useActions(row);
  const s = standing(row);
  const time = rowTime(row, now);
  const more = s.rest.length + (row.waitingFor && s.kind !== "manual" ? 1 : 0);
  return (
    <li class={`wrow tone-${tone(row)}${row.unseen ? " unseen" : ""}`}>
      <a class="wrow-main" href={`#/waiting/${encodeURIComponent(rowId(row))}`}>
        <span class="wrow-top">
          <Name row={row} />
          <CloseTag close={closeOf(row, health, now)} />
          <span class={`wrow-time ${time.cls}`}>{time.text}</span>
        </span>
        {(s.text || more > 0) && (
          <span class="wrow-state">
            <Glyph kind={s.kind} />
            <span class="wrow-text">{s.text}</span>
            {more > 0 && <span class="wrow-more">+{more}</span>}
          </span>
        )}
        {row.note && <span class="wrow-note">{row.note}</span>}
      </a>
      {row.onYou.length > 0 && (
        <button class="wrow-done" disabled={busy} aria-label="Seen" title={`Seen: ${row.onYou.map((o) => o.label).join(", ")}`} onClick={() => void act("mark-seen")}>
          <DoneIcon />
        </button>
      )}
    </li>
  );
}

const PR_SOURCE: Record<Pr["source"], string> = { wait: "waiting on it", created: "created here", mentioned: "mentioned" };
const PR_FACT: Record<string, { text: string; cls: string }> = {
  open: { text: "open", cls: "" },
  draft: { text: "draft", cls: "" },
  merged: { text: "merged", cls: "t-info" },
  closed: { text: "closed", cls: "t-bad" },
  approved: { text: "approved", cls: "t-ok" },
  changes_requested: { text: "changes requested", cls: "t-bad" },
  review_required: { text: "review required", cls: "" },
  passing: { text: "checks pass", cls: "t-ok" },
  failing: { text: "checks fail", cls: "t-bad" },
  pending: { text: "checks running", cls: "t-warn" },
};

function PrRow({ pr }: { pr: Pr }) {
  const facts = [pr.state, pr.review, pr.checks].flatMap((f) => (f && PR_FACT[f] ? [PR_FACT[f]] : []));
  return (
    <li class={`wpr${pr.source === "mentioned" ? " muted" : ""}`}>
      <a href={pr.url} target="_blank" rel="noopener noreferrer">
        <span class="wpr-num">#{pr.number}</span> {pr.title ?? pr.repo}
      </a>
      <span class="wpr-facts">
        {pr.repo} · {PR_SOURCE[pr.source]}
        {facts.map((f) => (
          <span key={f.text} class={f.cls}>
            {" · "}
            {f.text}
          </span>
        ))}
      </span>
    </li>
  );
}

/** History shown before "Show all". */
const HISTORY_SHOWN = 4;

/** A text the user edits in place: the note or the free-text wait. */
function Editor({ label, placeholder, value, busy, onSave, onCancel }: { label: string; placeholder: string; value: string; busy: boolean; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(value);
  return (
    <form
      class="wedit"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(text.trim());
      }}
    >
      <textarea class="sheet-filter" autoFocus rows={3} aria-label={label} placeholder={placeholder} value={text} onInput={(e) => setText(e.currentTarget.value)} />
      <span class="wedit-actions">
        <button type="button" class="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button class="primary" disabled={busy}>
          Save
        </button>
      </span>
    </form>
  );
}

/** How long Stop all stays armed after its first tap. */
const STOP_ARM_MS = 4_000;
/** A wait in this state is over: nothing to stop. */
const ENDED = "done";
const waitsWord = (n: number) => `${n} ${n === 1 ? "wait" : "waits"}`;

/** One session in full: where it stands, your note, what else it waits on, its PRs and what happened; the actions at the bottom. */
function Detail({ row, health, item, now, onBack, onSeen }: { row: WaitingRow; health: Health | null | undefined; item: Item | null; now: number; onBack: () => void; onSeen: () => void }) {
  const { busy, act } = useActions(row);
  const [resuming, setResuming] = useState(false);
  const [edit, setEdit] = useState<"note" | "what" | null>(null);
  const [allHistory, setAllHistory] = useState(false);
  const s = standing(row);
  // Three or more waits: the sentence counts them and the list names every one.
  const many = !row.outcome && row.ball !== "on_me" && s.rest.length >= 2;
  const waits = many ? [{ kind: s.kind, text: s.text }, ...s.rest] : s.rest;
  const snooze = snoozeTarget(row);
  const time = rowTime(row, now);
  async function save(field: "note" | "what", text: string) {
    if (await act(field, { text })) setEdit(null);
  }
  const closed = closeOf(row, health, now);
  // Stop all asks twice: the first tap arms it for a few seconds.
  const [arming, setArming] = useState(false);
  useEffect(() => {
    if (!arming) return;
    const t = setTimeout(() => setArming(false), STOP_ARM_MS);
    return () => clearTimeout(t);
  }, [arming]);
  const watched = row.waits.filter((w) => w.ball !== "on_me" && w.state !== ENDED && !row.onYou.some((o) => o.id === w.id));
  // Del is Seen, and only while something is on the user.
  useEffect(() => {
    if (!row.onYou.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" || busy || (e.target as HTMLElement | null)?.closest?.("input, textarea")) return;
      e.preventDefault();
      void act("mark-seen");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [row, busy]);
  const history = row.history.slice().reverse();
  const shown = allHistory ? history : history.slice(0, HISTORY_SHOWN);
  const where = item ? (item.parked ? "Parked in Tern" : "Open in Tern") : row.live ? "Runs outside Tern" : "Closed";
  const facts = [
    [where, row.agentState].filter(Boolean).join(", "),
    row.since ? `set aside ${age(row.since, now)} ago` : "",
    row.pinned ? "pinned" : "",
    row.size ? `size ${row.size}` : "",
  ].filter(Boolean).join(" · ");
  return (
    <>
      <div class="wd-head">
        <button class="icon-btn wd-back" aria-label="Back to Waiting" title="Back (Esc)" onClick={onBack}>
          ‹
        </button>
        <Name row={row} />
        <span class={`wrow-time ${time.cls}`}>{time.text}</span>
      </div>
      <div class={`wd-body tone-${tone(row)}`}>
        <p class="wd-state">
          <Glyph kind={s.kind} />
          <span>{many ? `Waiting on ${waits.length} things` : s.text || "When I have time"}</span>
        </p>
        {s.detail && <p class="wd-detail">{s.detail}</p>}
        {closed && <p class={`wd-detail wd-close${closed.verdict === "park" ? " t-warn" : ""}`}>{closed.text}</p>}
        {row.onYou.length > 0 && (
          <section class="wd-sec wd-onyou">
            <h4>On you</h4>
            <ul class="wd-waits">
              {row.onYou.map((o) => (
                <li key={o.id}>
                  <Glyph kind={MARK_KIND[o.mark] ?? "attention"} />
                  <span>
                    {o.label && <strong>{o.label}: </strong>}
                    {o.text}
                    {o.report && <span class="wd-report">{o.report}</span>}
                  </span>
                </li>
              ))}
            </ul>
            <button class="primary" disabled={busy} title="Close what came (Del)" onClick={() => void act("mark-seen")}>
              Seen
            </button>
          </section>
        )}

        {watched.length > 0 && (
          <details class="wd-sec wd-watch">
            <summary>Stop a wait</summary>
            <ul>
              {watched.map((w) => (
                <li key={w.id}>
                  <Glyph kind={MARK_KIND[w.mark] ?? "waiting"} />
                  <span>{w.label || w.summary}</span>
                  <button class="icon-btn wd-stop" disabled={busy} aria-label={`Stop ${w.label || w.summary}`} title="Stop this wait" onClick={() => void act("stop", { wait: w.id })}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}

        <section class="wd-sec">
          {edit === "note" ? (
            <Editor label="Your note" placeholder="Why you left it, what comes next" value={row.note ?? ""} busy={busy} onSave={(t) => void save("note", t)} onCancel={() => setEdit(null)} />
          ) : row.note ? (
            <button class="wd-note" title="Edit your note" onClick={() => setEdit("note")}>
              {row.note}
            </button>
          ) : (
            <button class="wd-add" onClick={() => setEdit("note")}>
              Add a note
            </button>
          )}
          {row.suggested && edit !== "note" && (
            <div class="wd-suggest">
              <span class="wd-suggest-text">
                <span class="muted">omp suggests </span>
                {row.suggested}
              </span>
              <button class="ghost" disabled={busy} onClick={() => void act("accept-suggested")}>
                Use it
              </button>
            </div>
          )}
        </section>

        <section class="wd-sec">
          {!many && (waits.length > 0 || (row.waitingFor && s.kind !== "manual") || edit === "what") && (
            <h4>{row.outcome ? "Still waiting on" : "Also waiting on"}</h4>
          )}
          <ul class="wd-waits">
              {waits.map((t, i) => (
                <li key={i}>
                  <Glyph kind={t.kind} />
                  <span>{t.text}</span>
                </li>
              ))}
              {row.waitingFor && s.kind !== "manual" && edit !== "what" && (
                <li>
                  <Glyph kind="manual" />
                  <button class="wd-inline" title="Edit what it waits for" onClick={() => setEdit("what")}>
                    {row.waitingFor}
                  </button>
                </li>
              )}
            </ul>
            {edit === "what" ? (
              <Editor label="Manual wait" placeholder="What it waits for, in your words (empty clears it)" value={row.waitingFor ?? ""} busy={busy} onSave={(t) => void save("what", t)} onCancel={() => setEdit(null)} />
            ) : (
              (!row.waitingFor || s.kind === "manual") && (
                <button class="wd-add" onClick={() => setEdit("what")}>
                  {row.waitingFor ? "Edit the manual wait" : "Add a manual wait"}
                </button>
              )
            )}
        </section>

        {row.nextStep && (
          <section class="wd-sec">
            <h4>Next step</h4>
            <p>{row.nextStep}</p>
          </section>
        )}

        {row.prs.length > 0 && (
          <section class="wd-sec">
            <h4>Pull requests</h4>
            <ul class="wd-prs">
              {row.prs.map((pr) => (
                <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} />
              ))}
            </ul>
          </section>
        )}

        {history.length > 0 && (
          <section class="wd-sec">
            <h4>What happened</h4>
            <ol class="wd-history">
              {shown.map((h, i) => (
                <li key={i} class={h.fired ? "fired" : ""}>
                  <time>{h.at ? clock(h.at, now) : ""}</time>
                  <span>{h.text}</span>
                </li>
              ))}
            </ol>
            {history.length > HISTORY_SHOWN && (
              <button class="wd-add" onClick={() => setAllHistory(!allHistory)}>
                {allHistory ? "Show fewer" : `Show all ${history.length}`}
              </button>
            )}
          </section>
        )}

        {row.recap && (
          <details class="wd-sec wd-recap">
            <summary>
              {row.recapStale ? "omp's earlier recap" : "omp's recap"}
              {row.recapAt ? <span class="muted">, {age(row.recapAt, now)} ago</span> : null}
            </summary>
            <p>{row.recap}</p>
          </details>
        )}

        <p class="wd-facts">{facts}</p>
      </div>
      <div class="wd-bar">
        {item ? (
          <a class="primary" href={`#/b/${item.block}`} onClick={onSeen}>
            Open
          </a>
        ) : (
          row.session !== null &&
          !row.live && (
            <button
              class="primary"
              title="Resume in a new Tern tab"
              disabled={resuming}
              onClick={async () => {
                onSeen();
                setResuming(true);
                await launchAgent("/api/closed/resume", { id: row.session, agent: "omp" });
                setResuming(false);
              }}
            >
              Resume
            </button>
          )
        )}
        {snooze && (
          <button class="ghost" disabled={busy} title={`Snooze: ${snooze.label || snooze.summary}`} onClick={() => void act("snooze", { wait: snooze.id })}>
            Snooze 1d
          </button>
        )}
        {row.stoppable > 0 && (
          <button
            class={`ghost wd-stop-all${arming ? " t-warn" : ""}`}
            disabled={busy}
            onClick={() => {
              if (!arming) return setArming(true);
              setArming(false);
              void act("stop", { all: true });
            }}
          >
            {arming ? `Press again to stop ${waitsWord(row.stoppable)}` : `Stop ${waitsWord(row.stoppable)}…`}
          </button>
        )}
      </div>
    </>
  );
}

/**
 * The popup over the list (`#/waiting`, one session in full at `#/waiting/<id>`): a full-height
 * sheet on a phone, a dialog on the desktop. Escape clears the filter, then goes back a level;
 * × and a tap beside it close.
 */
export function WaitingPopup({ waiting, card = null, items, onClose }: { waiting: Waiting | null; card?: string | null; items: Item[]; onClose: () => void }) {
  const now = useNow(15_000);
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const rows = waiting?.available ? waiting.rows : [];
  const groups = groupRows(rows, q);
  const open = card === null ? undefined : rows.find((r) => rowId(r) === card);
  /** The rows marked seen from here, so a re-render doesn't post again; dropped once the row is seen. */
  const seenSent = useRef(new Set<string>());
  function markSeen(row: WaitingRow) {
    if (!row.unseen || row.session === null || seenSent.current.has(row.session)) return;
    seenSent.current.add(row.session);
    // A failure here only leaves the row bold.
    void post("/api/waiting/seen", { session: row.session });
  }
  // A row seen since can come unseen again: its next look marks it again.
  useEffect(() => {
    for (const r of rows) if (!r.unseen && r.session !== null) seenSent.current.delete(r.session);
  }, [waiting]);
  // Opening a session is a look at what happened.
  useEffect(() => {
    if (open) markSeen(open);
  }, [open]);
  const back = () => goBack({ view: "waiting", id: card ?? undefined });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (card !== null) back();
      else if (q || searching) {
        setQ("");
        setSearching(false);
      } else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [q, searching, card, onClose]);
  // A closed session's notification has no session to open: the rows here are what it announced.
  // Rechecked after the lookups: the page may have gone to the background, or a newer view come.
  useEffect(() => {
    if (!waiting?.available || document.visibilityState !== "visible" || !("serviceWorker" in navigator)) return;
    let current = true;
    void navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.getNotifications())
      .then((notifications) => {
        if (!current || document.visibilityState !== "visible") return;
        for (const n of notifications ?? []) if (n.tag.startsWith("w")) n.close();
      })
      .catch(() => {});
    return () => void (current = false);
  }, [waiting]);
  const onMe = tally(waiting)?.onMe ?? 0;
  return (
    <div class="sheet-backdrop wait-backdrop" onClick={onClose}>
      <div class="sheet wait-sheet" role="dialog" aria-modal="true" aria-label="Waiting" onClick={(e) => e.stopPropagation()}>
        {open ? (
          <Detail key={card} row={open} health={waiting?.available ? waiting.health : null} item={blockOf(items, open)} now={now} onBack={back} onSeen={() => markSeen(open)} />
        ) : (
          <>
            <div class="wait-head">
              <span class="wait-head-title">Waiting</span>
              {rows.length > 0 && (
                <span class="wait-head-count">
                  {onMe > 0 ? <span class="t-warn">{onMe} on you</span> : "nothing on you"}, {rows.length} set aside
                </span>
              )}
              <span class="spacer" />
              {rows.length > 0 && (
                <button class={`icon-btn${searching ? " on" : ""}`} aria-label="Filter" title="Filter" onClick={() => (searching ? (setSearching(false), setQ("")) : setSearching(true))}>
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <circle cx="8.8" cy="8.8" r="5" fill="none" stroke="currentColor" stroke-width="1.5" />
                    <path d="m12.6 12.6 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                  </svg>
                </button>
              )}
              <button class="icon-btn wait-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
                ×
              </button>
            </div>
            {searching && (
              <input
                class="sheet-filter"
                type="search"
                autoFocus
                placeholder="Filter by title, note, project or wait"
                aria-label="Filter waits"
                value={q}
                onInput={(e) => setQ(e.currentTarget.value)}
              />
            )}
            <div class="sheet-list wait-list">
              {!waiting && <div class="empty">Connecting…</div>}
              {waiting && !waiting.available && <div class="empty">Waiting needs CodexBar AgentView on the desktop.</div>}
              {waiting?.available && waiting.error && <div class="wait-error">Couldn't refresh the list ({waiting.error}).</div>}
              {waiting?.available && !rows.length && !waiting.error && <div class="empty">Nothing is set aside. Ctrl+Alt+B in Tern sets a session aside.</div>}
              {card !== null && waiting?.available && !open && <div class="empty">That session isn't set aside any more.</div>}
              {rows.length > 0 && !groups.length && (
                <div class="empty">
                  No wait matches.{" "}
                  <button class="ghost" onClick={() => setQ("")}>
                    Clear
                  </button>
                </div>
              )}
              {groups.map((g) => (
                <section key={g.ball} class={`wait-group g-${g.ball}`}>
                  <h3>
                    {g.label} <span class="wait-group-count">{g.rows.length}</span>
                  </h3>
                  <ul>
                    {g.rows.map((r) => (
                      <Row key={rowId(r)} row={r} health={waiting?.available ? waiting.health : null} now={now} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
