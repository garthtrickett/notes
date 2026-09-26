// The merge a compare-and-swap cannot do for itself.
//
// Two devices append to the same note before either pulls: both edits are
// wanted, neither overwrites the other, and yet the second push loses the
// swap. GitHub answers 409 and the app used to park the loser beside the
// winner as `name (conflict YYYY-MM-DD).md`. Five of those accumulated in one
// vault in a fortnight, two of them on the same day — the dump most often,
// because it is the file both devices write to daily, but a note of links did
// it too.
//
// This handles exactly one case and refuses the rest: **both sides only
// inserted lines**. That is provable rather than guessed — base has to appear,
// in order, in each side — and it is what every observed conflict actually
// was. Anything else (a line edited, a line deleted, lines reordered) returns
// null, and the caller keeps the copy it makes today. A merge that guessed
// would be worse than a copy, because a copy is at least visibly unresolved.

const linesOf = (text: string): string[] => text.split("\n");

// Where each side put its new lines, relative to base.
//
// Slot `i` holds what goes before `base[i]`; slot `base.length` holds the tail.
// Null when base is not a subsequence of the side, which is the signal that
// something was edited, deleted or moved rather than added — leftmost-greedy
// matching is exactly the subsequence test, so this cannot be fooled by a
// repeated line.
const insertionsAgainst = (
  base: readonly string[],
  side: readonly string[],
): string[][] | null => {
  const slots: string[][] = Array.from({ length: base.length + 1 }, () => []);
  let at = 0;
  for (const line of side) {
    if (at < base.length && line === base[at]) {
      at += 1;
      continue;
    }
    (slots[at] as string[]).push(line);
  }
  return at === base.length ? slots : null;
};

// Base is what both sides started from — the body at the note's baseSha.
// `ours` is this device's; `theirs` is what is on GitHub now.
//
// Order within a slot is theirs, then ours. So a line this device added while
// the other device was also adding lands after them rather than in whatever
// order it would have been written in — a dump entry can therefore sit out of
// time order until someone tidies it. That is the price of never inventing a
// position, and it is a smaller price than a second file.
export const mergeInsertions = (
  base: string,
  ours: string,
  theirs: string,
): string | null => {
  const anchor = linesOf(base);
  const mine = insertionsAgainst(anchor, linesOf(ours));
  const yours = insertionsAgainst(anchor, linesOf(theirs));
  if (mine === null || yours === null) return null;

  const out: string[] = [];
  for (let i = 0; i <= anchor.length; i += 1) {
    const remote = yours[i] as string[];
    const local = mine[i] as string[];
    out.push(...remote);
    // A line both devices added in the same place is one line, not two. This is
    // the common case for a tick: the same `- [x] Morning check-in` written
    // twice should not become two.
    for (const line of local) if (!remote.includes(line)) out.push(line);
    if (i < anchor.length) out.push(anchor[i] as string);
  }
  return out.join("\n");
};
