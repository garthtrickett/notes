// The merge a compare-and-swap cannot do for itself.
//
// Two devices edit the same note before either pulls: both edits are wanted,
// neither overwrites the other, and yet the second push loses the swap. GitHub
// answers 409 and the app used to park the loser beside the winner as
// `name (conflict YYYY-MM-DD).md`. Five of those accumulated in one vault in a
// fortnight — the dump most often, because it is the file both devices write
// to daily.
//
// The first version merged only when both sides had purely inserted lines.
// That missed the ordinary case on 2026-10-06: the phone changed a reminder's
// time on one line while the laptop appended a line below it, and the result
// was a conflict copy for two edits that never touched.
//
// So this is a three-way line merge, the same idea as git's: work out what each
// side changed relative to the common base, and apply both when the changes
// are on different lines. When both sides changed the same lines differently
// it refuses — returns null — and the caller makes the copy it always made. A
// merge that guessed would be worse than a copy, because a copy is at least
// visibly unresolved.

const linesOf = (text: string): string[] => text.split("\n");

// What one side did to one stretch of base: base lines [from, to) became
// `lines`. from === to is a pure insertion before base[from].
interface Hunk {
  readonly from: number;
  readonly to: number;
  readonly lines: readonly string[];
}

// A note is at most a few thousand lines, and edits are local, so the common
// prefix and suffix are stripped before the quadratic part. Past this many
// cells it gives up rather than stall a push — the copy is still made.
const MAX_CELLS = 4_000_000;

// The changes `side` made to `base`, as hunks in base order, from a longest
// common subsequence of lines. Null if the notes are too large to compare.
const hunksAgainst = (base: readonly string[], side: readonly string[]): Hunk[] | null => {
  let head = 0;
  while (head < base.length && head < side.length && base[head] === side[head]) head += 1;
  let tail = 0;
  while (
    tail < base.length - head &&
    tail < side.length - head &&
    base[base.length - 1 - tail] === side[side.length - 1 - tail]
  ) {
    tail += 1;
  }
  const b = base.slice(head, base.length - tail);
  const s = side.slice(head, side.length - tail);
  if (b.length === 0 && s.length === 0) return [];
  if ((b.length + 1) * (s.length + 1) > MAX_CELLS) return null;

  // lcs[i][j] = LCS length of b[i..] and s[j..], flattened.
  const w = s.length + 1;
  const lcs = new Uint32Array((b.length + 1) * w);
  for (let i = b.length - 1; i >= 0; i -= 1) {
    for (let j = s.length - 1; j >= 0; j -= 1) {
      lcs[i * w + j] = b[i] === s[j]
        ? (lcs[(i + 1) * w + j + 1] as number) + 1
        : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number);
    }
  }

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let from = 0;
  let pending: string[] = [];
  let open = false;
  const close = () => {
    if (open) hunks.push({ from: head + from, to: head + i, lines: pending });
    open = false;
    pending = [];
  };
  while (i < b.length || j < s.length) {
    if (i < b.length && j < s.length && b[i] === s[j]) {
      close();
      i += 1;
      j += 1;
      continue;
    }
    if (!open) {
      open = true;
      from = i;
    }
    // Prefer dropping a base line when that keeps the LCS, so a replaced line
    // reads as one hunk rather than an insertion beside a deletion.
    if (j >= s.length || (i < b.length && (lcs[(i + 1) * w + j] as number) >= (lcs[i * w + j + 1] as number))) {
      i += 1;
    } else {
      pending.push(s[j] as string);
      j += 1;
    }
  }
  close();
  return hunks;
};

const sameLines = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((line, k) => line === b[k]);

// Two hunks are in each other's way when they rewrite overlapping base lines,
// or one inserts strictly inside a stretch the other rewrites. Touching is
// fine: an edit to a line and a line added straight after it — the 2026-10-06
// case — have an order nobody can dispute. (git calls that a conflict; it is
// stricter than this needs to be.)
const clash = (a: Hunk, c: Hunk): boolean => {
  const aInsert = a.from === a.to;
  const cInsert = c.from === c.to;
  if (aInsert && cInsert) return false; // same slot is handled by combining
  if (aInsert) return c.from < a.from && a.from < c.to;
  if (cInsert) return a.from < c.from && c.from < a.to;
  return a.from < c.to && c.from < a.to;
};

// Base is what both sides started from — the body at the note's baseSha.
// `ours` is this device's; `theirs` is what is on GitHub now.
//
// Two insertions in the same place keep theirs first, then ours, and a line
// both added there is kept once — two devices ticking the same check-in must
// not produce two of it. So a dump entry can sit out of time order until
// someone tidies it: the price of never inventing a position.
export const mergeLines = (
  base: string,
  ours: string,
  theirs: string,
): string | null => {
  const anchor = linesOf(base);
  const mine = hunksAgainst(anchor, linesOf(ours));
  const yours = hunksAgainst(anchor, linesOf(theirs));
  if (mine === null || yours === null) return null;

  for (const m of mine) {
    for (const y of yours) {
      if (!clash(m, y)) continue;
      // The same change made on both sides is agreement, not a conflict.
      if (m.from === y.from && m.to === y.to && sameLines(m.lines, y.lines)) continue;
      return null;
    }
  }

  // Walk base once, applying hunks from both sides in base order. At any
  // position, insertions go before a rewrite starting there.
  const out: string[] = [];
  let mi = 0;
  let yi = 0;
  let at = 0;
  while (at <= anchor.length) {
    const insertsHere = (hunks: Hunk[], k: number): readonly string[] => {
      const h = hunks[k];
      return h !== undefined && h.from === at && h.to === at ? h.lines : [];
    };
    const yIns = insertsHere(yours, yi);
    const mIns = insertsHere(mine, mi);
    if (yIns.length > 0 || mIns.length > 0) {
      out.push(...yIns);
      for (const line of mIns) if (!yIns.includes(line)) out.push(line);
      if (yours[yi]?.from === at && yours[yi]?.to === at) yi += 1;
      if (mine[mi]?.from === at && mine[mi]?.to === at) mi += 1;
      continue;
    }
    const y = yours[yi];
    const m = mine[mi];
    const rewrite = y !== undefined && y.from === at ? y : m !== undefined && m.from === at ? m : undefined;
    if (rewrite !== undefined) {
      out.push(...rewrite.lines);
      // An identical rewrite on the other side is the same edit; skip it too.
      if (y !== undefined && y.from === at) yi += 1;
      if (m !== undefined && m.from === at) mi += 1;
      at = rewrite.to;
      continue;
    }
    if (at < anchor.length) out.push(anchor[at] as string);
    at += 1;
  }
  return out.join("\n");
};
