import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { routeHash, type Route } from "./lib";
import { useRoute, useWide } from "./hooks";
import { Home } from "./home";
import { Session, SubagentScreen } from "./session";
import { usePush } from "./push";

/** The desktop sidebar minimized to a rail of session icons, remembered on this device. */
const RAIL_KEY = "tern-mobile:sidebar-rail";

function App() {
  const route = useRoute();
  const wide = useWide();
  // Here, not in the list: a phone showing a session must still retry and restore notifications.
  const push = usePush();
  const [rail, setRail] = useState(() => localStorage.getItem(RAIL_KEY) === "on");
  function toggleRail() {
    setRail((was) => {
      localStorage.setItem(RAIL_KEY, was ? "off" : "on");
      return !was;
    });
  }
  // Ctrl+\ (⌘\ on macOS) toggles it: Ctrl+B is Firefox's bookmarks sidebar.
  useEffect(() => {
    if (!wide) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "\\" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        toggleRail();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [wide]);
  // The Waiting popup opens over the list (Home draws it). On the desktop the session open before
  // it stays underneath; a phone shows the list under its sheet.
  const under = useRef<Route>({ view: "list" });
  if (route.view !== "waiting") under.current = route;
  const waitingOpen = route.view === "waiting";
  // The session the Waiting popup shows in full; null on its list.
  const waitingCard = route.view === "waiting" ? (route.id ?? null) : null;
  const shown = waitingOpen ? (wide ? under.current : { view: "list" as const }) : route;
  const key = routeHash(shown);
  const open =
    shown.view === "list" || shown.view === "waiting" ? null
    : shown.view === "session" ? <Session key={key} block={shown.block} />
    : <SubagentScreen key={key} route={shown} />;
  if (!wide) return open ?? <Home push={push} waitingOpen={waitingOpen} waitingCard={waitingCard} />;
  return (
    <div class={`desk${rail ? " rail" : ""}`}>
      <aside class="desk-side">
        <Home push={push} wide rail={rail} onRail={toggleRail} waitingOpen={waitingOpen} waitingCard={waitingCard} selected={"block" in shown ? shown.block : null} />
      </aside>
      <main class="desk-main">{open ?? <div class="empty desk-empty">Pick a session on the left.</div>}</main>
    </div>
  );
}

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
  // A tapped notification while the app is open: jump to its session.
  navigator.serviceWorker.addEventListener("message", (e) => {
    const url: unknown = e.data?.open;
    if (typeof url === "string") location.hash = url.includes("#") ? url.slice(url.indexOf("#")) : "#/";
  });
}

render(<App />, document.getElementById("app") as HTMLElement);
