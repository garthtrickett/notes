export interface LookupCapture {
  readonly id: string;
  readonly day: string;
  readonly time: string;
  readonly text: string;
  readonly kind?: "jot";
}
const UUID = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
export const validLookupId = (id: string): boolean => new RegExp(`^${UUID}$`).test(id);

export const parseLookupCaptures = (raw: unknown): readonly LookupCapture[] => {
  if (!raw || typeof raw !== "object" || !("captures" in raw) || !Array.isArray(raw.captures))
    throw new Error("Invalid saved questions.");
  const seen = new Set<string>();
  return raw.captures.map((value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Invalid saved question.");
    const c = value as Record<string, unknown>;
    if (typeof c.id !== "string" || !new RegExp(`^${UUID}$`).test(c.id) || seen.has(c.id) ||
        typeof c.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.day) ||
        !Number.isFinite(Date.parse(c.day)) || new Date(c.day).toISOString().slice(0, 10) !== c.day ||
        typeof c.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(c.time) ||
        typeof c.text !== "string" || !c.text.trim() || c.text.length > 2000 ||
        (c.kind !== undefined && c.kind !== "lookup" && c.kind !== "jot"))
      throw new Error("Invalid saved question.");
    seen.add(c.id);
    return { id: c.id, day: c.day, time: c.time, text: c.text, ...(c.kind === "jot" ? { kind: "jot" as const } : {}) };
  });
};

const captureSection = (body: string, name: "Lookup" | "Jotted Down"): { heading: number; end: number } => {
  const headingPattern = new RegExp(`^ {0,3}##[ \\t]+${name}[ \\t]*(?:#+[ \\t]*)?\\r?\\n?$`, "i");
  let fence: { char: string; size: number; start: number } | null = null;
  let heading = -1, end = body.length, offset = 0;
  for (const value of body.split(/(?<=\n)/)) {
    const code = /^ {0,3}(`{3,}|~{3,})/.exec(value);
    if (code) {
      const char = code[1]![0]!;
      if (!fence) fence = { char, size: code[1]!.length, start: offset };
      else if (fence.char === char && code[1]!.length >= fence.size && /^ {0,3}(?:`+|~+)\s*$/.test(value)) fence = null;
    } else if (!fence) {
      if (headingPattern.test(value) && heading < 0) heading = offset;
      else if (heading >= 0 && /^ {0,3}#{1,2}[ \t]+/.test(value)) { end = offset; break; }
    }
    offset += value.length;
  }
  return { heading, end: fence ? fence.start : end };
};

export const lookupHeadingOffset = (body: string): number => captureSection(body, "Lookup").heading;
export const widgetHeadingOffset = (body: string): number => {
  const headings = [lookupHeadingOffset(body), captureSection(body, "Jotted Down").heading].filter(at => at >= 0);
  return headings.length === 0 ? -1 : Math.min(...headings);
};

// Insert in the first real Lookup section, before the next peer heading.
// Fenced code, including an unfinished block, stays intact.
const appendCapture = (body: string, capture: LookupCapture, heading: "Lookup" | "Jotted Down"): string => {
  const question = capture.text.trim().replace(/\s+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const line = `- ${capture.time} ${question}\n`;
  const section = captureSection(body, heading);
  const before = body.slice(0, section.end).replace(/\n*$/, "");
  const after = body.slice(section.end);
  if (section.heading < 0) return `${before}${before.trim() ? "\n\n" : ""}## ${heading}\n\n${line}${after ? "\n" + after : ""}`;
  return `${before}\n${line}${after ? "\n" + after : ""}`;
};

export const appendLookup = (body: string, capture: LookupCapture): string => appendCapture(body, capture, "Lookup");
export const appendWidgetCapture = (body: string, capture: LookupCapture): string =>
  appendCapture(body, capture, capture.kind === "jot" ? "Jotted Down" : "Lookup");
