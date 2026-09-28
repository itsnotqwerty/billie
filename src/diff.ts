/** Order-aware line diff via longest common subsequence. */

export interface LineDiff {
  /** Lines present in both inputs, in shared order. */
  common: string[];
  /** Lines present only in the first input. */
  onlyA: string[];
  /** Lines present only in the second input. */
  onlyB: string[];
}

/** Compute a simple line diff between two sequences. */
export function diffLines(a: string[], b: string[]): LineDiff {
  const m = a.length;
  const n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const common: string[] = [];
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      common.push(a[i]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      onlyA.push(a[i]);
      i++;
    } else {
      onlyB.push(b[j]);
      j++;
    }
  }
  while (i < m) onlyA.push(a[i++]);
  while (j < n) onlyB.push(b[j++]);
  return { common, onlyA, onlyB };
}
