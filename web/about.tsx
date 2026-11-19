// The About window, opened from the dock: the app's name, version and repository, then the projects
// it works best with, each with what it adds here, whether the desktop has it installed
// (`/api/companions`, read when the window opens) and its README's install steps. It installs
// nothing itself: installing runs commands on the desktop, which the web app never does.
import { useEffect, useState } from "preact/hooks";
import { version } from "../package.json";
import type { Companion, CompanionId } from "../lib/companions";

const REPO = "https://github.com/materemias/tern-awui";

type Info = { name: string; repo: string; install: string; benefit: string };

/** Each companion in the order shown, with what it adds to this app and its README's install section. */
export const COMPANION_INFO: Record<CompanionId, Info> = {
  "omp-stretch": {
    name: "omp-stretch",
    repo: "https://github.com/materemias/omp-stretch",
    install: "https://github.com/materemias/omp-stretch#install",
    benefit: "Replies open at their gist. Tap a phrase for the detail, here and in the Tern pane at once; ✦ asks for more.",
  },
  "codexbar-agentview": {
    name: "CodexBar AgentView",
    repo: "https://github.com/materemias/codexbar-agentview",
    install: "https://github.com/materemias/codexbar-agentview#install",
    benefit: "Sessions you set aside in Tern show under Waiting, with Done, Snooze and a notification when one is back on you.",
  },
  "omp-compact": {
    name: "omp-compact",
    repo: "https://github.com/arksdev/omp-compact",
    install: "https://github.com/arksdev/omp-compact#install-from-the-marketplace",
    benefit: "Folds the Tern pane's tool log to one line per action, the way this app folds tool runs on the phone.",
  },
};

/** What the desktop has: installed or not per companion; null while asking, "error" when the server didn't answer. */
type Found = Partial<Record<CompanionId, boolean>> | null | "error";

function Status({ found }: { found: boolean | undefined }) {
  if (found === undefined) return null;
  return (
    <span class={`about-status ${found ? "yes" : "no"}`} title={found ? "Found on the desktop" : "Not found on the desktop"}>
      {found ? "Installed" : "Not found"}
    </span>
  );
}

/** A bottom sheet on a phone, a dialog on the desktop. Escape, ×, Back and a tap beside it close. */
export function About({ onClose }: { onClose: () => void }) {
  const [found, setFound] = useState<Found>(null);
  useEffect(() => {
    let open = true;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    fetch("/api/companions", { signal: abort.signal })
      .then(async (r) => {
        const d: { companions?: Companion[] } = await r.json();
        if (!r.ok || !d.companions) throw new Error(`HTTP ${r.status}`);
        if (open) setFound(Object.fromEntries(d.companions.map((c) => [c.id, c.installed])));
      })
      .catch(() => open && setFound("error"))
      .finally(() => clearTimeout(timer));
    return () => {
      open = false;
      abort.abort();
    };
  }, []);
  // The sheet holds a history entry, so a phone's Back closes it rather than tripping the list's
  // exit guard; closed any other way, it takes the entry back off.
  useEffect(() => {
    history.pushState({ about: true }, "");
    const onPop = () => history.state?.about !== true && onClose();
    addEventListener("popstate", onPop);
    return () => {
      removeEventListener("popstate", onPop);
      if (history.state?.about === true) history.back();
    };
  }, [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div class="sheet-backdrop about-backdrop" onClick={onClose}>
      <div class="sheet about-sheet" role="dialog" aria-modal="true" aria-label="About" onClick={(e) => e.stopPropagation()}>
        <div class="about-head">
          <span class="about-title">About</span>
          <span class="spacer" />
          <button class="icon-btn about-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </div>
        <div class="about-body">
          <section class="about-app">
            <div>
              <b>tern-awui</b> <span class="about-version">{version}</span>
            </div>
            <p>Follow and steer the omp sessions running in Tern, away from the desk.</p>
            <a href={REPO} target="_blank" rel="noopener" title="tern-awui's repository on GitHub">
              github.com/materemias/tern-awui
            </a>
          </section>
          <h3 class="sheet-sec">Works best with</h3>
          {found === null && <p class="sheet-sec-note">Checking what the desktop has…</p>}
          {found === "error" && <p class="sheet-sec-note">Couldn't check what the desktop has installed.</p>}
          <ul class="about-list">
            {(Object.keys(COMPANION_INFO) as CompanionId[]).map((id) => {
              const info = COMPANION_INFO[id];
              return (
                <li key={id} class="about-companion" data-id={id}>
                  <div class="about-name">
                    <a href={info.repo} target="_blank" rel="noopener" title={`${info.name} on GitHub`}>
                      {info.name}
                    </a>
                    <Status found={found && found !== "error" ? found[id] : undefined} />
                  </div>
                  <p>{info.benefit}</p>
                  <a class="about-install" href={info.install} target="_blank" rel="noopener" title={`How to install ${info.name}, in its README`}>
                    How to install
                  </a>
                </li>
              );
            })}
          </ul>
          <p class="sheet-sec-note">Install them on the desktop as their READMEs say, and restart omp after an omp plugin.</p>
        </div>
      </div>
    </div>
  );
}
