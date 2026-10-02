import { describe, expect, it } from "bun:test";
import { beeperAvailable, listChats, parseChats, sendToChat } from "./beeper.ts";

describe("reading what the provider handed back", () => {
  it("takes the rows it can send to", () => {
    expect(
      parseChats({
        chats: [
          { roomId: "!a:beeper.com", title: "Mum", network: "whatsapp" },
          { roomId: "!b:beeper.com", title: "Connor", network: "signal" },
        ],
      }),
    ).toEqual([
      { roomId: "!a:beeper.com", title: "Mum", network: "whatsapp" },
      { roomId: "!b:beeper.com", title: "Connor", network: "signal" },
    ]);
  });

  it("drops a row with no room id, because it cannot be sent to", () => {
    // getColumnIndex returns -1 for a column the provider does not have, and
    // the Java side skips those — this is the same rule on the other side of
    // the bridge, for a provider that changes its columns.
    expect(parseChats({ chats: [{ title: "No id" }, { roomId: "", title: "Empty" }] })).toEqual([]);
  });

  it("names a chat that did not give one", () => {
    const [chat] = parseChats({ chats: [{ roomId: "!x:beeper.com" }] });
    expect(chat?.title).toBe("Unknown chat");
    expect(chat?.network).toBeNull();
  });

  it("survives anything that is not the shape it expects", () => {
    for (const junk of [null, undefined, 7, "chats", {}, { chats: null }, { chats: "x" }]) {
      expect(parseChats(junk)).toEqual([]);
    }
  });
});

describe("off a native shell", () => {
  it("knows Beeper is not reachable", () => {
    // Not a CORS problem that a proxy could fix: a ContentResolver query is
    // IPC between two installed Android apps, so a browser has nothing to call.
    expect(beeperAvailable()).toBe(false);
  });

  it("says so rather than throwing", async () => {
    const chats = await listChats();
    expect(chats.ok).toBe(false);
    const sent = await sendToChat("!a:beeper.com", "hello");
    expect(sent.ok).toBe(false);
  });

  it("refuses an empty message before it reaches the bridge", async () => {
    const sent = await sendToChat("!a:beeper.com", "   ");
    expect(sent.ok).toBe(false);
  });
});
