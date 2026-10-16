import { useEffect, useState } from "preact/hooks";
import type { BtwHistoryRecord, BtwHistoryTurn } from "./api";
import { Markdown } from "./chat";
import { openText } from "./stretch";

function HistoryTurn({ turn }: { turn: BtwHistoryTurn }) {
  return (
    <section class="btw-history-turn">
      <Markdown class="md" text={turn.question} />
      <div class="muted small">{turn.status} · {new Date(turn.createdAt).toLocaleString()}</div>
      {turn.answer && <Markdown class="md" text={openText(turn.answer)} />}
      {turn.error && <div class="err small">{turn.error}</div>}
    </section>
  );
}

/** Saved native questions only; opening and reading never changes their status. */
export function BtwHistorySheet({ records, onClose }: { records: BtwHistoryRecord[]; onClose: () => void }) {
  const [selected, setSelected] = useState<BtwHistoryRecord | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div class="sheet tall btw-history" role="dialog" aria-modal="true" aria-label="Btw history" onClick={(e) => e.stopPropagation()}>
        <div class="sheet-head">
          {selected && <button type="button" class="icon-btn" aria-label="Back to history" onClick={() => setSelected(null)}>‹</button>}
          <span>Btw history</span>
          <span class="spacer" />
          <button type="button" class="icon-btn" onClick={onClose} aria-label="Close history">×</button>
        </div>
        <div class="sheet-list">
          {selected ? (
            <>
              <HistoryTurn turn={selected} />
              {selected.followUps?.map((turn, i) => <HistoryTurn key={i} turn={turn} />)}
            </>
          ) : records.length ? records.map((record) => (
            <button type="button" key={record.id} class="sheet-row" onClick={() => setSelected(record)}>
              <span class="role">{record.question}</span>
              <span class="muted small">{record.status} · {new Date(record.createdAt).toLocaleString()}</span>
            </button>
          )) : <div class="muted sheet-note">No saved btw questions.</div>}
        </div>
      </div>
    </div>
  );
}
