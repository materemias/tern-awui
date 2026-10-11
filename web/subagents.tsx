// A session's subagents, read-only: their list, and one subagent's chat. Subagents take no input,
// so neither screen has a composer, prompt actions or answerable questions.
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { ChatEntry, Item, Job, Subagent } from "./api";
import { Chat } from "./chat";
import { age, isAgentJob, routeHash, SUBAGENT_NAME } from "./lib";
import { Dot } from "./parts";

type Screen = {
  block: string;
  /** The parent session; undefined until the list arrives or once the block is gone. */
  item: Item | undefined;
  online: boolean;
  now: number;
  /** ‹'s target, and what a tap on it does (a history pop or a replace). */
  backHref: string;
  onBack: () => void;
};

/**
 * The session's background jobs under the transcript: a running subagent opens its chat, and
 * "Subagents (N)" lists them all, finished ones too.
 */
export function JobsStrip({ block, jobs, subagents, now }: { block: string; jobs: Job[]; subagents: number; now: number }) {
  if (!jobs.length && !subagents) return null;
  return (
    <div class="jobs">
      {jobs.map((j) => {
        const agent = isAgentJob(j);
        const body = (
          <>
            <span class="job-mark">{agent ? "⑂" : "⧗"}</span>
            <span class="job-name">{j.agent || j.id}</span>
            {j.label && j.label !== (j.agent || j.id) && <span class="job-label">{j.label}</span>}
            <span class="job-age">{age(j.since, now)}</span>
          </>
        );
        return agent && SUBAGENT_NAME.test(j.agent) ? (
          <a key={j.id} class="job job-agent job-open" href={routeHash({ view: "subagent", block, name: j.agent })}>
            {body}
            <span class="job-go">›</span>
          </a>
        ) : (
          <div key={j.id} class={`job${agent ? " job-agent" : ""}`}>
            {body}
          </div>
        );
      })}
      {subagents > 0 && (
        <a class="subagents-link" href={routeHash({ view: "subagents", block })}>
          <span class="job-mark">⑂</span>
          <span>Subagents ({subagents})</span>
          <span class="job-go">›</span>
        </a>
      )}
    </div>
  );
}

function SubBar({ backHref, onBack, item, online, title, children }: Screen & { title: ComponentChildren; children: ComponentChildren }) {
  const parent = item ? `${item.tag ? `${item.tag}: ` : ""}${item.title}` : "";
  return (
    <header class="bar session-bar sub-bar">
      <a
        class="back"
        href={backHref}
        aria-label="Back to the session"
        onClick={(e) => {
          e.preventDefault();
          onBack();
        }}
      >
        ‹
      </a>
      <div class="session-title">
        <div class="row-title">{title}</div>
        <div class="row-meta">
          {children}
          {parent && <span class="muted sub-parent">{parent}</span>}
          {!online && <span class="c-blocked">offline</span>}
        </div>
      </div>
    </header>
  );
}

/** Keeps a scroller at its end while it was there, as new content arrives. */
function usePinned(deps: unknown[]) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, deps);
  const onScroll = (e: Event) => {
    const el = e.currentTarget as HTMLDivElement;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  return { ref: scroller, onScroll };
}

/** A session's subagents, finished ones too: running first, then newest activity. */
export function SubagentList(props: Screen & { list: Subagent[] | null }) {
  const { block, item, now, list } = props;
  const running = list?.filter((s) => s.running).length ?? 0;
  return (
    <div class="screen">
      <SubBar {...props} title={<span class="title">Subagents</span>}>
        {list && (
          <span>
            {list.length}
            {running > 0 && <span class="c-working"> · {running} running</span>}
          </span>
        )}
      </SubBar>
      <main class="list">
        {!list ? (
          <div class="empty">Loading…</div>
        ) : !list.length ? (
          <div class="empty">{item && !item.agent ? "Subagents show while the session's omp is connected." : "No subagents yet."}</div>
        ) : (
          list.map((s) => (
            <a key={s.name} class={`row st-${s.running ? "working" : "idle"}`} href={routeHash({ view: "subagent", block, name: s.name })}>
              <Dot state={s.running ? "working" : "idle"} />
              <div class="row-main">
                <div class="row-title">
                  <span class="title">{s.name}</span>
                  {s.messages > 0 && <span class="muted small">{s.messages} messages</span>}
                </div>
                <div class="row-sub">{s.summary || (s.running ? "starting…" : "")}</div>
              </div>
              {/* Running: how long it has run; finished: since its last message. */}
              <span class={`age${s.running ? " age-hot" : ""}`}>{age(s.running ? s.started : s.lastActivity, now)}</span>
            </a>
          ))
        )}
      </main>
    </div>
  );
}

/** One subagent's chat as its transcript has it, read-only, updating while it runs. */
export function SubagentChat(props: Screen & { name: string; entries: ChatEntry[] | null }) {
  const { block, item, now, name, entries } = props;
  const job = item?.live?.jobs.find((j) => j.agent === name);
  const scroll = usePinned([entries]);
  return (
    <div class="screen">
      <SubBar
        {...props}
        title={
          <>
            <span class="sub-mark">⑂</span>
            <span class="title">{name}</span>
          </>
        }
      >
        <Dot state={job ? "working" : "idle"} />
        <span>{job ? "running" : "finished"}</span>
        {job && <span class="muted">{age(job.since, now)}</span>}
      </SubBar>
      <div class="scroll" ref={scroll.ref} onScroll={scroll.onScroll}>
        {!entries ? (
          <div class="empty">Loading…</div>
        ) : entries.length ? (
          <Chat entries={entries} block={block} rewind={false} readOnly />
        ) : (
          <div class="empty">{item && !item.agent ? "Subagents show while the session's omp is connected." : job ? "Starting…" : "No transcript for this subagent."}</div>
        )}
        {job && <div class="working">working · {age(job.since, now)}</div>}
      </div>
    </div>
  );
}
