import { assertEquals, assertRejects } from "@std/assert";
import { MicroEditor, NoteDrafts } from "./editor.ts";

Deno.test("note drafts are private, recoverable, renamed atomically, and explicitly discarded", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const drafts = new NoteDrafts(`${directory}/drafts`);
    const draft = await drafts.create({
      notebookId: "notebook",
      noteId: "note",
      revision: 3,
      title: "Research",
      body: "# Private\n",
    });
    assertEquals(await drafts.read(draft), "# Private\n");
    for (const folder of [drafts.root, draft.directory]) {
      assertEquals((await Deno.stat(folder)).mode! & 0o777, 0o700);
    }
    for (const file of [draft.filePath, `${draft.directory}/draft.json`]) {
      assertEquals((await Deno.stat(file)).mode! & 0o777, 0o600);
    }
    const updated = await drafts.rename(draft, "Renamed");
    assertEquals(await new NoteDrafts(drafts.root).latest("notebook"), updated);
    assertEquals(await drafts.latest("other"), null);
    await drafts.discard(updated);
    assertEquals(await drafts.latest("notebook"), null);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("draft reading rejects symlink files without deleting the target", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const drafts = new NoteDrafts(`${directory}/drafts`);
    const draft = await drafts.create({
      notebookId: "notebook",
      noteId: null,
      revision: null,
      title: "New",
      body: "",
    });
    const target = `${directory}/precious.md`;
    await Deno.writeTextFile(target, "Keep");
    await Deno.remove(draft.filePath);
    await Deno.symlink(target, draft.filePath);
    await assertRejects(() => drafts.read(draft), Error, "regular Markdown");
    await drafts.discard(draft);
    assertEquals(await Deno.readTextFile(target), "Keep");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("micro runtime is available for note editing", async () => {
  await new MicroEditor().check();
});
