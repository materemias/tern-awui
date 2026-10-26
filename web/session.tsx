// An open session (chat, raw screen or note, with the composer) and its subagent screens.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { highlightFile } from "./highlight";
import { post, type Run } from "./api";
import { age, backStep, can, elapsed, isNote, type Route } from "./lib";
import { Chat, Markdown, StretchContext, type StretchSync } from "./chat";
import { liveText, withOpen } from "./stretch";
import { screenHtml } from "./markdown";
import { Dot, PiMark } from "./parts";
import { ExtensionNotice } from "./extension";
import { JobsStrip, SubagentChat, SubagentList } from "./subagents";
import { Title } from "./home";
import { Composer } from "./composer";
import { goBack, origins, useNow, useStream, type View } from "./hooks";

export function Session({ block }: { block: string }) {
  const [view, setView] = useState<View>("chat");
  // The server answers a chat request for a non-omp block with its screen.
  const { state, chat, live, queued, run, context, btw, setBtw, screen, draft, doc, online, stretch } = useStream(block, view);
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
  const now = useNow(5000);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat, live, queued, screen, view]);
  // Anything else that grows the bottom (the working row, subagent jobs, images loading, an
  // answer card) keeps a reader at the bottom there too: each child's size is watched, and the
  // watch follows children coming and going. A prompt jump in flight is left to finish.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const follow = () => {
      if (pinned.current && !gliding(glide.current, el)) el.scrollTop = el.scrollHeight;
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
  return (
    <div class="screen">
      <header class="bar session-bar">
        <a
          class="back"
          href="#/"
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
            {!online && <span class="c-blocked">offline</span>}
          </div>
        </div>
        <button class="icon-btn" title="Show this pane on the desktop" aria-label="Show this pane on the desktop" onClick={() => post(`/api/blocks/${block}/focus`, {})}>
          {/* A monitor with an arrow out of its corner, like an "open elsewhere" link: show this pane at the desk. */}
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10.5 3.5H4.3a1.8 1.8 0 0 0-1.8 1.8v6.4a1.8 1.8 0 0 0 1.8 1.8h11.4a1.8 1.8 0 0 0 1.8-1.8V9.5M7 17h6M10 13.5V17" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M8 10.5 15.5 3M11.5 3h4v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
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
            // Mid-glide the position says nothing about following: jumpTurn decided that.
            if (gliding(glide.current, el)) return;
            glide.current = null;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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
                <Markdown class="msg md doc" text={doc.text} highlight />
              ) : (
                <FileText text={doc.text} path={item.doc} />
              )
            ) : (
              <div class="empty">Loading…</div>
            )
          ) : chat && view === "chat" ? (
            <>
              <StretchContext.Provider value={stretchSync}>
                {chat.length || live || queued.length || working ? (
                  <Chat entries={chat} block={block} rewind={can(item?.live, "rewind")} />
                ) : (
                  <div class="welcome">
                    <span class="omp-play">
                      <PiMark />
                    </span>
                    <span class="welcome-name">omp</span>
                  </div>
                )}
              </StretchContext.Provider>
              {live && <Markdown class="msg assistant md live" mermaid={false} text={liveText(live)} />}
              {queued.map((q, i) => (
                <div key={i} class="queued" title={q.followUp ? "Sent once the running turn ends" : "Steers the running turn"}>
                  <span class="queued-mark">{q.followUp ? "→" : "↳"}</span>
                  <span class="queued-text">{q.text}</span>
                </div>
              ))}
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
          {working && item && <WorkingRow run={run} since={item.since} />}
          {item && <JobsStrip block={block} jobs={item.live?.jobs ?? []} subagents={item.agent?.subagents ?? 0} now={now} />}
        </div>
        {!item?.doc && chat && view === "chat" && (
          <div class="turn-jump">
            <button title="Previous prompt" aria-label="Previous prompt" onClick={() => jumpTurn(scroller.current, -1, glide, pinned)}>
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <button title="Next prompt, else the end" aria-label="Next prompt, else the end" onClick={() => jumpTurn(scroller.current, 1, glide, pinned)}>
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M10 4.5v11M5.5 11 10 15.5 14.5 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
        )}
      </div>
      {!item?.doc && (
        <Composer
          block={block}
          item={item}
          draft={draft}
          roles={state?.roles ?? []}
          btw={btw}
          setBtw={setBtw}
          raw={isOmp ? { on: view === "screen", toggle: () => setView(view === "screen" ? "chat" : "screen") } : undefined}
          context={context}
        />
      )}
    </div>
  );
}

