import { assertEquals } from "@std/assert";

const root = new URL("../", import.meta.url);

async function read(relative: string): Promise<string> {
  return await Deno.readTextFile(new URL(relative, root));
}

Deno.test("application and package versions cannot drift", async () => {
  const application = JSON.parse(await read("deno.json")).version;
  const manifests: Array<[string, RegExp]> = [
    ["packaging/aur/PKGBUILD", /^pkgver=(.+)$/m],
    ["packaging/aur/.SRCINFO", /^\s*pkgver = (.+)$/m],
    ["packaging/debian/control", /^Version: (.+)$/m],
    ["packaging/nix/package.nix", /^\s*version = "(.+)";$/m],
    ["packaging/rpm/billie.spec", /^Version:\s+(.+)$/m],
  ];
  for (const [path, pattern] of manifests) {
    const match = pattern.exec(await read(path));
    assertEquals(
      match?.[1],
      application,
      `${path} must use the deno.json version ${application}`,
    );
  }
});
