import { diffLines } from "./diff.ts";
import { assertEquals } from "@std/assert";

Deno.test("diffLines handles empty inputs", () => {
  assertEquals(diffLines([], []), { common: [], onlyA: [], onlyB: [] });
  assertEquals(diffLines(["a"], []), { common: [], onlyA: ["a"], onlyB: [] });
  assertEquals(diffLines([], ["b"]), { common: [], onlyA: [], onlyB: ["b"] });
});

Deno.test("diffLines finds common, added, and removed lines", () => {
  const result = diffLines(["one", "two", "three"], ["two", "four"]);
  assertEquals(result.common, ["two"]);
  assertEquals(result.onlyA, ["one", "three"]);
  assertEquals(result.onlyB, ["four"]);
});

Deno.test("diffLines keeps shared lines in order", () => {
  const result = diffLines(["a", "b", "c"], ["a", "c"]);
  assertEquals(result.common, ["a", "c"]);
  assertEquals(result.onlyA, ["b"]);
  assertEquals(result.onlyB, []);
});

Deno.test("diffLines on identical inputs reports all common", () => {
  const result = diffLines(["x", "y"], ["x", "y"]);
  assertEquals(result.common, ["x", "y"]);
  assertEquals(result.onlyA, []);
  assertEquals(result.onlyB, []);
});
