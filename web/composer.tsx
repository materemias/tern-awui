// The prompt: draft mirroring, sends and follow-ups, side questions, pasted images, completions,
// terminal typing and the key bar.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { post, postJson, type Btw, type BtwHistoryRecord, type Item, type Role } from "./api";
import { btwCommand, can, composerKey, currentRole, fitEdge, lineEdit, needsReencode, prettyModel, tokensShort } from "./lib";
import { Markdown } from "./chat";
import { openText } from "./stretch";
import { buzz } from "./parts";
import type { Draft } from "./hooks";
import { EFFORT_LABEL, ModelSheet, TIER_LABEL } from "./models";
import { BtwHistorySheet } from "./btw-history";

type DraftWrite = { text: string; expectedSessionId?: string; expectedText?: string };

const KEY_BAR: [string, string[]][] = [
  ["Esc", ["Escape"]],
  ["^C", ["ctrl+c"]],
  ["↑", ["Up"]],
  ["↓", ["Down"]],
  ["⏎", ["Enter"]],
  ["Tab", ["Tab"]],
  ["⇧Tab", ["shift+Tab"]],
  ["Space", ["space"]],
];

/** omp's autocomplete for the composer text: suggestions and the token they replace. */
type Hints = { prefix: string; items: { value: string; label: string; description: string }[] };
/** Text ending in a token omp completes: `/command`, `/skill:name`, `@path`. */
const COMPLETABLE = /(^|\s)[/@][^\s]*$/;

/** A pasted image ready to send: base64 bytes, their type, and an object URL for the preview. */
type PastedImage = { data: string; mimeType: string; url: string };
const MAX_PASTED = 8;

