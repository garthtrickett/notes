import { GlobalRegistrator } from "@happy-dom/global-registrator";
import "fake-indexeddb/auto";

GlobalRegistrator.register();

// happy-dom registers after fake-indexeddb, so re-attach the shim to the window
// it just installed.
const fake = await import("fake-indexeddb");
globalThis.indexedDB = fake.indexedDB;
globalThis.IDBKeyRange = fake.IDBKeyRange;
