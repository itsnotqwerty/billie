/** In-document find: locate a query in displayed bill text and jump between hits. */

export interface FindHit {
  /** 0 = the only or left column, 1 = the right column of a comparison. */
  side: 0 | 1;
  /** Line index in that column's source text (not the padded side-by-side row). */
  line: number;
}

/** Case-insensitive hits across one or two texts. An empty query matches nothing. */
export function findInTexts(texts: readonly string[], query: string): FindHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const hits: FindHit[] = [];
  for (let side = 0; side < texts.length && side < 2; side++) {
    const lines = texts[side].split("\n");
    for (let line = 0; line < lines.length; line++) {
      if (lines[line].toLowerCase().includes(needle)) {
        hits.push({ side: side as 0 | 1, line });
      }
    }
  }
  return hits;
}

/** Next or previous hit index, wrapping around. Returns -1 when there are no hits. */
export function stepHit(count: number, current: number, delta: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta < 0 ? count - 1 : 0;
  return (current + delta + count) % count;
}
