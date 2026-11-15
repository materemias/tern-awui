// An open session (chat, raw screen or note, with the composer) and its subagent screens.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { highlightFile } from "./highlight";
import { post, type ApprovalView, type ChatEntry, type Item, type Run, type TodoPhase } from "./api";
import { age, backStep, can, elapsed, isNote, pickedTernSession, readPatch, routeHash, storedTernSession, swipeOrder, todoSummary, type Route } from "./lib";
import { ANSWER_TAKEN_MS, Chat, Markdown, StretchContext, type StretchSync } from "./chat";
import { liveText, withOpen } from "./stretch";
import { screenHtml } from "./markdown";
import { buzz, Dot, PiMark } from "./parts";
import { ExtensionNotice } from "./extension";
import { JobsStrip, SubagentChat, SubagentList } from "./subagents";
import { storedCollapsed, storedHideOld, Title } from "./home";
import { Composer } from "./composer";
import { goBack, origins, swipeTrail, useNow, useStream, useWide, type View } from "./hooks";
import { SwipeNav, type Siblings } from "./swipe";

export function Session({ block }: { block: string }) {
  const [view, setView] = useState<View>("chat");
  // The server answers a chat request for a non-omp block with its screen.
  const { state, chat, live, queued, run, context, btw, setBtw, screen, draft, doc, online, stretch, voice, approval } = useStream(block, view);
  // Open stretches: the omp session's (stretch.ts) when it reports them, else this page's own.
  const [opened, setOpened] = useState<Record<string, string[]>>({});
  // Whether `opened` mirrors the pane: then losing the report (omp restarted without stretch.ts) drops
  // it, while taps made with no pane state stay this page's own.
  const mirrored = useRef(false);
  useEffect(() => {
    mirrored.current = false;
    setOpened({});
  }, [block]);
  useEffect(() => {
    if (stretch) setOpened(stretch.open);
    else if (mirrored.current) setOpened({});
    mirrored.current = stretch !== null;
  }, [stretch]);
  const stretchSync = useMemo<StretchSync>(
    () => ({
      open: opened,
      off: stretch?.off === true,
      set: (reply, key, open) => {
        setOpened((o) => ({ ...o, [reply]: withOpen(o[reply] ?? [], key, open) }));
        // The pane opens it too; its next report confirms. A failure leaves it open here only.
        if (stretch) void post(`/api/blocks/${block}/stretch`, { block: reply, key, open });
      },
      answers: stretch?.answers,
      running: stretch?.running,
      // ✦ runs in the pane: its reports bring the twinkle, the streaming answer and the answer.
      press: stretch?.deepen ? (reply, key) => void post(`/api/blocks/${block}/stretch`, { block: reply, key, deepen: true }) : undefined,
    }),
    [opened, stretch, block],
  );
  const item = state?.projects.flatMap((p) => p.items).find((i) => i.block === block);
  const isOmp = !!item?.agent;
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const glide = useRef<Glide | null>(null);
  // Jump to latest shows only once the reader has scrolled up from the end; its dot, once output
  // arrived meanwhile.
  const [atEnd, setAtEnd] = useState(true);
  const [unread, setUnread] = useState(false);
  const now = useNow(5000);
  // Only the working row reads it, while the session works.
  const todo = useMemo(() => newestTodo(chat), [chat]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat, live, queued, screen, view]);
  // Output arriving while the reader is scrolled up lights the jump button's dot; reaching the end
  // clears it. Only growth counts: a reconnect's same snapshot, the live text clearing or a rewind
  // bring nothing new.
  const seen = useRef({ entries: 0, last: 0, live: 0 });
  useEffect(() => {
    const last = chat?.[chat.length - 1];
    const size = { entries: chat?.length ?? 0, last: last ? JSON.stringify(last).length : 0, live: live ? liveText(live).length : 0 };
    const was = seen.current;
    seen.current = size;
    const grew = size.entries > was.entries || (size.entries === was.entries && size.last > was.last) || size.live > was.live;
    if (grew && !pinned.current) setUnread(true);
  }, [chat, live]);
  useEffect(() => {
    if (atEnd) setUnread(false);
  }, [atEnd]);
  // Anything else that grows the bottom (the working row, subagent jobs, images loading, an
  // answer card) keeps a reader at the bottom there too: each child's size is watched, and the
  // watch follows children coming and going. A prompt jump in flight is left to finish.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const follow = () => {
      if (pinned.current && !gliding(glide.current, el)) el.scrollTop = el.scrollHeight;
      setAtEnd(nearEnd(el));
    };
    const sizes = new ResizeObserver(follow);
    const watch = () => {
      sizes.disconnect();
      sizes.observe(el);
      for (const child of el.children) sizes.observe(child);
    };
    const children = new MutationObserver(() => {
      watch();
      follow();
    });
    watch();
    children.observe(el, { childList: true });
    return () => {
      sizes.disconnect();
      children.disconnect();
    };
  }, []);

  const shownState = item?.status ?? undefined;
  const working = shownState === "working";
  // The sessions a sideways swipe and its wheel step through, read when a gesture starts: the
  // list's order as this device shows it, plus this session and any a run of swipes passed.
  const siblings = (): Siblings => {
    const order = state
      ? swipeOrder(state.projects, {
          hideOld: storedHideOld(),
          collapsed: storedCollapsed(),
          now: Date.now(),
          keep: new Set([...swipeTrail, block]),
          session: pickedTernSession(state.ternSessions, storedTernSession()),
        })
      : [];
    return {
      items: order.map((i) => ({ href: routeHash({ view: "session", block: i.block }), label: <SessionLabel item={i} /> })),
      index: order.findIndex((i) => i.block === block),
    };
  };
  return (
    <SwipeNav siblings={siblings}>
    <div class="screen">
      <header class="bar session-bar">
        <a
          class="back"
          href="#/"
          title="Back"
          aria-label="Back"
          onClick={(e) => {
            e.preventDefault();
            goBack({ view: "session", block });
          }}
        >
          ‹
        </a>
        <div class="session-title">
          {item ? <Title item={item} /> : <div class="row-title">{block}</div>}
          <div class="row-meta">
            {!(item?.doc && !shownState) && <Dot state={shownState} />}
            <span>{shownState ?? (item?.doc ? (isNote(item.doc) ? "note" : "file") : "shell")}</span>
            {item?.status && <span class="muted">{age(item.since, now)}</span>}
            {item && <span class="muted">{item.project}</span>}
            {item?.branch && (
              <span class="branch" title="git branch">
                {"\u{e0a0}"} {item.branch}
              </span>
            )}
            {item?.parked && <span class="muted">parked</span>}
            {!online && <span class="c-blocked">offline</span>}
          </div>
        </div>
        <SessionMenu block={block} item={item} />
        {item && (
          <button
            class="icon-btn danger"
            title="Close this block"
            aria-label="Close this block"
            onClick={async () => {
              const name = `${item.tag ? `${item.tag}: ` : ""}${item.title}`;
              const warn = working ? "\n\nIt is working right now; the running turn stops." : shownState === "blocked" ? "\n\nIt is waiting on you." : "";
              if (!confirm(`Close “${name}”?\n\nThis closes it in Tern on the desktop too.${warn}`)) return;
              const err = await post(`/api/blocks/${block}/close`, {});
              if (err) alert(`Close failed: ${err}`);
              else if (location.hash === `#/b/${block}`) goBack({ view: "session", block });
            }}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>
        )}
      </header>
      {item && state && <ExtensionNotice item={item} install={state.extension} />}
      <div class="scroll-wrap">
        <div
          class="scroll"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            setAtEnd(nearEnd(el));
            // Mid-glide the position says nothing about following: the jump decided that.
            if (gliding(glide.current, el)) return;
            glide.current = null;
            pinned.current = nearEnd(el);
          }}
        >
          {isOmp && view === "screen" && (
            <button class="raw-note" onClick={() => setView("chat")}>
              Raw screen · back to chat
            </button>
          )}
          {state && !item && <div class="empty">This block is gone.</div>}
          {item?.doc ? (
            doc ? (
              doc.missing ? (
                <div class="empty">The file is gone.</div>
              ) : doc.markdown ? (
                <Markdown class="msg md doc" text={doc.text} imageSources={doc.imageSources} highlight />
              ) : (
                <FileText text={doc.text} path={item.doc} />
              )
            ) : (
              <div class="empty">Loading…</div>
            )
          ) : chat && view === "chat" ? (
            <>
              <StretchContext.Provider value={stretchSync}>
                {/* omp's welcome mark heads the chat, as it heads the session's pane in Tern; the first turn follows right below. */}
                <div class="welcome">
                  {/* Touch screens have no hover: a tap plays π's stomp and wiggle instead (style.css). */}
                  <span class="omp-play" onClick={replayOmp} onAnimationEnd={(e) => (e.target as Element).classList.contains("omp-logo") && e.currentTarget.classList.remove("tap")}>
                    <PiMark />
                  </span>
                  <span class="welcome-name">omp</span>
                </div>
                <Chat entries={chat} block={block} rewind={can(item?.live, "rewind")} working={shownState === "working" || shownState === "blocked" ? true : shownState === "idle" ? false : undefined} />
              </StretchContext.Provider>
              {live && <Markdown class="msg assistant md live" mermaid={false} text={liveText(live)} />}
              {queued.map((q, i) => (
                <div key={i} class="queued" title={q.followUp ? "Sent once the running turn ends" : "Steers the running turn"}>
                  <span class="queued-mark">{q.followUp ? "→" : "↳"}</span>
                  <span class="queued-text">{q.text}</span>
                </div>
              ))}
              {approval && <ApprovalCard key={approval.id} block={block} approval={approval} />}
            </>
          ) : screen != null ? (
            screen.html ? (
              // Tern's colored capture: <pre> and styled <span>s; scripts and links are stripped.
              <div class="term" dangerouslySetInnerHTML={{ __html: screenHtml(screen.text) }} />
            ) : (
              <pre class="term">{screen.text}</pre>
            )
          ) : (
            <div class="empty">Loading…</div>
          )}
          {doc?.clipped && <div class="muted small">Showing the first 512 KB.</div>}
          {working && item && <WorkingRow run={run} since={item.since} todo={todo} onTodo={() => jumpTodo(scroller.current, glide, pinned)} />}
          {item && <JobsStrip block={block} jobs={item.live?.jobs ?? []} subagents={item.agent?.subagents ?? 0} now={now} />}
        </div>
        {!item?.doc && chat && view === "chat" && !atEnd && (
          <JumpButtons
            unread={unread}
            onLatest={() => scroller.current && glideTo(scroller.current, scroller.current.scrollHeight - scroller.current.clientHeight, glide, pinned)}
            onPrevious={() => jumpPrevPrompt(scroller.current, glide, pinned)}
          />
        )}
      </div>
      {!item?.doc && (
        <Composer
          block={block}
          item={item}
          draft={draft}
          roles={state?.roles ?? []}
          btw={btw}
          voice={voice}
          setBtw={setBtw}
          raw={isOmp ? { on: view === "screen", toggle: () => setView(view === "screen" ? "chat" : "screen") } : undefined}
          context={context}
        />
      )}
    </div>
    </SwipeNav>
  );
}

