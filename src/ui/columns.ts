/** Side-by-side column layout for the comparison text view. */

import { truncate } from "./terminal.ts";

const GUTTER = " | ";

/** Split a terminal width into two equal text columns, accounting for the gutter. */
export function columnWidth(totalWidth: number): number {
  return Math.max(8, Math.floor((Math.max(totalWidth, 0) - GUTTER.length) / 2));
}

/** Place two strings on one row, each clipped to its column. */
export function pairColumns(left: string, right: string, width: number): string {
  const col = columnWidth(width);
  return truncate(left, col).padEnd(col) + GUTTER + truncate(right, col);
}

/**
 * Zip two line lists into side-by-side rows. The shorter side is padded with
 * blank cells so both columns stay aligned.
 */
export function sideBySide(left: string[], right: string[], width: number): string[] {
  const rows = Math.max(left.length, right.length);
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) {
    lines.push(pairColumns(left[i] ?? "", right[i] ?? "", width));
  }
  return lines;
}
