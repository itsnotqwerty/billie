import { assertEquals } from "@std/assert";
import { columnWidth, pairColumns, sideBySide } from "./columns.ts";

Deno.test("columnWidth splits the terminal into two equal columns", () => {
  assertEquals(columnWidth(83), 40);
  assertEquals(columnWidth(10), 8);
});

Deno.test("pairColumns pads the left cell and clips both sides", () => {
  const row = pairColumns("alpha", "beta-and-more", 23);
  assertEquals(columnWidth(23), 10);
  assertEquals(row, "alpha".padEnd(10) + " | " + "beta-and-m");
});

Deno.test("sideBySide aligns unequal columns with blank padding", () => {
  const rows = sideBySide(["one", "two"], ["only"], 23);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].startsWith("one"), true);
  assertEquals(rows[0].includes("only"), true);
  assertEquals(rows[1].trimEnd().endsWith("|"), true);
});