/** A sibling session as a swipe's gap and wheel show it: its title, status and project. */
function SessionLabel({ item }: { item: Item }) {
  return (
    <>
      <Title item={item} />
      <div class="row-meta">
        <Dot state={item.status ?? undefined} />
        <span class="muted small">{item.project}</span>
      </div>
    </>
  );
}

/** Restarts the welcome π's animation: drop the class, force a style flush, set it again. */
function replayOmp(e: { currentTarget: HTMLElement }) {
  const el = e.currentTarget;
  el.classList.remove("tap");
  void el.offsetWidth;
  el.classList.add("tap");
}

/** The newest todo list in a chat, or null when it has none. */
function newestTodo(chat: ChatEntry[] | null): TodoPhase[] | null {
  if (!chat) return null;
  for (let i = chat.length - 1; i >= 0; i--) {
    const e = chat[i];
    if (e.role === "tools" && e.todo) return e.todo;
  }
  return null;
}

/**
 * omp's working row: a spinner, the turn's running time and what its current tool call is doing,
 * swept by a highlight. Without the turn's report (older extension) it counts from the status change.
 * With an unfinished todo list it ends in the list's progress and the task under way (else the next
 * one); a tap there leads to the list (`onTodo`).
 */
function WorkingRow({ run, since, todo, onTodo }: { run: Run | null; since: number; todo: TodoPhase[] | null; onTodo: () => void }) {
  const start = run?.since ?? since;
  // Tenths tick under a minute, as in omp; whole seconds after.
  const now = useNow(Date.now() - start < 60_000 ? 100 : 1000);
  const tasks = todo?.flatMap((p) => p.tasks) ?? [];
  const step = tasks.find((t) => t.status === "in_progress") ?? tasks.find((t) => t.status === "pending") ?? tasks.find((t) => t.status !== "completed");
  const { done, total } = todoSummary(todo ?? []);
  return (
    // No live region: a clock ticking ten times a second would flood screen readers.
    <div class="working-row">
      <span class="spinner" aria-hidden="true" />
      <span class="working-time">{elapsed(now - start)}</span>
      <span aria-hidden="true">·</span>
      <span class="working-intent">{run?.intent || "Working…"}</span>
      {step && (
        <button type="button" class="working-todo" title="Show the todo list" onClick={onTodo}>
          <span class="working-todo-count">
            {done}/{total}
          </span>
          <span aria-hidden="true">·</span>
          <span class="working-todo-task">{step.content}</span>
        </button>
      )}
    </div>
  );
}

