import { stripHtml } from "./html.ts";
import { assertEquals } from "@std/assert";

Deno.test("stripHtml removes tags and preserves block breaks", () => {
  const html = "<html><body><p>Hello <b>world</b>.</p><p>Second paragraph.</p></body></html>";
  assertEquals(stripHtml(html), "Hello world.\nSecond paragraph.");
});

Deno.test("stripHtml drops script and style blocks", () => {
  const html = "<style>.x{color:red}</style><p>Visible</p><script>alert(1)</script>";
  assertEquals(stripHtml(html), "Visible");
});

Deno.test("stripHtml decodes common entities", () => {
  assertEquals(
    stripHtml("<p>Tom &amp; Jerry &mdash;? &lt;ok&gt; &#65;</p>"),
    "Tom & Jerry &mdash;? <ok> A",
  );
});

Deno.test("stripHtml collapses repeated blank lines", () => {
  const html = "<p>One</p><br><br><br><p>Two</p>";
  assertEquals(stripHtml(html), "One\n\nTwo");
});
