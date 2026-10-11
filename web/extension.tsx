// What the app says when omp's tern-mobile extension isn't the one this server ships: a banner on
// the list for the installed file, a notice under a session's header for what its omp loaded.
import { useState } from "preact/hooks";
import { post, type Install, type Item } from "./api";
import { installNotice, sessionNotice, type Notice } from "./lib";

/** A command to run in a terminal, with Copy (it is also selectable as one block). */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <div class="ext-cmd">
      <code>{text}</code>
      <button type="button" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function NoticeBox({ notice, class: cls, onReload }: { notice: Notice; class: string; onReload?: () => void }) {
  return (
    <div class={`ext-note ${cls}`} role="status">
      <p>{notice.text}</p>
      {notice.command && <Command text={notice.command} />}
      {notice.reload && onReload && (
        <button type="button" class="ext-reload" onClick={onReload}>
          Reload
        </button>
      )}
    </div>
  );
}

/** The top of the session list, while `<omp dir>/extensions/tern-mobile.ts` isn't this checkout's. */
export function ExtensionBanner({ install }: { install: Install }) {
  const notice = installNotice(install);
  return notice && <NoticeBox notice={notice} class="ext-banner" />;
}

/** Under a session's header, while its omp runs another extension build than the server's. */
export function ExtensionNotice({ item, install }: { item: Item; install: Install }) {
  const notice = sessionNotice(item, install);
  if (!notice) return null;
  async function reload() {
    if (!confirm("Restart omp in this pane? It runs /restart: omp quits, starts again with the same flags and resumes this session, now with the installed extension. A draft in its editor is replaced."))
      return;
    const err = await post(`/api/blocks/${item.block}/submit`, { text: "/restart" });
    if (err) alert(`Reload failed: ${err}`);
  }
  return <NoticeBox notice={notice} class="ext-session" onReload={reload} />;
}
