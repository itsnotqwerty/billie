import {
  decodeKeyStream,
  KeyDecoder,
  parseKeys,
  sanitizeTerminalText,
  truncate,
  wrap,
} from "./terminal.ts";
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

Deno.test("terminal content strips CSI, OSC, C1, and embedded line controls", () => {
  assertEquals(sanitizeTerminalText("before\x1b[2Jafter\r\n\t\x00"), "beforeafter");
  assertEquals(sanitizeTerminalText("\x1b]52;c;dGVzdA==\x07text"), "text");
  assertEquals(
    sanitizeTerminalText("\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\"),
    "link",
  );
  assertEquals(sanitizeTerminalText("\x9b2Jhello\x85world"), "helloworld");
  assertEquals(sanitizeTerminalText("Legislation: café"), "Legislation: café");
});

Deno.test("KeyDecoder handles every chunk boundary for UTF-8 and escape sequences", () => {
  const bytes = new TextEncoder().encode("é日😀\x1b[A\x1b[6~\x1bOHtext");
  const expected = parseKeys(bytes);
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new KeyDecoder();
    assertEquals([
      ...decoder.push(bytes.slice(0, split)),
      ...decoder.push(bytes.slice(split)),
      ...decoder.finish(),
    ], expected);
  }
  const decoder = new KeyDecoder();
  assertEquals([...bytes].flatMap((byte) => decoder.push(new Uint8Array([byte]))), expected);
});

Deno.test("KeyDecoder flushes standalone Escape without flushing incomplete UTF-8", () => {
  const decoder = new KeyDecoder();
  assertEquals(decoder.push(new Uint8Array([0x1b])), []);
  assertEquals(decoder.awaitingEscape, true);
  assertEquals(decoder.flushEscape(), [{ kind: "escape" }]);
  assertEquals(decoder.push(new Uint8Array([0xc3])), []);
  assertEquals(decoder.awaitingEscape, false);
  assertEquals(decoder.push(new Uint8Array([0xa9])), [{ kind: "char", value: "é" }]);
});

Deno.test("decodeKeyStream emits Escape on timeout and reuses the pending read", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => release = resolve);
  async function* chunks() {
    yield new Uint8Array([0x1b]);
    await pending;
    yield new TextEncoder().encode("q");
  }
  const keys = decodeKeyStream(chunks(), 1);
  assertEquals((await keys.next()).value, { kind: "escape" });
  release();
  assertEquals((await keys.next()).value, { kind: "char", value: "q" });
  assertEquals((await keys.next()).done, true);
});