/** Arguments that are the substance of a call: always shown whole, as a block. */
const BODY_ARGS: Record<string, true> = { command: true, code: true, content: true, input: true, html: true };

/**
 * omp's tool approval dialog: which tool, why omp asks, and exactly what the call does, then Deny
 * and Approve (once). An `edit` patch reads as its file and steps in words, with the lines it
 * writes. An answer stays pending until omp closes its dialog, which drops the card.
 */
function ApprovalCard({ block, approval }: { block: string; approval: ApprovalView }) {
  const [sending, setSending] = useState<"allow" | "deny" | null>(null);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Sent, but omp's dialog stayed open: the keys didn't reach it.
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => {
      setSent(false);
      setSending(null);
      setError("omp hasn't taken the answer: check the Tern pane.");
    }, ANSWER_TAKEN_MS);
    return () => clearTimeout(timer);
  }, [sent]);
  async function answer(allow: boolean) {
    setSending(allow ? "allow" : "deny");
    setError(null);
    const err = await post(`/api/blocks/${block}/approve`, { id: approval.id, allow });
    if (err) {
      setSending(null);
      setError(err);
    } else {
      buzz();
      setSent(true);
    }
  }
  return (
    <section class="approval" aria-label={`Allow ${approval.tool}?`}>
      <h3 class="approval-title">
        Allow <code class="approval-tool">{approval.tool}</code>?
      </h3>
      {approval.reason && <p class="approval-reason">{approval.reason}</p>}
      {!approval.args && <p class="err small">The transcript doesn't show what this call does. Check it in the Tern pane before approving.</p>}
      {approval.args?.map(({ key, value }) =>
        approval.tool === "edit" && key === "input" ? (
          <div key={key} class="approval-patch">
            {readPatch(value).map((l, i) => (
              <div key={i} class={`patch-${l.kind}`}>
                {l.text || "\u00a0"}
              </div>
            ))}
          </div>
        ) : BODY_ARGS[key] || value.includes("\n") || value.length > 72 ? (
          <div key={key} class="approval-arg">
            <div class="approval-key">{key}</div>
            <pre class="approval-body">{value}</pre>
          </div>
        ) : (
          <div key={key} class="approval-arg approval-inline">
            <span class="approval-key">{key}</span>
            <code>{value}</code>
          </div>
        ),
      )}
      {error && <div class="err small">{error}</div>}
      <div class="approval-actions">
        <button class="approval-deny" type="button" disabled={sending !== null} onClick={() => void answer(false)}>
          {sending === "deny" ? "Denying…" : "Deny"}
        </button>
        <button class="approval-allow" type="button" disabled={sending !== null || !approval.args} onClick={() => void answer(true)}>
          {sending === "allow" ? "Approving…" : "Approve once"}
        </button>
      </div>
      <p class="approval-hint">A reply below also denies it, and steers omp.</p>
    </section>
  );
}

