// The model picker: effort, priority, omp's roles, recent picks and every listable model.
import { useEffect, useMemo, useState } from "preact/hooks";
import type { CatalogModel, Live, Role } from "./api";
import { can, ctxShort, currentRole, matchesWords, parseRecent, prettyModel, priceShort, searchModels, withRecent } from "./lib";

const RECENT_MODELS_KEY = "tern-mobile:recent-models";
const SEARCH_MAX = 80;
export const EFFORT_LABEL: Record<string, string> = { off: "Off", minimal: "Min", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };
export const TIER_LABEL: Record<string, [string, string]> = {
  "": ["Standard", ""],
  flex: ["Flex", "cheaper, slower"],
  priority: ["Fast", "priority serving, costs more"],
};

function ModelRow({ m, current, onPick }: { m: CatalogModel; current: boolean; onPick: () => void }) {
  const facts = [m.p, m.ctx ? ctxShort(m.ctx) : "", priceShort(m), m.r ? "reasoning" : "", m.img ? "vision" : ""].filter(Boolean);
  return (
    <button type="button" class={`mp-row${current ? " on" : ""}`} onClick={onPick}>
      <span class="mp-main">
        <span class="mp-name">{m.name}</span>
        <span class="mp-facts">{facts.join(" · ")}</span>
      </span>
      {current && <span class="mp-check">✓</span>}
    </button>
  );
}

/**
 * The model picker: effort and priority for the current model, omp's Ctrl+P roles first, then
 * recent picks and every model omp has credentials for, by provider or by search.
 */
export function ModelSheet({
  block,
  roles,
  current,
  bridged,
  send,
  onCycle,
  onClose,
}: {
  block: string;
  roles: Role[];
  current: Live | null;
  bridged: boolean;
  send: (path: string, body: unknown) => Promise<string | null>;
  onCycle: () => void;
  onClose: () => void;
}) {
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  // An omp without the catalog API still applies roles; it just can't list every model.
  const listable = can(current, "models");
  useEffect(() => {
    if (!bridged || !listable) return;
    void fetch(`/api/blocks/${block}/models`, { method: "POST", headers: { "x-tern-mobile": "1" } })
      .then((r) => r.json())
      .then((d: { models?: CatalogModel[]; error?: string }) => (d.models ? setModels(d.models) : setLoadError(d.error ?? "no models")))
      .catch((e) => setLoadError(String(e)));
  }, [block, bridged, listable]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const model = current?.model ?? "";
  const thinking = current?.thinking ?? "";
  const role = currentRole(roles, model, thinking);
  const needle = q.trim().toLowerCase();
  const byKey = useMemo(() => new Map((models ?? []).map((m) => [`${m.p}/${m.id}`, m])), [models]);
  const providers = useMemo(() => {
    const groups = new Map<string, CatalogModel[]>();
    for (const m of models ?? []) groups.set(m.p, [...(groups.get(m.p) ?? []), m]);
    return [...groups].sort((x, y) => x[0].localeCompare(y[0]));
  }, [models]);
  const found = searchModels(models ?? [], q);
  const recent = parseRecent(localStorage.getItem(RECENT_MODELS_KEY))
    .map((k) => byKey.get(k))
    .filter((m): m is CatalogModel => !!m);

  async function pick(spec: string) {
    const err = await send("model", { spec });
    if (err) return;
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(withRecent(parseRecent(localStorage.getItem(RECENT_MODELS_KEY)), spec)));
    onClose();
  }
  async function pickRole(r: string) {
    if (!(await send("model", { role: r }))) onClose();
  }
  const levels = current?.levels.filter((l) => l !== "off" || current.levels.length > 1) ?? [];
  const row = (m: CatalogModel) => <ModelRow key={`${m.p}/${m.id}`} m={m} current={`${m.p}/${m.id}` === model} onPick={() => pick(`${m.p}/${m.id}`)} />;

  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div class="sheet mp" onClick={(e) => e.stopPropagation()}>
        <div class="mp-head">
          <span class="mp-title">{prettyModel(model) || "Model"}</span>
          <span class="muted small">{model}</span>
          <span class="spacer" />
          <button type="button" class="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {!bridged ? (
          <>
            <div class="muted small sheet-note">
              This session started before the tern-mobile extension, so only cycling works. Restart it to pick directly.
            </div>
            <button class="sheet-row" onClick={onCycle}>
              <span class="role">Next model</span>
              <span class="muted small">Ctrl+P</span>
            </button>
          </>
        ) : (
          <>
            {levels.length > 1 && (
              <div class="mp-opt">
                <span class="mp-label">Effort</span>
                <div class="seg">
                  {levels.map((l) => (
                    <button key={l} type="button" class={l === thinking ? "on" : ""} onClick={() => void send("thinking", { level: l })}>
                      {EFFORT_LABEL[l] ?? l}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(current?.tiers.length ?? 0) > 1 && (
              <div class="mp-opt">
                <span class="mp-label">Priority</span>
                <div class="seg">
                  {current!.tiers.map((t) => (
                    <button
                      key={t}
                      type="button"
                      class={t === current!.tier ? "on" : ""}
                      title={TIER_LABEL[t]?.[1] ?? ""}
                      onClick={() => void send("tier", { tier: t })}
                    >
                      {TIER_LABEL[t]?.[0] ?? t}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <input class="sheet-filter" type="search" placeholder="Search models" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
            <div class="sheet-list">
              {roles.some((r) => !needle || matchesWords(needle, `${r.role} ${r.spec}`)) && <div class="mp-section">Roles · Ctrl+P</div>}
              {roles
                .filter((r) => !needle || matchesWords(needle, `${r.role} ${r.spec}`))
                .map((r) => {
                  const [spec, level] = r.spec.split(/:(?=[a-z]+$)/);
                  return (
                    <button key={r.role} type="button" class={`mp-row${r.role === role ? " on" : ""}`} onClick={() => pickRole(r.role)}>
                      <span class="mp-main">
                        <span class="mp-name">
                          <span class="mp-role">{r.role}</span> {byKey.get(spec)?.name ?? prettyModel(spec)}
                        </span>
                        <span class="mp-facts">{[spec, level && (EFFORT_LABEL[level] ?? level)].filter(Boolean).join(" · ")}</span>
                      </span>
                      {r.role === role && <span class="mp-check">✓</span>}
                    </button>
                  );
                })}
              {!listable ? (
                <div class="muted small sheet-note">This omp can't list models; roles still work</div>
              ) : (
                <>
                  {!models && <div class="muted small sheet-note">{loadError ? `Models: ${loadError}` : "Loading models…"}</div>}
                  {needle ? (
                    <>
                      {found.length > 0 && <div class="mp-section">{found.length > SEARCH_MAX ? `${SEARCH_MAX} of ${found.length}` : found.length} models</div>}
                      {found.slice(0, SEARCH_MAX).map(row)}
                    </>
                  ) : (
                    <>
                      {recent.length > 0 && <div class="mp-section">Recent</div>}
                      {recent.map(row)}
                      {providers.length > 0 && <div class="mp-section">All models</div>}
                      {providers.map(([p, list]) => (
                        <div key={p}>
                          <button type="button" class="mp-provider" onClick={() => setOpenProvider(openProvider === p ? null : p)}>
                            <span class="chev">{openProvider === p ? "▾" : "▸"}</span>
                            <span>{p}</span>
                            <span class="muted">{list.length}</span>
                            {model.startsWith(`${p}/`) && <span class="mp-check">●</span>}
                          </button>
                          {openProvider === p && list.map(row)}
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
