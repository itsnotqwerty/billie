import { parseKeys, truncate, wrap } from "./terminal.ts";
import { assertEquals } from "@std/assert";

Deno.test("parseKeys decodes printable characters", () => {
  assertEquals(parseKeys(new TextEncoder().encode("hi")), [
    { kind: "char", value: "h" },
    { kind: "char", value: "i" },
  ]);
});

Deno.test("parseKeys decodes arrow keys and escape", () => {
  assertEquals(parseKeys(new Uint8Array([0x1b, 0x5b, 0x41])), [{ kind: "up" }]);
  assertEquals(parseKeys(new Uint8Array([0x1b, 0x5b, 0x42])), [{ kind: "down" }]);
  assertEquals(parseKeys(new Uint8Array([0x1b])), [{ kind: "escape" }]);
});

Deno.test("parseKeys decodes page, home, and end keys", () => {
  assertEquals(parseKeys(new Uint8Array([0x1b, 0x5b, 0x35, 0x7e])), [{ kind: "pageup" }]);
  assertEquals(parseKeys(new Uint8Array([0x1b, 0x5b, 0x36, 0x7e])), [{ kind: "pagedown" }]);
  assertEquals(parseKeys(new Uint8Array([0x1b, 0x5b, 0x48])), [{ kind: "home" }]);
  assertEquals(parseKeys(new Uint8Array([0x1b, 0x5b, 0x46])), [{ kind: "end" }]);
  assertEquals(parseKeys(new Uint8Array([0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x48])), [{ kind: "home" }]);
  assertEquals(parseKeys(new Uint8Array([0x1b, 0x4f, 0x48])), [{ kind: "home" }]);
  assertEquals(parseKeys(new Uint8Array([0x1b, 0x4f, 0x46])), [{ kind: "end" }]);
});

Deno.test("parseKeys decodes enter, backspace, and ctrl-c", () => {
  assertEquals(parseKeys(new Uint8Array([0x0d])), [{ kind: "enter" }]);
  assertEquals(parseKeys(new Uint8Array([0x7f])), [{ kind: "backspace" }]);
  assertEquals(parseKeys(new Uint8Array([0x03])), [{ kind: "ctrl", value: "c" }]);
});

Deno.test("parseKeys decodes multi-byte characters", () => {
  assertEquals(parseKeys(new TextEncoder().encode("é")), [{ kind: "char", value: "é" }]);
});

Deno.test("truncate clips to the given width", () => {
  assertEquals(truncate("hello world", 5), "hello");
  assertEquals(truncate("hi", 5), "hi");
});

Deno.test("wrap splits long text across lines with indentation", () => {
  const lines = wrap("alpha beta gamma delta epsilon", 16, "  ");
  assertEquals(lines.every((line) => line.length <= 16), true);
  assertEquals(lines.every((line) => line.startsWith("  ")), true);
  assertEquals(lines.join(" ").replace(/\s+/g, " ").trim(), "alpha beta gamma delta epsilon");
});
