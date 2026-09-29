/** Minimal raw-mode terminal layer: key parsing and full-screen line rendering. */

import { stripVTControlCharacters } from "node:util";

export type Key =
  | { kind: "char"; value: string }
  | {
    kind:
      | "up"
      | "down"
      | "left"
      | "right"
      | "enter"
      | "escape"
      | "backspace"
      | "tab"
      | "pageup"
      | "pagedown"
      | "home"
      | "end";
  }
  | { kind: "ctrl"; value: string };

/**
 * Parse a CSI sequence starting at its ESC byte.
 * Returns the key and how many bytes the whole escape sequence consumed, or null
 * when the sequence is incomplete or unrecognized.
 */
function parseCsi(bytes: Uint8Array, start: number): { key: Key; length: number } | null {
  // start points at ESC. Sequence is ESC [ params final.
  let i = start + 2;
  const params: number[] = [];
  let current = 0;
  let sawDigit = false;
  while (i < bytes.length) {
    const code = bytes[i];
    if (code >= 0x30 && code <= 0x39) {
      current = current * 10 + (code - 0x30);
      sawDigit = true;
      i += 1;
      continue;
    }
    if (code === 0x3b) {
      params.push(sawDigit ? current : 0);
      current = 0;
      sawDigit = false;
      i += 1;
      continue;
    }
    if (code >= 0x40 && code <= 0x7e) {
      if (sawDigit) params.push(current);
      const length = i - start + 1;
      if (code === 0x41) return { key: { kind: "up" }, length };
      if (code === 0x42) return { key: { kind: "down" }, length };
      if (code === 0x43) return { key: { kind: "right" }, length };
      if (code === 0x44) return { key: { kind: "left" }, length };
      if (code === 0x48) return { key: { kind: "home" }, length };
      if (code === 0x46) return { key: { kind: "end" }, length };
      if (code === 0x7e) {
        const fn = params[0];
        if (fn === 5 || fn === 6) {
          return { key: { kind: fn === 5 ? "pageup" : "pagedown" }, length };
        }
        if (fn === 1 || fn === 7) return { key: { kind: "home" }, length };
        if (fn === 4 || fn === 8) return { key: { kind: "end" }, length };
        if (fn === 3) return { key: { kind: "backspace" }, length };
      }
      return { key: { kind: "escape" }, length };
    }
    return null;
  }
  return null;
}

/** Parse a chunk of raw stdin bytes into key events. */
export function parseKeys(bytes: Uint8Array): Key[] {
  const keys: Key[] = [];
  const decoder = new TextDecoder();
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i];
    if (byte === 0x1b) {
      if (bytes[i + 1] === 0x5b) {
        const parsed = parseCsi(bytes, i);
        if (!parsed) {
          keys.push({ kind: "escape" });
          i += 1;
          continue;
        }
        keys.push(parsed.key);
        i += parsed.length;
        continue;
      }
      if (bytes[i + 1] === 0x4f) {
        const code = bytes[i + 2];
        if (code === 0x48) keys.push({ kind: "home" });
        else if (code === 0x46) keys.push({ kind: "end" });
        else keys.push({ kind: "escape" });
        i += code === 0x48 || code === 0x46 ? 3 : 1;
        continue;
      }
      keys.push({ kind: "escape" });
      i += 1;
      continue;
    }
    if (byte === 0x0d || byte === 0x0a) {
      keys.push({ kind: "enter" });
      i += 1;
      continue;
    }
    if (byte === 0x7f || byte === 0x08) {
      keys.push({ kind: "backspace" });
      i += 1;
      continue;
    }
    if (byte === 0x09) {
      keys.push({ kind: "tab" });
      i += 1;
      continue;
    }
    if (byte < 0x20) {
      keys.push({ kind: "ctrl", value: String.fromCharCode(byte + 0x60) });
      i += 1;
      continue;
    }
    let length = 1;
    if (byte >= 0xf0) length = 4;
    else if (byte >= 0xe0) length = 3;
    else if (byte >= 0xc0) length = 2;
    keys.push({ kind: "char", value: decoder.decode(bytes.subarray(i, i + length)) });
    i += length;
  }
  return keys;
}

export function sanitizeTerminalText(text: string): string {
  return stripVTControlCharacters(text).replace(/\p{Cc}/gu, "");
}

