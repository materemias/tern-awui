import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { routeHash } from "./lib";
import { useRoute, useWide } from "./hooks";
import { Home } from "./home";
import { Session, SubagentScreen } from "./session";

/** The desktop sidebar minimized to a rail of session icons, remembered on this device. */
const RAIL_KEY = "tern-mobile:sidebar-rail";

function App() {
  const route = useRoute();
  const wide = useWide();
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
  const key = routeHash(route);
  const open =
    route.view === "list" ? null : route.view === "session" ? <Session key={key} block={route.block} /> : <SubagentScreen key={key} route={route} />;
  if (!wide) return open ?? <Home />;
  return (
    <div class={`desk${rail ? " rail" : ""}`}>
      <aside class="desk-side">
        <Home wide rail={rail} onRail={toggleRail} selected={route.view === "list" ? null : route.block} />
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
