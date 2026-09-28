/** Convert bill-text HTML/XML markup into readable plain text for the terminal. */

const SCRIPT_STYLE = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi;
const BLOCK_BREAK = /<\/(p|div|li|h[1-6]|tr|section|article|body)>|<br\s*\/?>/gi;
const TAG = /<[^>]+>/g;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const codePoint = code[1] === "x" || code[1] === "X"
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Strip tags/scripts, decode entities, and collapse blank lines from an HTML/XML document. */
export function stripHtml(html: string): string {
  const withoutScripts = html.replace(SCRIPT_STYLE, " ");
  const withBreaks = withoutScripts.replace(BLOCK_BREAK, "\n");
  const withoutTags = withBreaks.replace(TAG, "");
  const decoded = decodeEntities(withoutTags);
  const lines = decoded.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim());
  const collapsed: string[] = [];
  for (const line of lines) {
    if (line.length === 0 && collapsed[collapsed.length - 1] === "") continue;
    collapsed.push(line);
  }
  return collapsed.join("\n").trim();
}
