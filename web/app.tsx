import { render } from "preact";
import { routeHash } from "./lib";
import { useRoute, useWide } from "./hooks";
import { Home } from "./home";
import { Session, SubagentScreen } from "./session";

function App() {
  const route = useRoute();
  const wide = useWide();
  const key = routeHash(route);
  const open =
    route.view === "list" ? null : route.view === "session" ? <Session key={key} block={route.block} /> : <SubagentScreen key={key} route={route} />;
  if (!wide) return open ?? <Home />;
  return (
    <div class="desk">
      <aside class="desk-side">
        <Home wide selected={route.view === "list" ? null : route.block} />
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