async function pastedImage(file: File): Promise<PastedImage> {
  let blob: Blob = file;
  if (needsReencode(file.type, file.size)) {
    const bitmap = await createImageBitmap(file);
    const { width, height } = fitEdge(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(bin), mimeType: blob.type, url: URL.createObjectURL(blob) };
}

/**
 * The prompt. With the omp bridge connected it mirrors the session's editor both ways:
 * every keystroke here becomes the desktop draft, and desktop typing shows up here.
 * `raw` (omp only) puts a Raw/Chat switch in the key bar for the pane's raw screen text.
 */
export function Composer({
  block,
  item,
  draft,
  roles,
  raw,
  btw,
  setBtw,
}: {
  block: string;
  item: Item | undefined;
  draft: Draft | null;
  roles: Role[];
  raw?: { on: boolean; toggle: () => void };
  /** The open side question (`/btw …`) and its streaming answer. */
  btw: Btw | null;
  setBtw: (b: Btw | null) => void;
}) {
  const [text, setText] = useState("");
  /** The composer text now, for async work that must not act on an older value. */
  const textRef = useRef(text);
  textRef.current = text;
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /** Images pasted into the prompt; they go out with the next send. */
  const [pasted, setPasted] = useState<PastedImage[]>([]);
  const pastedRef = useRef(pasted);
  pastedRef.current = pasted;
  // Leaving the session with images still attached: their previews hold the image bytes.
  useEffect(() => () => { for (const p of pastedRef.current) URL.revokeObjectURL(p.url); }, []);
  // Shells (no agent) open with the key bar shown: fzf and history need the arrows and Enter.
  const [keysOpen, setKeysOpen] = useState<boolean | null>(null);
  const [sheet, setSheet] = useState(false);
  const sessionId = item?.agent?.sessionId ?? null;
  const [history, setHistory] = useState<{ block: string; sessionId: string | null; records: BtwHistoryRecord[] } | null>(null);
  const activeBlock = useRef<string | null>(block);
  const activeSessionId = useRef(sessionId);
  activeBlock.current = block;
  activeSessionId.current = sessionId;
  useEffect(() => () => { activeBlock.current = null; }, []);
  useEffect(() => { setHistory(null); }, [block, sessionId]);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const lastEdit = useRef(0);
  const outbox = useRef<{ busy: boolean; next: DraftWrite | null }>({ busy: false, next: null });
  const submitting = useRef(false);
  // Edits for the next prompt must reach omp after the current submission clears its editor.
  const deferredDraft = useRef<DraftWrite | null>(null);
  // Terminals: what the phone has typed onto the shell's line, and one queue for every write.
  const typed = useRef("");
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const remote = useRef<string | null>(null);
  const reconcileTimer = useRef<number | undefined>(undefined);
  const live = draft?.live === true;
  const [hints, setHints] = useState<Hints | null>(null);
  const hintSeq = useRef(0);

  // omp's own autocomplete while the phone types a /command, /skill:… or @path token.
  const completable = can(item?.live, "complete");
  useEffect(() => {
    const seq = ++hintSeq.current;
    if (!live || !completable || !COMPLETABLE.test(text) || Date.now() - lastEdit.current > 1000) return setHints(null);
    const timer = window.setTimeout(async () => {
      const r = await postJson(`/api/blocks/${block}/complete`, { text }).catch(() => null);
      const data: Hints | null = r?.ok ? await r.json().catch(() => null) : null;
      if (seq === hintSeq.current) setHints(data?.items.length ? data : null);
    }, 120);
    return () => clearTimeout(timer);
  }, [text, live, completable]);

  async function pick(item: Hints["items"][number]) {
    if (!hints || submitting.current) return;
    const prefix = hints.prefix;
    hintSeq.current++;
    setHints(null);
    // Applying shares the draft queue: omp must hold exactly the text the completion is for.
    if (!(await draftSettled())) return setError("Draft still syncing; tap the suggestion again");
    if (submitting.current) return;
    const box = outbox.current;
    const sent = textRef.current;
    box.busy = true;
    const r = await postJson(`/api/blocks/${block}/completion`, { text: sent, value: item.value, label: item.label, prefix }).catch(() => null);
    const data: { text?: string; error?: string } = r ? await r.json().catch(() => ({})) : { error: "offline" };
    box.busy = false;
    box.next = null;
    // Typing while the request ran wins over its result: resend what the phone holds now.
    if (textRef.current !== sent) return void pushDraft(textRef.current);
    if (submitting.current) return;
    if (typeof data.text !== "string") return setError(data.error ?? "completion failed");
    lastEdit.current = Date.now();
    buzz(8);
    textRef.current = data.text;
    setText(data.text);
    area.current?.focus();
  }

  // Adopt the desktop's newest draft once the phone's own edits have settled: while the phone
  // types or a push is in flight, the echo may be stale, so it waits rather than being dropped.
  function reconcile() {
    clearTimeout(reconcileTimer.current);
    const wanted = remote.current;
    if (wanted === null) return;
    const quiet = 800 - (Date.now() - lastEdit.current);
    if (outbox.current.busy || submitting.current || quiet > 0) {
      reconcileTimer.current = window.setTimeout(reconcile, Math.max(quiet, 100));
      return;
    }
    remote.current = null;
    setText((t) => (t === wanted ? t : wanted));
  }
  // A prompt typed before omp's editor connected (still loading or starting) becomes its draft,
  // rather than giving way to the editor's empty one.
  const typedOffline = useRef(false);
  useEffect(() => {
    if (!draft?.live) return;
    if (typedOffline.current) {
      typedOffline.current = false;
      if (textRef.current !== "") {
        lastEdit.current = Date.now();
        void pushDraft(textRef.current);
        return;
      }
    }
    remote.current = draft.text;
    reconcile();
  }, [draft]);
  useEffect(() => () => clearTimeout(reconcileTimer.current), []);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  async function pushDraft(value: string, expectedSessionId?: string, expectedText?: string) {
    const write: DraftWrite = { text: value };
    if (expectedSessionId !== undefined) write.expectedSessionId = expectedSessionId;
    if (expectedText !== undefined) write.expectedText = expectedText;
    if (submitting.current) {
      deferredDraft.current = write;
      return;
    }
    const box = outbox.current;
    if (box.busy) {
      box.next = write;
      return;
    }
    box.busy = true;
    let current: DraftWrite | null = write;
    while (current !== null) {
      box.next = null;
      const err = await post(`/api/blocks/${block}/draft`, current);
      if (err) setError(err);
      current = box.next;
    }
    box.busy = false;
    reconcile();
  }

  /** Waits up to ~3 s for draft pushes to finish; false if they are still running. */
  async function draftSettled(): Promise<boolean> {
    const box = outbox.current;
    for (let i = 0; box.busy && i < 60; i++) await new Promise((r) => setTimeout(r, 50));
    return !box.busy;
  }

  async function send(path: string, body: unknown) {
    setSending(true);
    const err = await post(`/api/blocks/${block}/${path}`, body);
    setSending(false);
    setError(err);
    return err;
  }

  const a = item?.agent;
  // omp still starting: its prompt can be written but not sent, and it is no shell to type into.
  const starting = !!item?.starting;
  const terminal = !!item && !a && !item.live && !starting;
  // Nothing to send to until the pane is known and its omp is up.
  const unready = !item || starting;

  /** Runs terminal writes in order, so keystrokes never overtake each other. */
  function queue(path: string, body: unknown): Promise<string | null> {
    const next = chain.current.then(() => post(`/api/blocks/${block}/${path}`, body));
    chain.current = next;
    void next.then((err) => err && setError(err));
    return next;
  }

  /** Mirrors the composer onto the shell's prompt: Backspace what changed, type the rest. */
  function typeInto(value: string) {
    const edit = lineEdit(typed.current, value);
    typed.current = value;
    if (edit.back || edit.text) void queue("type", edit);
  }

  function terminalKeys(keys: string[]) {
    // Anything but plain movement changes the line under the phone: start fresh.
    typed.current = "";
    setText("");
    return queue("keys", { keys });
  }

  /** `followUp`: omp holds the prompt until the running turn ends (its Ctrl+Q), rather than steering. */
  async function submit(e: Event, followUp = false) {
    e.preventDefault();
    if (unready) return;
    if (terminal) {
      buzz();
      await terminalKeys(["Enter"]);
      return;
    }
    // One send at a time: a second tap while the draft settles would post the prompt twice.
    if (submitting.current) return;
    submitting.current = true;
    setSending(true);
    try {
      await submitPrompt(followUp);
    } finally {
      submitting.current = false;
      setSending(false);
      if (deferredDraft.current !== null) {
        const value = deferredDraft.current;
        deferredDraft.current = null;
        void pushDraft(value.text, value.expectedSessionId, value.expectedText);
      }
    }
  }

  async function submitPrompt(followUp: boolean) {
    // A draft push still queued would reach omp after the send and refill its editor (and from
    // there this composer) with the sent text: drop it, since the send carries the final text,
    // and let the one in flight land first.
    outbox.current.next = null;
    if (!(await draftSettled())) return setError("Draft still syncing; send again");
    const command = btwCommand(text);
    if (command?.kind === "history") {
      const r = await fetch(`/api/blocks/${block}/btw-history`).catch(() => null);
      const data: { records?: BtwHistoryRecord[]; error?: string } = r ? await r.json().catch(() => ({})) : { error: "offline" };
      if (activeBlock.current !== block || activeSessionId.current !== sessionId) return;
      if (!r?.ok || !Array.isArray(data.records)) return setError(data.error ?? "Could not load btw history; send again to retry");
      setHistory({ block, sessionId, records: data.records });
      setError(null);
      buzz();
      const desktopChanged = remote.current !== null && remote.current !== text;
      if (!desktopChanged) remote.current = null;
      if (textRef.current === text && !desktopChanged && sessionId !== null) {
        lastEdit.current = Date.now();
        deferredDraft.current = null;
        textRef.current = "";
        setText("");
        void pushDraft("", sessionId, text);
      }
      return;
    }
    // An omp without side turns gets `/btw …` as a normal prompt.
    if (command?.kind === "question" && live && can(item?.live, "btw") && !pasted.length && !followUp) {
      const question = command.question;
      // A side question answered on the phone; the desktop draft is cleared like a sent prompt.
      setSending(true);
      const r = await postJson(`/api/blocks/${block}/btw`, { text: question }).catch(() => null);
      const data: { id?: string; error?: string } = r ? await r.json().catch(() => ({})) : { error: "offline" };
      setSending(false);
      if (!data.id) return setError(data.error ?? "btw failed");
      buzz();
      setBtw({ id: data.id, question, text: "", done: false, error: "" });
      lastEdit.current = Date.now();
      remote.current = null;
      if (textRef.current === text) {
        deferredDraft.current = null;
        textRef.current = "";
        setText("");
        void pushDraft("");
      }
      return;
    }
    if (pasted.length) {
      const sent = pasted;
      const images = sent.map(({ data, mimeType }) => ({ data, mimeType }));
      if (await send("submit", { text: text.trim(), images, followUp })) return;
      buzz();
      for (const p of sent) URL.revokeObjectURL(p.url);
      // Images pasted while this one was uploading stay for the next send.
      setPasted((now) => now.filter((p) => !sent.includes(p)));
      lastEdit.current = Date.now();
      remote.current = null;
      if (textRef.current === text) {
        deferredDraft.current = null;
        textRef.current = "";
        setText("");
      }
      return;
    }
    if (!(await send("submit", followUp ? { text: text.trim(), followUp } : { text: text.trim() }))) {
      buzz();
      lastEdit.current = Date.now();
      // An echo of the draft from before the send must not come back once it settles.
      remote.current = null;
      if (textRef.current === text) {
        deferredDraft.current = null;
        textRef.current = "";
        setText("");
      }
    }
  }

  async function onPaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.items ?? [])]
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
    if (!files.length) return;
    // Text pasted alongside an image (some apps add a file name) is dropped with it.
    e.preventDefault();
    await addImages(files);
  }

  /** Images picked with the attach button (camera, gallery or files on a phone). */
  async function onPick(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])].filter((f) => f.type.startsWith("image/"));
    // Cleared so picking the same file again still fires `change`.
    input.value = "";
    if (files.length) await addImages(files);
  }

  async function addImages(files: File[]) {
    const room = MAX_PASTED - pasted.length;
    if (room <= 0) return setError(`at most ${MAX_PASTED} images`);
    const next = await Promise.all(files.slice(0, room).map(pastedImage)).catch(() => null);
    if (!next) return setError("could not read the image");
    setPasted((p) => [...p, ...next]);
  }

  function unpaste(index: number) {
    URL.revokeObjectURL(pasted[index].url);
    setPasted((p) => p.filter((_, i) => i !== index));
  }

  async function stop() {
    if (!(await send("abort", {}))) buzz(30);
  }

  const model = item?.live?.model ?? "";
  const thinking = item?.live?.thinking ?? "";
  const role = currentRole(roles, model, thinking);
  const working = item?.status === "working";
  const keysShown = keysOpen ?? terminal;
  const empty = text.trim() === "" && !pasted.length;
  // While the agent runs and nothing is typed, the send button stops the turn instead.
  const stoppable = working && empty && !terminal && !!a;
  const context = item?.live?.context ?? null;

  return (
    <div class="composer-wrap">
      {keysShown && (
        <div class="keys">
          {raw && (
            <button class={raw.on ? "on" : ""} onClick={raw.toggle}>
              {raw.on ? "Chat" : "Raw"}
            </button>
          )}
          {KEY_BAR.map(([label, keys]) => (
            <button
              key={label}
              disabled={sending}
              onClick={() => {
                buzz(8);
                void (terminal ? terminalKeys(keys) : send("keys", { keys }));
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div class="error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {btw && (
        <div class={`btw${btw.done ? "" : " streaming"}`}>
          <div class="btw-head">
            <span class="btw-tag">btw</span>
            <span class="btw-q">{btw.question}</span>
            <button class="btw-x" onClick={() => setBtw(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
          {btw.error ? (
            <div class="err small">{btw.error}</div>
          ) : btw.text ? (
            <Markdown class="md btw-a" text={openText(btw.text)} />
          ) : (
            <div class="muted small">thinking…</div>
          )}
        </div>
      )}
      {hints && (
        <div class="hints" role="listbox">
          {hints.items.map((h) => (
            <button key={`${h.value}\u0000${h.label}`} class="hint" disabled={sending} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h)}>
              <span class="hint-label">{h.label}</span>
              {h.description && <span class="hint-desc">{h.description}</span>}
            </button>
          ))}
        </div>
      )}
      <form class="composer" onSubmit={submit}>
        {context && (
          // Context-window use drawn as the composer's top border, like omp's own composer:
          // the used part in accent, the percent riding just past it, the window at the right end.
          <div class={`ctx${context.percent > 100 ? " ctx-over" : ""}`} title={`${context.percent}% of the context window · ${tokensShort(context.tokens)} tokens`}>
            <div class="ctx-scale">
              <div class="ctx-fill" style={{ width: `${Math.max(1, Math.min(context.percent, 100))}%` }} />
              {context.compactAt !== null && (
                <span class="ctx-mark" style={{ left: `${context.compactAt}%` }} title={`auto-compacts at ${Math.round(context.compactAt)}%`} />
              )}
              <span class="ctx-label ctx-pct" style={{ left: `min(${Math.min(context.percent, 100)}%, calc(100% - 4.5ch))` }}>
                {context.percent}%
              </span>
            </div>
            <span class="ctx-label ctx-window">{tokensShort(context.window)}</span>
          </div>
        )}
        {pasted.length > 0 && (
          <div class="pasted">
            {pasted.map((p, i) => (
              <div key={p.url} class="pasted-item">
                <img src={p.url} alt="" />
                <button type="button" onClick={() => unpaste(i)} aria-label="Remove image">
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          rows={1}
          placeholder={
            starting ? "omp is starting… write your prompt" : terminal ? "Type into the terminal" : working ? "Steer the agent…" : "Ask for changes or send a follow-up"
          }
          autoCapitalize={terminal ? "off" : undefined}
          autoCorrect={terminal ? "off" : undefined}
          spellcheck={!terminal}
          value={text}
          onInput={(e) => {
            let value = e.currentTarget.value;
            if (terminal) {
              // A soft keyboard's Enter arrives as a newline: type up to it, then press Enter.
              const nl = value.indexOf("\n");
              if (nl >= 0) value = value.slice(0, nl);
              setText(value);
              typeInto(value);
              if (nl >= 0) void terminalKeys(["Enter"]);
              return;
            }
            lastEdit.current = Date.now();
            textRef.current = value;
            setText(value);
            if (live) void pushDraft(value);
            else typedOffline.current = true;
          }}
          onPaste={terminal || !a ? undefined : onPaste}
          onKeyDown={(e) => {
            const action = composerKey(e, { working, live, terminal, touch: "ontouchstart" in window });
            if (action) void submit(e, action === "followUp");
          }}
        />
        <div class="composer-foot">
          {a && (
            <button type="button" class="pick" onClick={() => setSheet(true)}>
              <span>{prettyModel(model) || role || "Model"}</span>
              {thinking && <span class="pick-sub">{EFFORT_LABEL[thinking]?.toLowerCase() ?? thinking}</span>}
              {item?.live?.tier && <span class="pick-sub pick-tier">{TIER_LABEL[item.live.tier]?.[0].toLowerCase() ?? item.live.tier}</span>}
              <svg class="caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          )}
          {live && <span class="sync" title="Draft mirrors the desktop editor" />}
          <span class="spacer" />
          {a && !terminal && (
            <>
              <input ref={picker} type="file" accept="image/*" multiple hidden onChange={onPick} />
              <button type="button" class="icon-btn" disabled={sending} onClick={() => picker.current?.click()} aria-label="Attach image">
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <rect x="2.5" y="4" width="15" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.4" />
                  <circle cx="7" cy="8.5" r="1.4" fill="currentColor" />
                  <path d="m3 14.5 4.5-4 3 2.5 3-3 3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
                </svg>
              </button>
            </>
          )}
          <button
            type="button"
            class={`icon-btn${keysShown ? " on" : ""}`}
            onClick={() => setKeysOpen(!keysShown)}
            aria-label="Keys"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <rect x="2.5" y="5" width="15" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.4" />
              <path d="M5.5 8h1M9.5 8h1M13.5 8h1M6.5 12h7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </button>
          {working && live && !empty && !terminal && (
            <button
              class="icon-btn follow"
              type="button"
              disabled={sending}
              onClick={(e) => submit(e, true)}
              title="Send after this turn (follow-up, Ctrl+Enter)"
              aria-label="Send after this turn"
            >
              →
            </button>
          )}
          {stoppable ? (
            <button class="send stop" type="button" disabled={sending} onClick={stop} aria-label="Stop">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button class={`send${empty && !terminal ? " idle" : ""}`} type="submit" disabled={sending || unready} aria-label="Send">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </form>
      {history?.block === block && history.sessionId === sessionId && (
        <BtwHistorySheet key={sessionId} records={history.records} onClose={() => setHistory(null)} />
      )}
      {sheet && (
        <ModelSheet
          block={block}
          roles={roles}
          current={item?.live ?? null}
          bridged={live}
          send={send}
          onClose={() => setSheet(false)}
          onCycle={async () => {
            setSheet(false);
            await send("keys", { keys: ["ctrl+p"] });
          }}
        />
      )}
    </div>
  );
}
