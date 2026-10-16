// An open session (chat, raw screen or note, with the composer) and its subagent screens.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { post } from "./api";
import { age, backStep, can, type Route } from "./lib";
import { Chat, Markdown, StretchContext, type StretchSync } from "./chat";
import { liveText, withOpen } from "./stretch";
import { screenHtml } from "./markdown";
import { Dot } from "./parts";
import { ExtensionNotice } from "./extension";
import { JobsStrip, SubagentChat, SubagentList } from "./subagents";
import { Title } from "./home";
import { Composer } from "./composer";
import { goBack, origins, useNow, useStream, type View } from "./hooks";

export function Session({ block }: { block: string }) {
  const [view, setView] = useState<View>("chat");
  // The server answers a chat request for a non-omp block with its screen.
  const { state, chat, live, queued, btw, setBtw, screen, draft, doc, online, stretch } = useStream(block, view);
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
    }),
    [opened, stretch, block],
  );
  const item = state?.projects.flatMap((p) => p.items).find((i) => i.block === block);
  const isOmp = !!item?.agent;
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const now = useNow(5000);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat, live, queued, screen, view]);

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
            <span>{shownState ?? (item?.doc ? (/[\\/]tern[\\/]notes[\\/]/i.test(item.doc) ? "note" : "file") : "shell")}</span>
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
        <button class="ghost" title="Show this pane on the desktop" onClick={() => post(`/api/blocks/${block}/focus`, {})}>
          ⌖
        </button>
        {item && (
          <button
            class="ghost danger"
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
            ✕
          </button>
        )}
      </header>
      {item && state && <ExtensionNotice item={item} install={state.extension} />}
      <div
        class="scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
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
              <Markdown class="msg md doc" text={doc.text} />
            ) : (
              <pre class="term">{doc.text}</pre>
            )
          ) : (
            <div class="empty">Loading…</div>
          )
        ) : chat && view === "chat" ? (
          <>
            <StretchContext.Provider value={stretchSync}>
              <Chat entries={chat} block={block} rewind={can(item?.live, "rewind")} />
            </StretchContext.Provider>
            {live && <Markdown class="msg assistant md live" text={liveText(live)} />}
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
        {working && <div class="working">working · {item ? age(item.since, now) : ""}</div>}
        {item && <JobsStrip block={block} jobs={item.live?.jobs ?? []} subagents={item.agent?.subagents ?? 0} now={now} />}
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
        />
      )}
    </div>
  );
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