export class KeyDecoder {
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private pending = "";

  get awaitingEscape(): boolean {
    return this.pending.startsWith("\x1b");
  }

  push(bytes: Uint8Array): Key[] {
    this.pending += this.decoder.decode(bytes, { stream: true });
    return this.drain(false);
  }

  flushEscape(): Key[] {
    return this.drain(true);
  }

  finish(): Key[] {
    this.pending += this.decoder.decode();
    return this.drain(true);
  }

  private drain(flush: boolean): Key[] {
    let end = 0;
    while (end < this.pending.length) {
      if (this.pending[end] !== "\x1b") {
        end++;
        continue;
      }
      const remaining = this.pending.slice(end);
      if (
        !flush && (remaining.length === 1 || remaining === "\x1bO" ||
          /^\[[0-?]*[ -/]*$/.test(remaining.slice(1)))
      ) break;
      const sequence = /^\[[0-?]*[ -/]*[@-~]/.exec(remaining.slice(1));
      end += sequence ? sequence[0].length + 1 : (remaining.startsWith("\x1bO") ? 3 : 1);
    }
    const complete = this.pending.slice(0, end);
    this.pending = this.pending.slice(end);
    return parseKeys(this.encoder.encode(complete));
  }
}

export async function* decodeKeyStream(
  chunks: AsyncIterable<Uint8Array>,
  escapeDelayMs = 40,
): AsyncGenerator<Key> {
  const decoder = new KeyDecoder();
  const iterator = chunks[Symbol.asyncIterator]();
  let next = iterator.next();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let chunk: IteratorResult<Uint8Array> | null;
    try {
      chunk = decoder.awaitingEscape
        ? await Promise.race([
          next,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), escapeDelayMs);
          }),
        ])
        : await next;
    } finally {
      clearTimeout(timer);
    }
    if (chunk === null) {
      yield* decoder.flushEscape();
    } else if (chunk.done) {
      yield* decoder.finish();
      return;
    } else {
      yield* decoder.push(chunk.value);
      next = iterator.next();
    }
  }
}

export function truncate(line: string, width: number): string {
  return [...line].slice(0, Math.max(0, width)).join("");
}

export function wrap(text: string, width: number, indent = ""): string[] {
  const limit = Math.max(10, width - indent.length);
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = indent;
  for (const word of words) {
    if (current.trim().length > 0 && current.length + word.length + 1 > limit) {
      lines.push(current);
      current = indent + word;
    } else {
      current = current.trim().length === 0 ? indent + word : `${current} ${word}`;
    }
  }
  if (current.trim().length > 0) lines.push(current);
  return lines.length > 0 ? lines : [indent];
}

export class Terminal {
  private readonly encoder = new TextEncoder();

  size(): { columns: number; rows: number } {
    return Deno.consoleSize();
  }

  enter(): void {
    if (!Deno.stdin.isTerminal()) {
      throw new Error("billie requires an interactive terminal (TTY).");
    }
    Deno.stdin.setRaw(true);
    this.write("\x1b[?1049h\x1b[?25l\x1b[2J");
  }

  exit(): void {
    this.write("\x1b[?25h\x1b[?1049l");
    try {
      Deno.stdin.setRaw(false);
    } catch {
      // Already restored.
    }
  }

  write(text: string): void {
    Deno.stdout.writeSync(this.encoder.encode(text));
  }

  /** Repaint the whole screen from an array of lines, clipped to the terminal size. */
  render(lines: string[]): void {
    const { columns, rows } = Deno.consoleSize();
    const out = ["\x1b[H"];
    for (let row = 0; row < rows; row++) {
      out.push("\x1b[2K" + truncate(sanitizeTerminalText(lines[row] ?? ""), columns));
      if (row < rows - 1) out.push("\r\n");
    }
    this.write(out.join(""));
  }

  async *keys(): AsyncGenerator<Key> {
    yield* decodeKeyStream(this.chunks());
  }

  private async *chunks(): AsyncGenerator<Uint8Array> {
    const buffer = new Uint8Array(64);
    while (true) {
      const count = await Deno.stdin.read(buffer);
      if (count === null) return;
      yield buffer.slice(0, count);
    }
  }
}