/** Glides `scroller` to the chat's newest todo list, opening it if a tap had folded it. */
function jumpTodo(scroller: HTMLElement | null, glide: { current: Glide | null }, pinned: { current: boolean }) {
  const list = scroller?.querySelector<HTMLElement>(".todo[data-newest]");
  if (!scroller || !list) return;
  if (!list.querySelector(".todo-phase")) list.click();
  const max = scroller.scrollHeight - scroller.clientHeight;
  glideTo(scroller, Math.min(max, Math.max(0, list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - JUMP_GAP)), glide, pinned);
}

/**
 * Glides `scroller` to `top`. Only a glide to the end keeps following new output: otherwise a live
 * update would snap the glide back down.
 */
function glideTo(scroller: HTMLElement, top: number, glide: { current: Glide | null }, pinned: { current: boolean }) {
  glide.current = { top, at: performance.now() };
  pinned.current = top >= scroller.scrollHeight - scroller.clientHeight - 2;
  scroller.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

/** Air left above a prompt jumped to. */
const JUMP_GAP = 8;
/** A prompt jump under way: where it is headed, and when it started. */
type Glide = { top: number; at: number };
/** A glide not arrived after this long counts as over (a hand on the screen stopped it). */
const GLIDE_MAX_MS = 1500;

/** Within this many pixels of the end, a reader counts as at the end and is kept there. */
const END_SLACK = 80;

function nearEnd(scroller: HTMLElement): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < END_SLACK;
}

