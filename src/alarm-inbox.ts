import { parseAnswers } from "./alarms.ts";
import type { Loop } from "./loop.ts";

// One finite handoff. Repeated native delivery is intentional; task occurrence
// tokens make replay harmless. A failed local save never acknowledges it.
export const receiveAlarmAnswers = async (
  loop: Pick<Loop, "propose" | "whenSaved">,
  read: () => Promise<unknown>,
  acknowledge: (receipts: string[]) => Promise<void>,
): Promise<boolean> => {
  try {
    const raw = await read();
    const answers = parseAnswers(raw);
    if (answers.length > 0) loop.propose({ kind: "alarmAnswered", answers });
    if (!await loop.whenSaved()) return false;
    const receipts = Array.isArray(raw) ? raw.flatMap(item => item && typeof item.receipt === "string" ? [item.receipt] : []) : [];
    await acknowledge(receipts);
    return true;
  } catch { return false; } // The native copy is retained for the next resume.
};