/**
 * omp's working row: a spinner, the turn's running time and what its current tool call is doing,
 * swept by a highlight. Without the turn's report (older extension) it counts from the status change.
 */
function WorkingRow({ run, since }: { run: Run | null; since: number }) {
  const start = run?.since ?? since;
  // Tenths tick under a minute, as in omp; whole seconds after.
  const now = useNow(Date.now() - start < 60_000 ? 100 : 1000);
  return (
    // No live region: a clock ticking ten times a second would flood screen readers.
    <div class="working-row">
      <span class="spinner" aria-hidden="true" />
      <span class="working-time">{elapsed(now - start)}</span>
      <span aria-hidden="true">·</span>
      <span class="working-intent">{run?.intent || "Working…"}</span>
    </div>
  );
}

/** Air left above a prompt jumped to. */
const JUMP_GAP = 8;
/** A prompt jump under way: where it is headed, and when it started. */
type Glide = { top: number; at: number };
/** A glide not arrived after this long counts as over (a hand on the screen stopped it). */
const GLIDE_MAX_MS = 1500;

function gliding(glide: Glide | null, scroller: HTMLElement): glide is Glide {
  return !!glide && Math.abs(scroller.scrollTop - glide.top) > 2 && performance.now() - glide.at < GLIDE_MAX_MS;
}

/**
 * Glides `scroller` to the previous (`-1`) or next (`1`) prompt above or below the one at its
 * top; past the last prompt, to the end, and before the first, to the top. Only a glide to the
 * end keeps following new output: otherwise a live update would snap the glide back down.
 */
function jumpTurn(scroller: HTMLElement | null, dir: -1 | 1, glide: { current: Glide | null }, pinned: { current: boolean }) {
  if (!scroller) return;
  const max = scroller.scrollHeight - scroller.clientHeight;
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const tops = [...scroller.querySelectorAll<HTMLElement>(".msg.user")].map((el) => Math.min(max, Math.max(0, el.getBoundingClientRect().top - base - JUMP_GAP)));
  // Repeated taps step on from the pending target: the glide's midpoint would land on the same prompt again.
  const at = gliding(glide.current, scroller) ? glide.current.top : scroller.scrollTop;
  const target = dir < 0 ? tops.findLast((t) => t < at - 2) ?? 0 : tops.find((t) => t > at + 2) ?? max;
  glide.current = { top: target, at: performance.now() };
  pinned.current = target >= max - 2;
  scroller.scrollTo({ top: target, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
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

/** A session's subagent list, or one subagent's chat; both read-only. */
export function SubagentScreen({ route }: { route: Extract<Route, { view: "subagents" | "subagent" }> }) {
  const sub = route.view === "subagent" ? route.name : null;
  const { state, chat, subagents, online } = useStream(route.block, sub ? "chat" : "subagents", sub);
  const item = state?.projects.flatMap((p) => p.items).find((i) => i.block === route.block);
  const now = useNow(5000);
  const screen = { block: route.block, item, online, now, backHref: backStep(origins, route).target, onBack: () => goBack(route) };
  return sub ? <SubagentChat {...screen} name={sub} entries={chat} /> : <SubagentList {...screen} list={subagents} />;
}