function gliding(glide: Glide | null, scroller: HTMLElement): glide is Glide {
  return !!glide && Math.abs(scroller.scrollTop - glide.top) > 2 && performance.now() - glide.at < GLIDE_MAX_MS;
}

/** Glides `scroller` to the prompt above the one at its top; before the first, to the top. */
function jumpPrevPrompt(scroller: HTMLElement | null, glide: { current: Glide | null }, pinned: { current: boolean }) {
  if (!scroller) return;
  const max = scroller.scrollHeight - scroller.clientHeight;
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const tops = [...scroller.querySelectorAll<HTMLElement>(".msg.user")].map((el) => Math.min(max, Math.max(0, el.getBoundingClientRect().top - base - JUMP_GAP)));
  // Repeated presses step on from the pending target: the glide's midpoint would land on the same prompt again.
  const at = gliding(glide.current, scroller) ? glide.current.top : scroller.scrollTop;
  glideTo(scroller, tops.findLast((t) => t < at - 2) ?? 0, glide, pinned);
}

/**
 * The chat's floating buttons, there once the reader has scrolled up from the end. ↑ steps back to
 * the previous prompt; ↓ glides to the newest output and follows it again, and a dot marks output
 * that arrived meanwhile.
 */
function JumpButtons({ unread, onLatest, onPrevious }: { unread: boolean; onLatest: () => void; onPrevious: () => void }) {
  return (
    <div class="jump-btns">
      <button type="button" class="jump-prev" title="Previous prompt" aria-label="Previous prompt" onClick={onPrevious}>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button type="button" class="jump-latest" title="Jump to latest" aria-label={unread ? "Jump to latest, new output below" : "Jump to latest"} onClick={onLatest}>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 4.5v11M5.5 11 10 15.5 14.5 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        {unread && <span class="jump-dot" aria-hidden="true" />}
      </button>
    </div>
  );
}

/**
 * The pane actions that ask nothing: Park (or Unpark) and Show on desktop. On the wide desktop
 * layout, with room to spare, they are icon buttons beside Close; on the phone they sit in a ⋯ menu,
 * so the title keeps the width. A tap outside or Escape closes the menu; ↑/↓ move between its rows.
 */
