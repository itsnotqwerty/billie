import { assertEquals, assertStringIncludes } from "@std/assert";
import { ResearchStore } from "../research/store.ts";
import { NoteDrafts } from "../research/editor.ts";
import { NotesView } from "./notes.ts";
import { serializeExport } from "../export.ts";

async function fixture(
  test: (store: ResearchStore, drafts: NoteDrafts, notebookId: string) => Promise<void>,
) {
  const directory = await Deno.makeTempDir();
  const store = await ResearchStore.open(`${directory}/research.sqlite3`);
  try {
    await test(store, new NoteDrafts(`${directory}/drafts`), store.createNotebook("Research").id);
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
}
async function press(view: NotesView, text: string): Promise<void> {
  for (const value of text) await view.handle({ kind: "char", value });
}

Deno.test("citation multiselect spans pages without a cap and retains failed batches for retry", async () => {
  await fixture(async (store, drafts, notebookId) => {
    for (let offset = 0; offset < 300; offset += 150) {
      store.addReferences(
        notebookId,
        Array.from({ length: 150 }, (_, index) => ({
          congress: 119,
          type: "hr",
          number: offset + index + 1,
        })),
      );
    }
    const note = store.createNote(notebookId, { title: "Many sources", body: "Keep" });
    const view = new NotesView(store, drafts, notebookId);
    await press(view, "ca");
    for (let page = 0; page < 6; page++) {
      for (let index = 0; index < 50; index++) await press(view, " j");
      if (page < 5) await press(view, "l");
    }
    assertStringIncludes(view.lines(20).join("\n"), "300 selected");
    await press(view, " ");
    assertStringIncludes(view.lines(20).join("\n"), "299 selected");
    await press(view, " ");
    assertEquals(store.countCitations(note.id), 0);
    await press(view, "/no matching identity");
    await view.handle({ kind: "enter" });
    assertStringIncludes(view.lines(20).join("\n"), "No matching notebook references");
    assertStringIncludes(view.lines(20).join("\n"), "300 selected");
    const change = store.changeCitations.bind(store);
    const batches: number[] = [];
    store.changeCitations = (id, revision, changes) => {
      batches.push(changes.add!.length);
      if (batches.length === 2) throw new Error("Disk full");
      return change(id, revision, changes);
    };
    await view.handle({ kind: "enter" });
    assertEquals(store.countCitations(note.id), 250);
    assertStringIncludes(view.lines(20).join("\n"), "50 selected references remaining");
    await view.handle({ kind: "enter" });
    assertEquals(batches, [250, 50, 50]);
    assertEquals(store.countCitations(note.id), 300);
    assertEquals(store.getNote(note.id)!.body, "Keep");
    assertEquals(store.countReferences(notebookId), 300);
    assertStringIncludes(view.lines(20).join("\n"), "0 selected");
  });
});

Deno.test("AI note draft can be edited or saved directly to Markdown and recovered before save", async () => {
  await fixture(async (store, drafts, notebookId) => {
    const ai = {
      destination: "http://localhost/v1",
      model: "test",
      exportDir: `${drafts.root}/exports`,
    };
    const view = new NotesView(store, drafts, notebookId, [], ai);
    await press(view, "aPolicy questions");
    assertStringIncludes(view.lines(30).join("\n"), "Sends only this prompt");
    assertEquals(await view.handle({ kind: "enter" }), {
      kind: "generate",
      prompt: "Policy questions",
    });
    await view.generated("# Questions\n", "test", new AbortController().signal);
    assertEquals(store.countNotes(notebookId), 0);
    assertStringIncludes(view.lines(30).join("\n"), "e Edit in micro / w Save note + Markdown");
    const draft = (await drafts.latest(notebookId))!;
    assertEquals(draft.exportOnSave, true);
    const recovered = new NotesView(store, drafts, notebookId, [], ai);
    await press(recovered, "R");
    assertEquals((await recovered.handle({ kind: "char", value: "e" }))?.kind, "edit");
    await Deno.writeTextFile(draft.filePath, "# Edited questions\n");
    await recovered.editorReturned();
    await press(recovered, "w");
    assertEquals(
      store.getNote(store.listNotes(notebookId).items[0].id)!.body,
      "# Edited questions\n",
    );
    const files = [];
    for await (const entry of Deno.readDir(ai.exportDir)) files.push(entry.name);
    assertEquals(files.length, 1);
    assertEquals(await Deno.readTextFile(`${ai.exportDir}/${files[0]}`), "# Edited questions\n");
    assertEquals((await Deno.stat(`${ai.exportDir}/${files[0]}`)).mode! & 0o777, 0o600);
    assertEquals(await drafts.latest(notebookId), null);
  });
});

Deno.test("AI note file-write failure retains the recoverable draft and discard never exports", async () => {
  await fixture(async (store, drafts, notebookId) => {
    const ai = {
      destination: "http://localhost/v1",
      model: "test",
      exportDir: `${drafts.root}/blocked`,
    };
    const view = new NotesView(store, drafts, notebookId, [], ai);
    await press(view, "aQuestions");
    await view.handle({ kind: "enter" });
    await view.generated("# Keep this draft\n", "test", new AbortController().signal);
    await Deno.writeTextFile(ai.exportDir, "Not a directory");
    await press(view, "w");
    assertEquals(store.countNotes(notebookId), 0);
    assertStringIncludes(
      await drafts.read((await drafts.latest(notebookId))!),
      "# Keep this draft",
    );
    await Deno.remove(ai.exportDir);
    await press(view, "w");
    assertEquals(store.countNotes(notebookId), 1);
    await press(view, "aDiscard this");
    await view.handle({ kind: "enter" });
    await view.generated("# Discard\n", "test", new AbortController().signal);
    await press(view, "dy");
    assertEquals(await drafts.latest(notebookId), null);
    assertEquals(store.countNotes(notebookId), 1);
    const files = [];
    for await (const entry of Deno.readDir(ai.exportDir)) files.push(entry.name);
    assertEquals(files.length, 1);
  });
});

Deno.test("note export includes every citation without modifying notes or saving drafts", async () => {
  await fixture(async (store, drafts, notebookId) => {
    store.addReferences(
      notebookId,
      Array.from({ length: 55 }, (_, index) => ({
        congress: 119,
        type: "hr",
        number: index + 1,
      })),
    );
    const refs = store.listReferences(notebookId, { limit: 100 }).items;
    const note = store.createNote(notebookId, {
      title: "Export note",
      body: "# Body\n\n**Keep** this.",
    }, refs.map((ref) => ref.id));
    const view = new NotesView(store, drafts, notebookId);
    const action = await view.handle({ kind: "char", value: "w" });
    if (action?.kind !== "export") throw new Error("Expected export action");
    const data = action.bundle.data as {
      note: { body: string };
      citations: unknown[];
      unsavedDraft: boolean;
    };
    assertEquals(data.note.body, note.body);
    assertEquals(data.citations.length, 55);
    assertEquals(data.unsavedDraft, false);
    assertStringIncludes(action.bundle.markdown, "Structured citations");
    assertEquals(
      JSON.parse(await serializeExport(action.bundle, "json", "formatted") as string).citations
        .length,
      55,
    );
    assertStringIncludes(
      await serializeExport(action.bundle, "xml", "formatted") as string,
      "<kind>note</kind>",
    );
    assertStringIncludes(
      await serializeExport(action.bundle, "csv", "plain") as string,
      "note.body",
    );
    assertStringIncludes(
      await serializeExport(action.bundle, "html", "formatted") as string,
      "<h2>Structured citations</h2>",
    );
    assertStringIncludes(
      await serializeExport(action.bundle, "markdown", "plain") as string,
      "Keep this.",
    );
    assertEquals(store.getNote(note.id), note);
    await view.handle({ kind: "enter" });
    assertEquals((await view.handle({ kind: "char", value: "w" }))?.kind, "export");
    await press(view, "e");
    const draft = (await drafts.latest(notebookId))!;
    await Deno.writeTextFile(draft.filePath, "Draft changes");
    await view.editorReturned();
    const exportedDraft = await view.handle({ kind: "char", value: "W" });
    if (exportedDraft?.kind !== "export") throw new Error("Expected draft export");
    assertStringIncludes(exportedDraft.bundle.markdown, "Unsaved research note draft");
    assertStringIncludes(exportedDraft.bundle.markdown, "Draft changes");
    assertEquals(store.getNote(note.id), note);
    assertEquals((await drafts.latest(notebookId))!.filePath, draft.filePath);
    await press(view, "dy");
    store.deleteNote(note.id, note.revision);
    assertEquals(await view.handle({ kind: "char", value: "w" }), undefined);
    assertStringIncludes(view.lines(30).join("\n"), "Note was deleted");
  });
});

Deno.test("notes search titles and bodies with bounded pages and no body reads", async () => {
  await fixture(async (store, drafts, notebookId) => {
    for (let index = 0; index < 55; index++) {
      store.createNote(notebookId, {
        title: `Note ${index}`,
        body: index === 54 ? "Body only match: resilience funding" : "Ordinary body",
      });
    }
    let reads = 0;
    const get = store.getNote.bind(store);
    store.getNote = (id) => {
      reads++;
      return get(id);
    };
    const view = new NotesView(store, drafts, notebookId);
    assertEquals(reads, 0);
    await press(view, "/resilience");
    await view.handle({ kind: "enter" });
    assertStringIncludes(view.lines(30).join("\n"), "Search: resilience");
    assertStringIncludes(view.lines(30).join("\n"), "Note 54");
    assertEquals(view.lines(30).join("\n").includes("Note 0"), false);
    assertEquals(reads, 0);
    await view.handle({ kind: "enter" });
    assertStringIncludes(view.lines(30).join("\n"), "resilience funding");
    assertEquals(reads, 1);
    await view.handle({ kind: "escape" });
    await press(view, "/climate");
    await view.handle({ kind: "enter" });
    assertStringIncludes(view.lines(30).join("\n"), "No notes.");
    await press(view, "/");
    for (let index = 0; index < "resilienceclimate".length; index++) {
      await view.handle({ kind: "backspace" });
    }
    await view.handle({ kind: "enter" });
    assertStringIncludes(view.lines(30).join("\n"), "Search cleared.");
    assertStringIncludes(view.lines(30).join("\n"), "Page 1 (more available)");
    assertEquals(store.countNotes(notebookId), 55);
  });
});

Deno.test("note UI creates a micro draft and saves only after explicit confirmation", async () => {
  await fixture(async (store, drafts, notebookId) => {
    const view = new NotesView(store, drafts, notebookId);
    await press(view, "nFirst note");
    const action = await view.handle({ kind: "enter" });
    assertEquals(action?.kind, "edit");
    if (action?.kind !== "edit") throw new Error("Missing editor action");
    await Deno.writeTextFile(action.filePath, "# Findings\n\nMultiline note\n");
    await view.editorReturned();
    assertEquals(store.countNotes(notebookId), 0);
    assertStringIncludes(view.lines(30).join("\n"), "w Save / d Discard / c Continue");
    await press(view, "w");
    const note = store.getNote(store.listNotes(notebookId).items[0].id)!;
    assertEquals(note.body, "# Findings\n\nMultiline note\n");
    assertEquals(await drafts.latest(notebookId), null);
  });
});

Deno.test("failed editor and save retain recoverable drafts; conflicts never overwrite newer notes", async () => {
  await fixture(async (store, drafts, notebookId) => {
    const note = store.createNote(notebookId, { title: "Original", body: "Original body" });
    const view = new NotesView(store, drafts, notebookId);
    const action = await view.handle({ kind: "char", value: "e" });
    if (action?.kind !== "edit") throw new Error("Missing editor action");
    await Deno.writeTextFile(action.filePath, "Recovered body");
    await view.editorReturned(new Error("micro failed"));
    assertStringIncludes(view.lines(30).join("\n"), "micro failed");
    store.updateNote(note.id, note.revision, { title: "Concurrent", body: "Newer work" });
    await press(view, "w");
    assertStringIncludes(view.lines(30).join("\n"), "Reload before saving");
    assertEquals(store.getNote(note.id)!.body, "Newer work");
    const reopened = new NotesView(store, drafts, notebookId);
    await press(reopened, "R");
    assertStringIncludes(reopened.lines(30).join("\n"), "Recovered body");
    const continuation = await reopened.handle({ kind: "char", value: "c" });
    assertEquals(continuation, action);
    await reopened.editorReturned();
    await press(reopened, "k");
    assertEquals(store.countNotes(notebookId), 2);
    assertEquals(await drafts.latest(notebookId), null);
  });
});

Deno.test("note UI discard requires confirmation and body editing preserves citations", async () => {
  await fixture(async (store, drafts, notebookId) => {
    store.addReferences(notebookId, [{ congress: 119, type: "hr", number: 1 }]);
    const note = store.createNote(notebookId, { title: "Cited", body: "Original" }, [
      store.listReferences(notebookId).items[0].id,
    ]);
    const view = new NotesView(store, drafts, notebookId);
    await press(view, "e");
    const draft = (await drafts.latest(notebookId))!;
    await Deno.writeTextFile(draft.filePath, "Changed");
    await view.editorReturned();
    await view.handle({ kind: "escape" });
    assertStringIncludes(view.lines(30).join("\n"), "Discard this draft");
    await press(view, "n");
    assertEquals(store.getNote(note.id)!.body, "Original");
    await press(view, "w");
    assertEquals(store.getNote(note.id)!.body, "Changed");
    assertEquals(store.countCitations(note.id), 1);
    await press(view, "e");
    await view.editorReturned();
    await press(view, "dy");
    assertEquals(await drafts.latest(notebookId), null);
    assertEquals(store.getNote(note.id)!.body, "Changed");
    await press(view, "xy");
    assertEquals(store.countNotes(notebookId), 0);
    assertEquals(store.countReferences(notebookId), 1);
  });
});

Deno.test("note UI keeps the draft after storage failure and retries without losing Markdown", async () => {
  await fixture(async (store, drafts, notebookId) => {
    const view = new NotesView(store, drafts, notebookId);
    await press(view, "nRetry");
    const action = await view.handle({ kind: "enter" });
    if (action?.kind !== "edit") throw new Error("Missing editor action");
    await Deno.writeTextFile(action.filePath, "# Keep this\n");
    await view.editorReturned();
    const create = store.createNote.bind(store);
    store.createNote = () => {
      throw new Error("Disk full");
    };
    await press(view, "w");
    assertStringIncludes(view.lines(30).join("\n"), "Disk full");
    assertEquals(await Deno.readTextFile(action.filePath), "# Keep this\n");
    assertEquals(store.countNotes(notebookId), 0);
    store.createNote = create;
    await press(view, "w");
    assertEquals(store.countNotes(notebookId), 1);
    assertEquals(await drafts.latest(notebookId), null);
  });
});

Deno.test("notes list pages without loading bodies and returns to the selected page", async () => {
  await fixture(async (store, drafts, notebookId) => {
    for (let index = 0; index < 55; index++) {
      store.createNote(notebookId, { title: `Note ${index}`, body: "# Body\n" });
    }
    let reads = 0;
    const get = store.getNote.bind(store);
    store.getNote = (id) => {
      reads++;
      return get(id);
    };
    const view = new NotesView(store, drafts, notebookId);
    assertEquals(reads, 0);
    await press(view, "lj");
    assertStringIncludes(view.lines(30).join("\n"), "Page 2");
    const selected = view.lines(30).filter((line) => line.startsWith("  >"));
    await view.handle({ kind: "enter" });
    assertEquals(reads, 1);
    assertStringIncludes(view.lines(30).join("\n"), "# Body");
    await view.handle({ kind: "escape" });
    assertEquals(view.lines(30).filter((line) => line.startsWith("  >")), selected);
    await press(view, "b");
    assertStringIncludes(view.lines(30).join("\n"), "Page 1");
  });
});

Deno.test("e starts a note from an empty list and reopens the same unsaved draft", async () => {
  await fixture(async (store, drafts, notebookId) => {
    const view = new NotesView(store, drafts, notebookId);
    assertStringIncludes(view.lines(30).join("\n"), "n/e new note in micro");
    await press(view, "e");
    assertStringIncludes(view.lines(30).join("\n"), "Note title");
    await press(view, "First note");
    const action = await view.handle({ kind: "enter" });
    if (action?.kind !== "edit") throw new Error("Missing editor action");
    await Deno.writeTextFile(action.filePath, "# Unsaved work\n");
    await view.editorReturned();
    const originalDraft = await drafts.latest(notebookId);
    assertEquals(await view.handle({ kind: "char", value: "e" }), action);
    assertEquals(await drafts.latest(notebookId), originalDraft);
    assertEquals(await Deno.readTextFile(action.filePath), "# Unsaved work\n");
    assertEquals(store.countNotes(notebookId), 0);
    await view.editorReturned(new Error("Editor failed"));
    assertEquals(await view.handle({ kind: "char", value: "e" }), action);
    await view.editorReturned();
    await press(view, "w");
    assertEquals(store.countNotes(notebookId), 1);
    await view.handle({ kind: "enter" });
    assertEquals((await view.handle({ kind: "char", value: "e" }))?.kind, "edit");
  });
});

Deno.test("note citations add more than two references and confirm removal without changing text or membership", async () => {
  await fixture(async (store, drafts, notebookId) => {
    store.addReferences(
      notebookId,
      Array.from(
        { length: 4 },
        (_, index) => ({ congress: 118 + index % 2, type: "hr", number: index + 1 }),
      ),
    );
    const note = store.createNote(notebookId, { title: "Findings", body: "# Keep Markdown\n" });
    const view = new NotesView(store, drafts, notebookId);
    await press(view, "ca");
    for (let index = 0; index < 4; index++) {
      await view.handle({ kind: "enter" });
      await press(view, "j");
    }
    assertEquals(store.countCitations(note.id), 4);
    await view.handle({ kind: "enter" });
    assertStringIncludes(view.lines(30).join("\n"), "already cited");
    await view.handle({ kind: "escape" });
    await press(view, "xn");
    assertEquals(store.countCitations(note.id), 4);
    await press(view, "xy");
    assertEquals(store.countCitations(note.id), 3);
    assertEquals(store.countReferences(notebookId), 4);
    assertEquals(store.getNote(note.id)!.body, note.body);
    await view.handle({ kind: "escape" });
    await view.handle({ kind: "enter" });
    assertStringIncludes(view.lines(30).join("\n"), "3 citations");
    await press(view, "c");
    assertStringIncludes(view.lines(30).join("\n"), "Citations: Findings");
    await view.handle({ kind: "escape" });
    assertStringIncludes(view.lines(30).join("\n"), "# Keep Markdown");
  });
});

Deno.test("citation picker pages through 300 references without a citation cap or whole-notebook reads", async () => {
  await fixture(async (store, drafts, notebookId) => {
    for (let offset = 0; offset < 300; offset += 150) {
      store.addReferences(
        notebookId,
        Array.from({ length: 150 }, (_, index) => ({
          congress: 118 + index % 2,
          type: index % 3 ? "hr" : "s",
          number: offset + index + 1,
        })),
      );
    }
    const note = store.createNote(notebookId, { title: "Scale", body: "Unchanged" });
    const list = store.listReferences.bind(store);
    const pages: number[] = [];
    store.listReferences = (id, options) => {
      const result = list(id, options);
      pages.push(result.items.length);
      return result;
    };
    const view = new NotesView(store, drafts, notebookId);
    await press(view, "ca");
    for (let page = 0; page < 6; page++) {
      for (let index = 0; index < 50; index++) {
        await view.handle({ kind: "enter" });
        await press(view, "j");
      }
      if (page < 5) await press(view, "l");
    }
    assertEquals(pages, [50, 50, 50, 50, 50, 50]);
    assertEquals(store.countCitations(note.id), 300);
    assertStringIncludes(view.lines(20).join("\n"), "Page 6");
    await view.handle({ kind: "escape" });
    assertStringIncludes(view.lines(20).join("\n"), "300 cited");
    await press(view, "l");
    assertStringIncludes(view.lines(20).join("\n"), "Page 2");
    await press(view, "b/119 hr300");
    await view.handle({ kind: "enter" });
    assertStringIncludes(view.lines(20).join("\n"), "HR 300");
    await press(view, "xy");
    assertEquals(store.countCitations(note.id), 299);
    assertStringIncludes(view.lines(20).join("\n"), "No matching citations");
    await press(view, "a");
    assertStringIncludes(view.lines(20).join("\n"), "Page 6");
    await press(view, "/119 hr300");
    await view.handle({ kind: "enter" });
    await view.handle({ kind: "enter" });
    assertEquals(store.countCitations(note.id), 300);
    assertEquals(store.getNote(note.id)!.body, "Unchanged");
  });
});

Deno.test("citation UI refuses stale writes and reloads before retrying without altering concurrent Markdown", async () => {
  await fixture(async (store, drafts, notebookId) => {
    store.addReferences(notebookId, [{ congress: 119, type: "hr", number: 1 }]);
    const note = store.createNote(notebookId, { title: "Initial", body: "Old text" });
    const view = new NotesView(store, drafts, notebookId);
    await view.handle({ kind: "enter" });
    await press(view, "ca");
    store.updateNote(note.id, note.revision, { title: "Concurrent", body: "New text" });
    await view.handle({ kind: "enter" });
    assertStringIncludes(view.lines(30).join("\n"), "Reload before saving");
    assertEquals(store.countCitations(note.id), 0);
    await press(view, "r");
    await view.handle({ kind: "enter" });
    assertEquals(store.countCitations(note.id), 1);
    await view.handle({ kind: "escape" });
    await press(view, "x");
    const latest = store.getNote(note.id)!;
    store.updateNote(note.id, latest.revision, { title: latest.title, body: "Even newer" });
    await press(view, "y");
    assertEquals(store.countCitations(note.id), 1);
    assertStringIncludes(view.lines(30).join("\n"), "Reload before saving");
    await press(view, "nrxy");
    assertEquals(store.countCitations(note.id), 0);
    await view.handle({ kind: "escape" });
    assertStringIncludes(view.lines(30).join("\n"), "Even newer");
    assertStringIncludes(view.lines(30).join("\n"), "0 citations");
  });
});

Deno.test("citation picker handles write failures and removed membership without creating dangling citations", async () => {
  await fixture(async (store, drafts, notebookId) => {
    store.addReferences(notebookId, [{ congress: 119, type: "hr", number: 1 }]);
    const reference = store.listReferences(notebookId).items[0];
    const note = store.createNote(notebookId, { title: "Failure", body: "Keep" });
    const view = new NotesView(store, drafts, notebookId);
    await press(view, "ca");
    const change = store.changeCitations.bind(store);
    store.changeCitations = () => {
      throw new Error("Disk full");
    };
    await view.handle({ kind: "enter" });
    assertStringIncludes(view.lines(30).join("\n"), "Disk full");
    assertEquals(store.countCitations(note.id), 0);
    store.changeCitations = change;
    store.removeReference(notebookId, reference.id, store.getNotebook(notebookId)!.revision);
    await view.handle({ kind: "enter" });
    assertStringIncludes(view.lines(30).join("\n"), "same notebook");
    assertEquals(store.countCitations(note.id), 0);
    await press(view, "r");
    assertStringIncludes(view.lines(30).join("\n"), "No matching notebook references");
    store.deleteNote(note.id, note.revision);
    await press(view, "r");
    assertStringIncludes(view.lines(30).join("\n"), "Note was deleted");
    await view.handle({ kind: "escape" });
    await view.handle({ kind: "escape" });
    assertStringIncludes(view.lines(30).join("\n"), "No notes");
  });
});

Deno.test("citation filters cancel without losing the page and picker excludes other notebooks", async () => {
  await fixture(async (store, drafts, notebookId) => {
    const other = store.createNotebook("Other");
    store.addReferences(other.id, [{ congress: 119, type: "s", number: 99 }]);
    store.addReferences(notebookId, [{ congress: 119, type: "hr", number: 1 }]);
    const note = store.createNote(notebookId, { title: "Local", body: "" });
    const view = new NotesView(store, drafts, notebookId);
    await press(view, "ca/s99");
    await view.handle({ kind: "enter" });
    assertStringIncludes(view.lines(30).join("\n"), "No matching notebook references");
    await view.handle({ kind: "enter" });
    assertEquals(store.countCitations(note.id), 0);
    await press(view, "/");
    for (let index = 0; index < 3; index++) await view.handle({ kind: "backspace" });
    await view.handle({ kind: "escape" });
    assertStringIncludes(view.lines(30).join("\n"), "Filter: s99");
    await press(view, "/");
    for (let index = 0; index < 3; index++) await view.handle({ kind: "backspace" });
    await view.handle({ kind: "enter" });
    await view.handle({ kind: "enter" });
    assertEquals(store.countCitations(note.id), 1);
    await view.handle({ kind: "escape" });
    await view.handle({ kind: "escape" });
    await press(view, "e");
    await view.editorReturned();
    assertEquals((await view.handle({ kind: "char", value: "c" }))?.kind, "edit");
  });
});
