// Beeper, through the ContentProvider its Android app exposes.
//
// Android only, and not for the usual reason. This is not an HTTP API that the
// web could reach if CORS allowed it — a ContentResolver query is IPC between
// two installed apps, so there is nothing for a browser to call. On the web
// this module loads and reports that there is no Beeper here.
//
// Outbound only, and that is the API's shape rather than a decision made here:
// the provider lists chats and accepts a message, and does not expose message
// bodies. Nothing here can read a conversation.

import { Capacitor, registerPlugin } from "@capacitor/core";

export interface BeeperChat {
  readonly roomId: string;
  readonly title: string;
  readonly network: string | null;
}

interface BeeperNative {
  chats(): Promise<{ chats: BeeperChat[] }>;
  send(options: { roomId: string; text: string }): Promise<void>;
}

const native = registerPlugin<BeeperNative>("Beeper");

export const beeperAvailable = (): boolean => Capacitor.isNativePlatform();

// Parsed at the boundary: the bridge hands back whatever the provider's
// columns held, and a chat without a room id cannot be sent to.
export const parseChats = (value: unknown): BeeperChat[] => {
  if (typeof value !== "object" || value === null) return [];
  const list = "chats" in value ? value.chats : null;
  if (!Array.isArray(list)) return [];
  const chats: BeeperChat[] = [];
  for (const row of list) {
    if (typeof row !== "object" || row === null) continue;
    const roomId = "roomId" in row ? row.roomId : null;
    if (typeof roomId !== "string" || roomId === "") continue;
    const title = "title" in row && typeof row.title === "string" ? row.title : "";
    const network =
      "network" in row && typeof row.network === "string" ? row.network : null;
    chats.push({ roomId, title: title === "" ? "Unknown chat" : title, network });
  }
  return chats;
};

export type BeeperResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export const listChats = async (): Promise<BeeperResult<BeeperChat[]>> => {
  if (!beeperAvailable()) {
    return { ok: false, error: "Beeper is only reachable from the Android app." };
  }
  try {
    return { ok: true, value: parseChats(await native.chats()) };
  } catch (cause) {
    return { ok: false, error: messageOf(cause) };
  }
};

export const sendToChat = async (
  roomId: string,
  text: string,
): Promise<BeeperResult<void>> => {
  if (!beeperAvailable()) {
    return { ok: false, error: "Beeper is only reachable from the Android app." };
  }
  if (text.trim() === "") return { ok: false, error: "Nothing to send." };
  try {
    await native.send({ roomId, text });
    return { ok: true, value: undefined };
  } catch (cause) {
    return { ok: false, error: messageOf(cause) };
  }
};

// A rejected plugin call arrives as an Error whose message is what the Java
// side passed to reject(). Anything else is not worth guessing at.
const messageOf = (cause: unknown): string =>
  cause instanceof Error && cause.message !== ""
    ? cause.message
    : "Beeper could not be reached.";