function SessionMenu({ block, item }: { block: string; item: Item | undefined }) {
  const wide = useWide();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const rows = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
        const at = rows.indexOf(document.activeElement as HTMLElement);
        rows[(at + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
      } else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open]);
  // Files and notes vanish from `tern ls` once parked, so only programs' panes get Park.
  const park = item && !item.doc ? item : null;
  // A parked pane is in no tab, so the desktop can't show it until it is unparked.
  const show = !item?.parked;
  if (!park && !show) return null;
  const actions = [
    park && {
      label: park.parked ? "Unpark" : "Park",
      title: park.parked ? "Back into a tab of its own in Tern" : "Put it away in Tern, still running",
      // Lit while the pane is parked.
      on: park.parked,
      run: async () => {
        const action = park.parked ? "unpark" : "park";
        const err = await post(`/api/blocks/${block}/${action}`, {});
        if (err) alert(`${park.parked ? "Unpark" : "Park"} failed: ${err}`);
        // Parked, it leaves the list: back there, as after Close.
        else if (action === "park" && location.hash === `#/b/${block}`) goBack({ view: "session", block });
      },
      // A parking sign.
      icon: (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="3" y="3" width="14" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M8.2 14V6h2.6a2.3 2.3 0 0 1 0 4.6H8.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      ),
    },
    show && {
      label: "Show on desktop",
      title: "Show this pane in Tern on the desktop",
      run: () => void post(`/api/blocks/${block}/focus`, {}),
      on: false,
      // A monitor with an arrow out of its corner, like an "open elsewhere" link.
      icon: (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10.5 3.5H4.3a1.8 1.8 0 0 0-1.8 1.8v6.4a1.8 1.8 0 0 0 1.8 1.8h11.4a1.8 1.8 0 0 0 1.8-1.8V9.5M7 17h6M10 13.5V17" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M8 10.5 15.5 3M11.5 3h4v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      ),
    },
  ].filter((a) => !!a);
  if (wide)
    return (
      <>
        {actions.map((a) => (
          <button key={a.label} type="button" class={`icon-btn${a.on ? " on" : ""}`} aria-label={a.label} title={`${a.label}: ${a.title}`} onClick={() => void a.run()}>
            {a.icon}
          </button>
        ))}
      </>
    );
  return (
    <span class="session-more">
      <button
        ref={button}
        type="button"
        class={`icon-btn${open ? " on" : ""}`}
        aria-label="More actions"
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="4.5" cy="10" r="1.6" fill="currentColor" />
          <circle cx="10" cy="10" r="1.6" fill="currentColor" />
          <circle cx="15.5" cy="10" r="1.6" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <>
          <div class="menu-scrim" onClick={() => setOpen(false)} />
          <div class="session-menu" role="menu" ref={menu}>
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                class="sheet-row"
                role="menuitem"
                title={a.title}
                onClick={() => {
                  setOpen(false);
                  void a.run();
                }}
              >
                {a.icon}
                <span>{a.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

/** A plain file, colored by its extension once the highlighter loads; plain until then. */
function FileText({ text, path }: { text: string; path: string }) {
  const [colored, setColored] = useState<{ text: string; path: string; html: string } | null>(null);
  useEffect(() => {
    let current = true;
    highlightFile(text, path)
      .then((html) => current && setColored(html === null ? null : { text, path, html }))
      .catch(() => {});
    return () => void (current = false);
  }, [text, path]);
  if (colored?.text === text && colored.path === path) return <pre class="term hljs" dangerouslySetInnerHTML={{ __html: colored.html }} />;
  return <pre class="term">{text}</pre>;
}

/**
 * Each session's subagent names in the order its subagent list last showed them. Swipes between
 * subagent chats keep that order while the list re-sorts as running ones finish; subagents started
 * since are added at the end.
 */
const subagentOrder = new Map<string, string[]>();

/** A session's subagent list, or one subagent's chat; both read-only. A chat swipes to its siblings. */
export function SubagentScreen({ route }: { route: Extract<Route, { view: "subagents" | "subagent" }> }) {
  const sub = route.view === "subagent" ? route.name : null;
  const { state, chat, subagents, online } = useStream(route.block, sub ? "chat" : "subagents", sub);
  const item = state?.projects.flatMap((p) => p.items).find((i) => i.block === route.block);
  const now = useNow(5000);
  const [names, setNames] = useState(() => subagentOrder.get(route.block) ?? null);
  useEffect(() => {
    if (subagents) subagentOrder.set(route.block, subagents.map((s) => s.name));
  }, [subagents, route.block]);
  // Each chat asks once for subagents the order doesn't have yet (opened by a link or a reload, or
  // started since the list was seen); those it has keep their places.
  useEffect(() => {
    if (!sub) return;
    let current = true;
    fetch(`/api/blocks/${route.block}/subagents`, { signal: AbortSignal.timeout(5000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { subagents?: unknown } | null) => {
        if (!current || !Array.isArray(d?.subagents)) return;
        const known = subagentOrder.get(route.block) ?? [];
        const fresh = d.subagents.map((s: { name?: unknown } | null) => s?.name).filter((n): n is string => typeof n === "string" && !known.includes(n));
        if (!fresh.length) return;
        const list = [...known, ...fresh];
        subagentOrder.set(route.block, list);
        setNames(list);
      })
      .catch(() => {});
    return () => void (current = false);
  }, [sub, route.block]);
  const screen = { block: route.block, item, online, now, backHref: backStep(origins, route).target, onBack: () => goBack(route) };
  if (!sub) return <SubagentList {...screen} list={subagents} />;
  const order = names ?? [];
  const siblings = (): Siblings => ({
    items: order.map((name) => ({
      href: routeHash({ view: "subagent", block: route.block, name }),
      label: (
        <div class="row-title">
          <span class="sub-mark">⑂</span>
          <span class="title">{name}</span>
        </div>
      ),
    })),
    index: order.indexOf(sub),
  });
  return (
    <SwipeNav siblings={siblings}>
      <SubagentChat {...screen} name={sub} entries={chat} />
    </SwipeNav>
  );
}
