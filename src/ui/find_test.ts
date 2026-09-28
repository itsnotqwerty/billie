import { findInTexts, stepHit } from "./find.ts";
import { assertEquals } from "@std/assert";

Deno.test("findInTexts is case-insensitive and skips an empty query", () => {
  const hits = findInTexts(
    ["Section 1\nThe Secretary shall", "SECTION 2 — Definitions"],
    "section",
  );
  assertEquals(hits, [
    { side: 0, line: 0 },
    { side: 1, line: 0 },
  ]);
  assertEquals(findInTexts(["alpha"], "   "), []);
  assertEquals(findInTexts(["alpha"], "missing"), []);
});

Deno.test("findInTexts searches the left text before the right", () => {
  const hits = findInTexts(["no\nhit here", "hit\nalso hit"], "hit");
  assertEquals(hits, [
    { side: 0, line: 1 },
    { side: 1, line: 0 },
    { side: 1, line: 1 },
  ]);
});

Deno.test("stepHit wraps and starts from either end", () => {
  assertEquals(stepHit(0, -1, 1), -1);
  assertEquals(stepHit(3, -1, 1), 0);
  assertEquals(stepHit(3, -1, -1), 2);
  assertEquals(stepHit(3, 2, 1), 0);
  assertEquals(stepHit(3, 0, -1), 2);
});
