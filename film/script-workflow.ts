// What the workflow film's omps are asked and how the fake model answers. Three sessions in three
// projects, prompted before the take: the infra one edits a file in a folder omp restricts
// (`tools.restrictedFolders`), so its edit waits on an approval; the docs one runs a long build
// that waits for a gate file in the film's HOME (`~/.go-docs`); the webshop one is done.
import { isSideRequest, turnBlocks, type Request, type Step } from "./steps";

/** The restricted file the infra session edits, as committed before the take. */
export const PROD_YML = `service: orders-api
image: ghcr.io/acme/orders-api:2.4.0
deploy:
  replicas: 2
  cpu: 500m
  memory: 512Mi
`;
/** The folder omp asks about, relative to the scratch HOME. */
export const RESTRICTED = "code/infra/deploy";

export type Session = { project: string; title: string; prompt: string; steps: Step[]; files?: Record<string, string> };

/** In the order they're prompted: the list puts the newest activity on top, so infra leads. */
export const SESSIONS: Session[] = [
  {
    project: "webshop",
    title: `<title nf="nf-fa-shopping_cart" emoji="🛒" code="TAX">Fix checkout tax rounding</title>`,
    prompt: "Fix the tax rounding at checkout: totals are a cent off.",
    steps: [{ text: "Fixed: tax is rounded once per order, so totals match the receipt, and the 38 checkout tests pass." }],
  },
  {
    project: "docs",
    title: `<title nf="nf-md-book_open_variant" emoji="📖" code="DOCS">Rebuild the API reference</title>`,
    prompt: "Rebuild the API reference for 2.4.",
    steps: [
      {
        text: "Regenerating the reference from the OpenAPI spec.",
        tool: { id: "toolu_docs", name: "bash", input: { i: "Building the API reference", command: "until [ -e ~/.go-docs ]; do sleep 0.3; done; echo built" } },
      },
      { text: "The 2.4 reference is built." },
    ],
  },
  {
    project: "infra",
    title: `<title nf="nf-fa-server" emoji="🚀" code="PROD">Scale the prod orders API</title>`,
    prompt: "Give the prod orders API a third replica and more headroom.",
    files: { "deploy/prod.yml": PROD_YML },
    steps: [
      { tool: { id: "toolu_read", name: "read", input: { i: "Reading the prod deploy", path: "deploy/prod.yml" } } },
      // The edit's patch needs the snapshot tag omp's read printed: `pick` fills it in.
      {
        text: "Prod runs **2 replicas** at 500m CPU. Raising it to 3, with more CPU and memory each:",
        tool: { id: "toolu_edit", name: "edit", input: { i: "Scaling the prod orders API", input: "" } },
      },
      { text: "Prod now asks for **3 replicas** with 750m CPU and 768 MiB each. The change is in `deploy/prod.yml`; it goes out with the next deploy." },
    ],
  },
];

/** The patch the infra session's edit sends: three lines of `deploy/prod.yml` replaced. */
function patch(tag: string): string {
  return `[deploy/prod.yml#${tag}]\nPUT 4.=6:\n+  replicas: 3\n+  cpu: 750m\n+  memory: 768Mi`;
}

/**
 * The fake model's answer to each request of the take: the session's next step, counted by the
 * replies it already has. The edit's tag comes from the read's result.
 */
export function pick(body: Request): Step {
  const all = JSON.stringify(body.messages ?? "");
  const session = SESSIONS.find((s) => all.includes(s.prompt));
  if (isSideRequest(body)) return { text: session?.title ?? "<title>Session</title>", pause: 0 };
  if (!session) return { text: "Done." };
  const done = (body.messages ?? []).filter((m) => m.role === "assistant").length;
  const step = session.steps[Math.min(done, session.steps.length - 1)];
  if (!("tool" in step) || step.tool.id !== "toolu_edit") return step;
  // The read's result: `[deploy/prod.yml#TAG]` or a bare `#TAG` header.
  const read = turnBlocks(body).map((b) => JSON.stringify(b)).join("\n");
  const tag = /#([0-9A-F]{4})\b/.exec(read)?.[1] ?? /#([0-9A-F]{4})\b/.exec(all)?.[1] ?? "0000";
  return { ...step, tool: { ...step.tool, input: { ...step.tool.input, input: patch(tag) } } };
}
