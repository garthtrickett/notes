import "./style.css";
import { openDb } from "./idb.ts";
import { boot } from "./loop.ts";

const root = document.getElementById("app");
if (!root) throw new Error("#app is missing from index.html");

// The only place that reaches for ambient state. Everything below is handed
// what it needs (principle 5).
await boot(await openDb(), root);
