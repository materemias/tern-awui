// The static demo's entry (build-demo.ts): the fake backend goes in first, then the real app starts.
// Module order is evaluation order, so the app's first fetch and stream already reach the demo.
import "./demo-install";
import "./app";
