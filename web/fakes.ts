// Test doubles for the web client's render tests: a recording fetch, a scriptable EventSource,
// and API data builders. No DOM access at load, so tests can import it before registering one.
import type { Item, Live, State } from "./api";

export type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };

/** A real-time pause, for async work driven by timers the test doesn't fake. */
export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function following(n: Node, root: Node): Node | null {
  if (n.firstChild) return n.firstChild;
  for (let c: Node | null = n; c && c !== root; c = c.parentNode) if (c.nextSibling) return c.nextSibling;
  return null;
}
function preceding(n: Node, root: Node): Node | null {
  if (n === root) return null;
  let p = n.previousSibling;
  if (!p) return n.parentNode;
  while (p.lastChild) p = p.lastChild;
  return p;
}

/**
 * happy-dom differs from browsers in two places DOMPurify depends on; both are patched to the
 * spec's behavior, so the sanitizer runs as it does in Chrome. Call after registering the DOM;
 * returns the undo.
 */
export function specDom(): () => void {
  const nodeName = Object.getOwnPropertyDescriptor(Node.prototype, "nodeName")!;
  // The class that defines it for every document, parsed ones included (the global `Document` is a subclass).
  let docProto: Document = Object.getPrototypeOf(document);
  while (!Object.hasOwn(docProto, "createNodeIterator")) docProto = Object.getPrototypeOf(docProto);
  const createNodeIterator = docProto.createNodeIterator;
  // 1. DOMPurify reads names through `Node.prototype`'s nodeName getter; happy-dom returns "" there
  // and overrides it per subclass, so every tag would read as unknown and be dropped.
  Object.defineProperty(Node.prototype, "nodeName", {
    configurable: true,
    get(this: Node) {
      for (let p = Object.getPrototypeOf(this); p && p !== Node.prototype; p = Object.getPrototypeOf(p)) {
        const get = Object.getOwnPropertyDescriptor(p, "nodeName")?.get;
        if (get) return get.call(this);
      }
      return "";
    },
  });
  // 2. happy-dom's NodeIterator is a TreeWalker: removing the node it stands on loses its place, so
  // everything after a removed element would go unchecked. A browser's steps back to the node
  // before the removed one; this does the same (DOMPurify passes no filter).
  docProto.createNodeIterator = function (root: Node, whatToShow = 0xffffffff) {
    let ref: Node | null = null;
    let before: Node | null = null;
    const shown = (n: Node) => (whatToShow >> (n.nodeType - 1)) & 1;
    return {
      nextNode() {
        let n = ref === null ? root : root.contains(ref) ? following(ref, root) : before && following(before, root);
        while (n && !shown(n)) n = following(n, root);
        if (n) [ref, before] = [n, preceding(n, root)];
        return n;
      },
    } as NodeIterator;
  };
  return () => {
    Object.defineProperty(Node.prototype, "nodeName", nodeName);
    docProto.createNodeIterator = createNodeIterator;
  };
}

/** Records every request; `reply` answers it (default 200 `{ok:true}`) and may hold it pending. */
export class Net {
  calls: Call[] = [];
  reply: (c: Call) => Response | Promise<Response> = () => Response.json({ ok: true });
  private real: typeof fetch | null = null;
  install() {
    this.calls = [];
    this.reply = () => Response.json({ ok: true });
    this.real ??= globalThis.fetch;
    globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
      const call: Call = {
        url: String(input),
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        headers: { ...(init.headers as Record<string, string>) },
      };
      this.calls.push(call);
      return this.reply(call);
    }) as typeof fetch;
  }
  restore() {
    if (this.real) globalThis.fetch = this.real;
  }
  /** Bodies of the requests to `url`, in order. */
  to(url: string) {
    return this.calls.filter((c) => c.url === url).map((c) => c.body);
  }
}

type Listener = (e: { data: string }) => void;

/** The browser's EventSource as useStream drives it; `all` keeps every instance made. */
export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static all: FakeEventSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Listener[]>();
  constructor(public url: string) {
    FakeEventSource.all.push(this);
  }
  static get last(): FakeEventSource {
    const es = FakeEventSource.all.at(-1);
    if (!es) throw new Error("no EventSource opened");
    return es;
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  fail() {
    this.onerror?.();
  }
  emit(type: string, data: unknown) {
    if (this.readyState === FakeEventSource.CLOSED) throw new Error(`emit on a closed stream: ${type}`);
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
}

export function live(over: Partial<Live> = {}): Live {
  return {
    model: "anthropic/claude-opus-5-5",
    thinking: "high",
    levels: ["off", "low", "medium", "high"],
    tiers: [],
    tier: "",
    context: null,
    jobs: [],
    protocol: 3,
    caps: null,
    build: "",
    mismatch: null,
    restart: false,
    ...over,
  };
}

/** An omp session row (agent + live bridge) unless overridden; `agent: null, live: null` is a shell. */
export function item(over: Partial<Item> = {}): Item {
  return {
    block: "5",
    icon: null,
    tag: null,
    title: "Fix login",
    cwd: "/w/app",
    project: "app",
    branch: null,
    agent: { sessionId: "s", lastPrompt: "fix the login", recap: "", recapStale: false, lastActivity: 0, subagents: 0 },
    live: live(),
    status: "idle",
    since: 0,
    doc: null,
    unseen: null,
    ...over,
  };
}

export function state(items: Item[], over: Partial<State> = {}): State {
  const projects = new Map<string, Item[]>();
  for (const i of items) projects.set(i.project, [...(projects.get(i.project) ?? []), i]);
  return {
    projects: [...projects].map(([name, list]) => ({ name, items: list })),
    counts: { working: items.filter((i) => i.status === "working").length, idle: items.filter((i) => i.status === "idle").length },
    roles: [],
    badge: 0,
    at: 0,
    extension: { status: "ok", path: "/x", target: "", repo: "/r", windows: false },
    ...over,
  };
}

/** Lets pending promise chains (fetch replies, awaited posts) run. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
