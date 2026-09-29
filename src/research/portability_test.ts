import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { ResearchStore } from "./store.ts";
import { exportResearch, resumeImport, stageImport } from "./portability.ts";

Deno.test("research archives stream entire notebooks and round trip remapped relationships", async () => {
  const directory = await Deno.makeTempDir();
  const store = await ResearchStore.open(`${directory}/source/db`);
  const target = await ResearchStore.open(`${directory}/target/db`);
  try {
    const notebook = store.createNotebook("Portable", "Description");
    store.createSearch({
      name: "Search",
      query: "health",
      type: null,
      congress: { mode: "current" },
    });
    for (let offset = 0; offset < 10000; offset += 250) {
      store.addReferences(
        notebook.id,
        Array.from(
          { length: 250 },
          (_, index) => ({ congress: 119, type: "hr", number: offset + index + 1 }),
        ),
      );
    }
    const ids = store.listReferences(notebook.id, { limit: 250 }).items.map((ref) => ref.id);
    const ref = store.listReferences(notebook.id).items[0];
    store.saveMetadata(ref.id, {
      ...ref,
      title: "Offline provenance",
      url: "https://www.congress.gov/bill/119th-congress/house-bill/1",
      updateDate: "2026-09-01",
      sponsors: [],
      actions: [],
      subjects: [],
      completeness: { actions: "partial", subjects: "unavailable" },
    }, "2026-09-28T00:00:00Z");
    store.failMetadata(ref.id, "2026-09-29T00:00:00Z");
    const note = store.createNote(notebook.id, {
      title: "Findings",
      body: "# Verbatim\n\nMy notes\n",
    }, ids);
    const file = await exportResearch(store, `${directory}/exports`, "json");
    const payload = JSON.parse(await Deno.readTextFile(file));
    assertEquals(payload.version, 1);
    const stage = await stageImport(target, file);
    const controller = new AbortController();
    const interrupted = resumeImport(target, stage, controller.signal, () => controller.abort());
    await assertRejects(() => interrupted, Error, "250 committed records");
    const total = await resumeImport(target, stage);
    assertEquals(await resumeImport(target, stage), total);
    const imported = target.listNotebooks().items[0];
    assertEquals(imported.id === notebook.id, false);
    assertEquals(target.countReferences(imported.id), 10000);
    const importedNote = target.listNotes(imported.id).items[0];
    assertEquals(target.getNote(importedNote.id)!.body, note.body);
    assertEquals(target.countCitations(importedNote.id), 250);
    const importedRef = target.listReferences(imported.id, { query: `119 hr${ref.number}` }).items
      .find((item) => item.number === ref.number)!;
    assertEquals(importedRef.metadata, store.getMetadata(ref.id));
    assertEquals(target.listSearches().items[0].query, "health");
    const markdown = await exportResearch(target, `${directory}/exports`, "markdown", imported.id);
    const text = await Deno.readTextFile(markdown);
    assertStringIncludes(text, "HR 10000");
    assertStringIncludes(text, "My notes");
    assertStringIncludes(text, "actions: partial");
    assertStringIncludes(text, "subjects: unavailable");
    assertStringIncludes(text, "2026-09-28T00:00:00Z");
    const bad = `${directory}/bad.json`;
    await Deno.writeTextFile(bad, JSON.stringify({ ...payload, version: 99 }));
    await assertRejects(() => stageImport(target, bad), Error, "Unsupported");
    assertEquals(target.listNotebooks().items.length, 1);
    await Deno.writeTextFile(bad, '{"format":"billie-research","version":1,"records":[');
    await assertRejects(() => stageImport(target, bad));
    const signal = AbortSignal.abort();
    await assertRejects(() =>
      exportResearch(store, `${directory}/exports`, "json", undefined, signal)
    );
    assertEquals((await Deno.stat(file)).mode! & 0o777, 0o600);
    const duplicateStage = await stageImport(target, file);
    await resumeImport(target, duplicateStage);
    assertEquals(target.listNotebooks().items.length, 2);
    const database = new DatabaseSync(target.filePath);
    try {
      assertEquals(
        database.prepare("SELECT count(*) AS total FROM legislation_references").get()!.total,
        10000,
      );
    } finally {
      database.close();
    }
  } finally {
    store.close();
    target.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("malformed archives leave live data unchanged", async () => {
  const directory = await Deno.makeTempDir();
  const store = await ResearchStore.open(`${directory}/research/db`);
  try {
    store.createNotebook("Keep");
    const before = await Deno.readFile(store.filePath);
    const file = `${directory}/bad.json`;
    const archives = [
      '{"format":"billie-research","version":1}',
      '{"format":"billie-research","version":1,"records":{}}',
      '{"format":"billie-research","version":1,"records":[],"extra":"secret"}',
      '{"format":"billie-research","version":99,"version":1,"records":[]}',
      '{"format":"billie-research","version":1,"records":[{"table":"notebooks","row":{"id":"../../outside","title":"Bad","description":"","created_at":"2026-09-29","updated_at":"2026-09-29","revision":1}}]}',
      '{"format":"billie-research","version":1,"records":[{"table":"note_citations","row":{"note_id":"missing","notebook_id":"missing","reference_id":"missing"}}]}',
      '{"format":"billie-research","version":1,"records":[{"table":"credentials","row":{}}]}',
      '{"format":"billie-research","version":1,"records":[{"__proto__":{"table":"notes"},"row":{}}]}',
    ];
    for (const archive of archives) {
      await Deno.writeTextFile(file, archive);
      await assertRejects(() => stageImport(store, file));
      assertEquals(await Deno.readFile(store.filePath), before);
    }
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});
