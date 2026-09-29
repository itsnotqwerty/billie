import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import {
  ResearchConflictError,
  researchPath,
  ResearchStore,
  type SearchDefinition,
} from "./store.ts";

const definition: SearchDefinition = {
  name: "Climate",
  query: "climate act",
  type: "hr",
  congress: { mode: "fixed", congress: 119 },
};

async function withStore(test: (store: ResearchStore, filePath: string) => Promise<void> | void) {
  const directory = await Deno.makeTempDir();
  const filePath = `${directory}/research/research.sqlite3`;
  const store = await ResearchStore.open(filePath);
  try {
    await test(store, filePath);
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("search citations add membership atomically, reject stale notes, and remain idempotent", async () => {
  await withStore((store, filePath) => {
    const notebook = store.createNotebook("Sources");
    const note = store.createNote(notebook.id, { title: "Research", body: "Unchanged" });
    const ref = { congress: 119, type: "hr", number: 1 };
    const updated = store.citeReference(note.id, note.revision, ref);
    assertEquals(updated.revision, 2);
    assertEquals(store.countReferences(notebook.id), 1);
    assertEquals(store.countCitations(note.id), 1);
    assertEquals(store.citeReference(note.id, updated.revision, ref), updated);
    assertThrows(
      () => store.citeReference(note.id, note.revision, { ...ref, number: 2 }),
      ResearchConflictError,
    );
    assertEquals(store.countReferences(notebook.id), 1);
    const database = new DatabaseSync(filePath);
    try {
      database.exec(`CREATE TRIGGER reject_citation BEFORE INSERT ON note_citations
        BEGIN SELECT RAISE(ABORT, 'Citation write failed'); END`);
      assertThrows(
        () => store.citeReference(note.id, updated.revision, { ...ref, number: 3 }),
        Error,
        "Citation write failed",
      );
      assertEquals(store.countReferences(notebook.id), 1);
      assertEquals(
        database.prepare("SELECT count(*) AS total FROM legislation_references").get()!.total,
        1,
      );
      assertEquals(store.getNote(note.id)!.revision, updated.revision);
      assertEquals(store.getNote(note.id)!.body, "Unchanged");
    } finally {
      database.close();
    }
  });
});

Deno.test("offline metadata preserves retrieval time and previous snapshot on refresh failure", async () => {
  await withStore(async (store, filePath) => {
    const notebook = store.createNotebook("Offline");
    const ref = { congress: 119, type: "hr", number: 1 };
    store.addReferences(notebook.id, [ref]);
    const referenceId = store.listReferences(notebook.id).items[0].id;
    const detail = {
      ...ref,
      title: "Public title",
      url: "https://api.congress.gov/v3/bill/119/hr/1",
      updateDate: "2026-09-01",
      sponsors: [],
      subjects: [],
      actions: [],
      completeness: { actions: "partial" as const, subjects: "complete" as const },
    };
    store.saveMetadata(referenceId, detail, "2026-09-28T00:00:00Z");
    store.failMetadata(referenceId, "2026-09-29T00:00:00Z");
    const reopened = await ResearchStore.open(filePath);
    try {
      const metadata = reopened.listReferences(notebook.id).items[0].metadata!;
      assertEquals(metadata.title, "Public title");
      assertEquals(metadata.retrievedAt, "2026-09-28T00:00:00Z");
      assertEquals(metadata.refreshError !== null, true);
      assertEquals(metadata.limitations.length, 1);
      assertThrows(() =>
        store.saveMetadata(
          referenceId,
          { ...detail, url: detail.url + "?api_key=secret" },
          metadata.retrievedAt!,
        )
      );
    } finally {
      reopened.close();
    }
  });
});

Deno.test("v3 migration takes a restorable private snapshot and concurrent writers fail safely", async () => {
  const directory = await Deno.makeTempDir();
  const filePath = `${directory}/db`;
  const initial = await ResearchStore.open(filePath);
  const notebook = initial.createNotebook("Keep");
  initial.close();
  const legacy = new DatabaseSync(filePath);
  legacy.exec(
    "DROP TABLE import_mappings; DROP TABLE import_runs; DROP TABLE reference_metadata; PRAGMA user_version = 3",
  );
  legacy.close();
  const store = await ResearchStore.open(filePath);
  const lock = new DatabaseSync(filePath);
  try {
    assertEquals(store.getNotebook(notebook.id), notebook);
    const backups = [];
    for await (const entry of Deno.readDir(directory)) {
      if (entry.name.endsWith(".bak")) backups.push(entry.name);
    }
    assertEquals(backups.length, 1);
    const backupPath = `${directory}/${backups[0]}`;
    assertEquals((await Deno.stat(backupPath)).mode! & 0o777, 0o600);
    const restored = await ResearchStore.open(backupPath);
    assertEquals(restored.getNotebook(notebook.id), notebook);
    restored.close();
    lock.exec("BEGIN IMMEDIATE");
    assertThrows(
      () => store.updateNotebook(notebook.id, notebook.revision, "Blocked", ""),
      Error,
      "locked",
    );
    assertEquals(store.getNotebook(notebook.id), notebook);
    lock.exec("ROLLBACK");
    lock.exec(
      "CREATE TRIGGER disk_failure BEFORE UPDATE ON notebooks BEGIN SELECT RAISE(ABORT, 'disk full fixture'); END",
    );
    assertThrows(
      () => store.addReferences(notebook.id, [{ congress: 119, type: "hr", number: 1 }]),
      Error,
      "disk full fixture",
    );
    assertEquals(store.countReferences(notebook.id), 0);
    assertEquals(store.getNotebook(notebook.id), notebook);
  } finally {
    lock.close();
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test({
  name: "research store reports denied filesystem permissions",
  permissions: { read: false, write: false },
  fn: async () => {
    await assertRejects(() => ResearchStore.open("/tmp/billie-denied/db"), Deno.errors.NotCapable);
  },
});

Deno.test("researchPath uses absolute XDG paths and falls back to HOME", () => {
  const env = (values: Record<string, string>) => ({ get: (name: string) => values[name] });
  assertEquals(researchPath(env({ XDG_DATA_HOME: "/data" })), "/data/billie/research.sqlite3");
  assertEquals(
    researchPath(env({ XDG_DATA_HOME: "relative", HOME: "/home/test" })),
    "/home/test/.local/share/billie/research.sqlite3",
  );
  assertThrows(() => researchPath(env({ HOME: "relative" })), Error, "absolute");
});

Deno.test("explicit additions retain actual API retrieval timestamps without refreshing on save", async () => {
  await withStore((store) => {
    const notebook = store.createNotebook("Provenance");
    const summary = {
      congress: 119,
      type: "hr",
      number: 1,
      title: "Fetched",
      url: "https://api.congress.gov/v3/bill/119/hr/1?format=json",
      updateDate: "2026-09-01",
      retrievedAt: "2026-09-28T00:00:00Z",
    };
    store.addReferences(notebook.id, [summary]);
    const snapshot = store.listReferences(notebook.id).items[0].metadata!;
    assertEquals(snapshot.retrievedAt, summary.retrievedAt);
    assertEquals(snapshot.sourceUrl.includes("?"), false);
    const note = store.createNote(notebook.id, { title: "Cited", body: "User-authored" });
    store.citeReference(
      note.id,
      note.revision,
      { ...summary, title: "Later title", retrievedAt: "2026-09-29T00:00:00Z" } as typeof summary,
    );
    assertEquals(store.listCitations(note.id).items[0].metadata, snapshot);
  });
});

Deno.test("research store persists definitions and uses private files", async () => {
  await withStore(async (store, filePath) => {
    const fixed = store.createSearch(definition);
    const dynamic = store.createSearch({ ...definition, congress: { mode: "current" } });
    assertEquals(fixed.revision, 1);
    assertEquals(dynamic.congress, { mode: "current" });
    const reopened = await ResearchStore.open(filePath);
    try {
      assertEquals(reopened.getSearch(fixed.id), fixed);
      assertEquals(reopened.listSearches().items.length, 2);
    } finally {
      reopened.close();
    }
    assertEquals((await Deno.stat(filePath)).mode! & 0o777, 0o600);
    assertEquals((await Deno.stat(dirname(filePath))).mode! & 0o777, 0o700);
  });
});

Deno.test("research store revision conflicts do not overwrite or delete newer edits", async () => {
  await withStore(async (store, filePath) => {
    const original = store.createSearch(definition);
    const other = await ResearchStore.open(filePath);
    try {
      const changed = other.updateSearch(original.id, 1, { ...definition, name: "Updated" });
      assertEquals(changed.revision, 2);
      assertThrows(() => store.updateSearch(original.id, 1, definition), ResearchConflictError);
      assertThrows(() => store.deleteSearch(original.id, 1), ResearchConflictError);
      assertEquals(store.getSearch(original.id), changed);
      store.deleteSearch(original.id, 2);
      assertEquals(store.getSearch(original.id), null);
    } finally {
      other.close();
    }
  });
});

Deno.test("research store validates definitions and pages without a collection cap", async () => {
  await withStore((store) => {
    for (
      const invalid of [
        { ...definition, name: " " },
        { ...definition, query: "" },
        { ...definition, type: "invalid" },
        { ...definition, congress: { mode: "fixed" as const, congress: 0 } },
      ]
    ) assertThrows(() => store.createSearch(invalid));
    assertEquals(store.listSearches().items, []);
    for (let index = 0; index < 17; index++) {
      store.createSearch({ ...definition, name: `Climate ${index}` });
    }
    const ids = new Set<string>();
    let after: string | undefined;
    do {
      const page = store.listSearches({ after, limit: 3, name: "CLIMATE" });
      for (const search of page.items) ids.add(search.id);
      after = page.nextCursor;
    } while (after);
    assertEquals(ids.size, 17);
    assertEquals(store.listSearches({ name: "' OR 1=1 --" }).items, []);
    assertThrows(() => store.listSearches({ limit: 0 }));
    const original = store.listSearches({ limit: 1 }).items[0];
    assertThrows(() =>
      store.updateSearch(original.id, original.revision, { ...definition, query: "" })
    );
    assertEquals(store.getSearch(original.id), original);
  });
});

Deno.test("research store refuses newer and unrecognized databases without changing bytes", async () => {
  const directory = await Deno.makeTempDir();
  try {
    for (const version of [-1, 0, 1, 2, 3, 99]) {
      const filePath = `${directory}/version-${version}.sqlite3`;
      const database = new DatabaseSync(filePath);
      database.exec(
        `CREATE TABLE precious (value TEXT); INSERT INTO precious VALUES ('keep'); PRAGMA user_version = ${version}`,
      );
      database.close();
      const before = await Deno.readFile(filePath);
      await assertRejects(() => ResearchStore.open(filePath));
      assertEquals(await Deno.readFile(filePath), before);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("research store preserves corrupt files and refuses symlinks", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const filePath = `${directory}/corrupt.sqlite3`;
    await Deno.writeTextFile(filePath, "not a SQLite database");
    const before = await Deno.readFile(filePath);
    await assertRejects(() => ResearchStore.open(filePath));
    assertEquals(await Deno.readFile(filePath), before);
    const link = `${directory}/linked.sqlite3`;
    await Deno.symlink(filePath, link);
    await assertRejects(() => ResearchStore.open(link), Error, "regular file");
    assertEquals(await Deno.readFile(filePath), before);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("notebooks keep unique canonical memberships across notebooks and congresses", async () => {
  await withStore((store) => {
    const first = store.createNotebook("First", "Research");
    const second = store.createNotebook("Second");
    const ref = { congress: 119, type: "HR", number: 1 };
    assertEquals(
      store.addReferences(first.id, [ref, { ...ref, type: "hr" }, { ...ref, congress: 118 }]),
      { added: 2, existing: 1 },
    );
    assertEquals(store.addReferences(second.id, [ref]), { added: 1, existing: 0 });
    const selected = store.listReferences(first.id, { query: "119 hr1" }).items[0];
    assertEquals(selected.id, store.listReferences(second.id).items[0].id);
    assertThrows(() => store.deleteNotebook(first.id, first.revision), ResearchConflictError);
    const current = store.getNotebook(first.id)!;
    store.removeReference(first.id, selected.id, current.revision);
    assertEquals(store.countReferences(first.id), 1);
    assertEquals(store.countReferences(second.id), 1);
    store.deleteNotebook(first.id, store.getNotebook(first.id)!.revision);
    assertEquals(store.countReferences(first.id), 0);
    assertEquals(store.countReferences(second.id), 1);
    assertThrows(() => store.addReferences(first.id, [ref]), ResearchConflictError);
  });
});

Deno.test("notebook edits reject stale revisions and invalid batches without partial writes", async () => {
  await withStore((store) => {
    const notebook = store.createNotebook("Old");
    const updated = store.updateNotebook(notebook.id, notebook.revision, "New", "Description");
    assertEquals(store.listNotebooks({ query: "new" }).items, [updated]);
    assertThrows(
      () => store.updateNotebook(notebook.id, notebook.revision, "Stale", ""),
      ResearchConflictError,
    );
    assertThrows(() =>
      store.addReferences(notebook.id, [{ congress: 119, type: "hr", number: 1 }, {
        congress: 119,
        type: "bad",
        number: 2,
      }])
    );
    assertEquals(store.countReferences(notebook.id), 0);
    assertEquals(store.getNotebook(notebook.id), updated);
    assertThrows(() => store.createNotebook(" "));
  });
});

Deno.test("notebook scale fixture pages through 10000 references without a membership cap", async () => {
  await withStore((store) => {
    const notebook = store.createNotebook("Large notebook");
    for (let offset = 0; offset < 10_000; offset += 250) {
      store.addReferences(
        notebook.id,
        Array.from({ length: 250 }, (_, index) => ({
          congress: 118 + (index % 2),
          type: index % 3 ? "hr" : "s",
          number: offset + index + 1,
        })),
      );
    }
    assertEquals(store.countReferences(notebook.id), 10_000);
    const seen = new Set<string>();
    let after: string | undefined;
    do {
      const page = store.listReferences(notebook.id, { after, limit: 37 });
      assertEquals(page.items.length <= 37, true);
      for (const item of page.items) seen.add(item.id);
      after = page.nextCursor;
    } while (after);
    assertEquals(seen.size, 10_000);
  });
});

Deno.test("schema v1 migrates transactionally while preserving saved searches", async () => {
  const directory = await Deno.makeTempDir();
  const filePath = `${directory}/research.sqlite3`;
  try {
    const original = await ResearchStore.open(filePath);
    const saved = original.createSearch(definition);
    original.close();
    const database = new DatabaseSync(filePath);
    database.exec(
      "DROP TABLE import_mappings; DROP TABLE import_runs; DROP TABLE reference_metadata; DROP TABLE note_citations; DROP TABLE notes; DROP TABLE notebook_references; DROP TABLE legislation_references; DROP TABLE notebooks; PRAGMA user_version = 1",
    );
    database.close();
    const migrated = await ResearchStore.open(filePath);
    try {
      assertEquals(migrated.getSearch(saved.id), saved);
      const notebook = migrated.createNotebook("Migrated");
      migrated.addReferences(notebook.id, [{ congress: 119, type: "hr", number: 1 }]);
    } finally {
      migrated.close();
    }
    const reopened = await ResearchStore.open(filePath);
    try {
      assertEquals(reopened.countReferences(reopened.listNotebooks().items[0].id), 1);
    } finally {
      reopened.close();
    }
    const backups = [];
    for await (const entry of Deno.readDir(directory)) {
      if (entry.name.endsWith(".bak")) backups.push(entry.name);
    }
    assertEquals(backups.length, 1);
    const snapshotPath = `${directory}/${backups[0]}`;
    assertEquals((await Deno.stat(snapshotPath)).mode! & 0o777, 0o600);
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      assertEquals(snapshot.prepare("PRAGMA user_version").get()!.user_version, 1);
      assertEquals(
        snapshot.prepare("SELECT name FROM saved_searches WHERE id = ?").get(saved.id)!.name,
        saved.name,
      );
    } finally {
      snapshot.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("failed v2 migration rolls back without losing v1 data", async () => {
  const directory = await Deno.makeTempDir();
  const filePath = `${directory}/research.sqlite3`;
  try {
    const original = await ResearchStore.open(filePath);
    const saved = original.createSearch(definition);
    original.close();
    const database = new DatabaseSync(filePath);
    database.exec(
      "DROP TABLE import_mappings; DROP TABLE import_runs; DROP TABLE reference_metadata; DROP TABLE note_citations; DROP TABLE notes; DROP TABLE notebook_references; DROP TABLE legislation_references; PRAGMA user_version = 1",
    );
    database.close();
    await assertRejects(() => ResearchStore.open(filePath));
    const check = new DatabaseSync(filePath);
    try {
      assertEquals(check.prepare("PRAGMA user_version").get()!.user_version, 1);
      assertEquals(
        check.prepare("SELECT name FROM saved_searches WHERE id = ?").get(saved.id)!.name,
        saved.name,
      );
      assertEquals(
        check.prepare("SELECT name FROM sqlite_master WHERE name = 'legislation_references'").get(),
        undefined,
      );
    } finally {
      check.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("migration backup includes committed WAL data", async () => {
  const directory = await Deno.makeTempDir();
  const filePath = `${directory}/research.sqlite3`;
  try {
    const original = await ResearchStore.open(filePath);
    const search = original.createSearch(definition);
    original.close();
    const writer = new DatabaseSync(filePath);
    try {
      writer.exec(
        "PRAGMA journal_mode = WAL; DROP TABLE import_mappings; DROP TABLE import_runs; DROP TABLE reference_metadata; DROP TABLE note_citations; DROP TABLE notes; DROP TABLE notebook_references; DROP TABLE legislation_references; DROP TABLE notebooks; PRAGMA user_version = 1",
      );
      writer.prepare("UPDATE saved_searches SET name = ? WHERE id = ?").run(
        "WAL update",
        search.id,
      );
      const migrated = await ResearchStore.open(filePath);
      migrated.close();
      for await (const entry of Deno.readDir(directory)) {
        if (!entry.name.endsWith(".bak")) continue;
        const snapshot = new DatabaseSync(`${directory}/${entry.name}`, { readOnly: true });
        try {
          assertEquals(
            snapshot.prepare("SELECT name FROM saved_searches WHERE id = ?").get(search.id)!.name,
            "WAL update",
          );
        } finally {
          snapshot.close();
        }
      }
    } finally {
      writer.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("notes preserve Markdown exactly and use optimistic revisions across connections", async () => {
  await withStore(async (store, filePath) => {
    const notebook = store.createNotebook("Notes");
    const body = "# Research\n\n  Indented text\n\n- Finding\n";
    const note = store.createNote(notebook.id, { title: " First ", body });
    assertEquals(note.title, "First");
    assertEquals(note.body, body);
    assertEquals(store.countCitations(note.id), 0);
    assertThrows(() => store.deleteNotebook(notebook.id, notebook.revision), ResearchConflictError);
    const other = await ResearchStore.open(filePath);
    try {
      assertEquals(other.getNote(note.id), note);
      const changed = other.updateNote(note.id, note.revision, {
        title: "Updated",
        body: `${body}More\n`,
      });
      assertThrows(
        () => store.updateNote(note.id, note.revision, { title: "Stale", body: "Lost" }),
        ResearchConflictError,
      );
      assertThrows(() => store.deleteNote(note.id, note.revision), ResearchConflictError);
      assertEquals(store.getNote(note.id), changed);
      store.deleteNote(note.id, changed.revision);
      assertEquals(store.getNote(note.id), null);
      assertEquals(store.countNotes(notebook.id), 0);
    } finally {
      other.close();
    }
  });
});

Deno.test("citations enforce notebook ownership and roll back invalid batches", async () => {
  await withStore((store, filePath) => {
    const notebook = store.createNotebook("Local");
    const other = store.createNotebook("Other");
    store.addReferences(notebook.id, [{ congress: 119, type: "hr", number: 1 }, {
      congress: 119,
      type: "hr",
      number: 2,
    }]);
    store.addReferences(other.id, [{ congress: 119, type: "s", number: 1 }]);
    const [first, second] = store.listReferences(notebook.id).items;
    const foreign = store.listReferences(other.id).items[0];
    const before = store.getNotebook(notebook.id);
    assertThrows(
      () => store.createNote(notebook.id, { title: "Invalid", body: "" }, [first.id, foreign.id]),
      Error,
      "same notebook",
    );
    assertEquals(store.countNotes(notebook.id), 0);
    assertEquals(store.getNotebook(notebook.id), before);
    const note = store.createNote(notebook.id, { title: "Valid", body: "**Keep**" }, [
      first.id,
      first.id,
    ]);
    assertEquals(store.countCitations(note.id), 1);
    const revision = store.getNotebook(notebook.id)!.revision;
    assertThrows(
      () =>
        store.changeCitations(note.id, note.revision, {
          add: [second.id, foreign.id],
          remove: [first.id],
        }),
      Error,
      "same notebook",
    );
    assertEquals(store.listCitations(note.id).items.map((ref) => ref.id), [first.id]);
    assertEquals(store.getNote(note.id), note);
    assertEquals(store.getNotebook(notebook.id)!.revision, revision);
    const noChange = store.changeCitations(note.id, note.revision, { add: [first.id] });
    assertEquals(noChange.revision, note.revision);
    const changed = store.changeCitations(note.id, note.revision, {
      add: [second.id],
      remove: [first.id],
    });
    assertEquals(changed.revision, note.revision + 1);
    assertEquals(store.listCitations(note.id).items.map((ref) => ref.id), [second.id]);
    assertThrows(
      () => store.updateNote(note.id, note.revision, { title: "Stale draft", body: "" }),
      ResearchConflictError,
    );
    const database = new DatabaseSync(filePath);
    try {
      database.exec("PRAGMA foreign_keys = ON");
      assertThrows(() =>
        database.prepare("INSERT INTO note_citations VALUES (?, ?, ?)").run(
          note.id,
          notebook.id,
          foreign.id,
        )
      );
      assertThrows(() =>
        database.prepare("INSERT INTO note_citations VALUES (?, ?, ?)").run(
          note.id,
          other.id,
          foreign.id,
        )
      );
      assertThrows(() =>
        database.prepare(
          "DELETE FROM notebook_references WHERE notebook_id = ? AND reference_id = ?",
        ).run(notebook.id, second.id)
      );
    } finally {
      database.close();
    }
  });
});

Deno.test("cited reference removal requires explicit unlinking and preserves all note bodies", async () => {
  await withStore((store) => {
    const first = store.createNotebook("First");
    const second = store.createNotebook("Second");
    const ref = { congress: 119, type: "hr", number: 1 };
    store.addReferences(first.id, [ref]);
    store.addReferences(second.id, [ref]);
    const reference = store.listReferences(first.id).items[0];
    const note = store.createNote(first.id, { title: "One", body: "Keep one" }, [reference.id]);
    const another = store.createNote(first.id, { title: "Two", body: "Keep two" }, [reference.id]);
    const unrelated = store.createNote(second.id, { title: "Elsewhere", body: "Keep elsewhere" }, [
      reference.id,
    ]);
    const revision = store.getNotebook(first.id)!.revision;
    assertThrows(
      () => store.removeReference(first.id, reference.id, revision),
      Error,
      "cited by 2 notes",
    );
    assertEquals(store.getNote(note.id), note);
    assertEquals(store.countReferences(first.id), 1);
    assertEquals(store.getNotebook(first.id)!.revision, revision);
    store.removeReference(first.id, reference.id, revision, { unlinkCitations: true });
    assertEquals(store.countCitations(note.id), 0);
    assertEquals(store.countReferences(first.id), 0);
    assertEquals(store.getNote(note.id)!.body, note.body);
    assertEquals(store.getNote(another.id)!.body, another.body);
    assertEquals(store.getNote(note.id)!.revision, note.revision + 1);
    assertEquals(store.getNote(unrelated.id), unrelated);
    assertEquals(store.countCitations(unrelated.id), 1);
    assertEquals(store.countReferences(second.id), 1);
  });
});

Deno.test("notebook deletion atomically removes owned notes and citations without affecting shared references", async () => {
  await withStore((store) => {
    const first = store.createNotebook("First");
    const second = store.createNotebook("Second");
    for (const notebook of [first, second]) {
      store.addReferences(notebook.id, [{ congress: 119, type: "hr", number: 1 }]);
    }
    const reference = store.listReferences(first.id).items[0];
    const note = store.createNote(first.id, { title: "Delete", body: "" }, [reference.id]);
    const keep = store.createNote(second.id, { title: "Keep", body: "" }, [reference.id]);
    store.deleteNotebook(first.id, store.getNotebook(first.id)!.revision);
    assertEquals(store.getNote(note.id), null);
    assertEquals(store.countCitations(note.id), 0);
    assertEquals(store.getNote(keep.id), keep);
    assertEquals(store.countCitations(keep.id), 1);
    assertEquals(store.countReferences(second.id), 1);
    store.deleteNote(keep.id, keep.revision);
    assertEquals(store.countCitations(keep.id), 0);
    assertEquals(store.countReferences(second.id), 1);
  });
});

Deno.test("notes and citations page independently without loading bodies or capping citation count", async () => {
  await withStore((store) => {
    const notebook = store.createNotebook("Scale");
    for (let offset = 0; offset < 500; offset += 250) {
      store.addReferences(
        notebook.id,
        Array.from(
          { length: 250 },
          (_, index) => ({ congress: 119, type: "hr", number: offset + index + 1 }),
        ),
      );
    }
    let note = store.createNote(notebook.id, { title: "Large", body: "# Large\n".repeat(1000) });
    let after: string | undefined;
    do {
      const page = store.listReferences(notebook.id, { after, limit: 250 });
      store.changeCitations(note.id, note.revision, { add: page.items.map((ref) => ref.id) });
      note = store.getNote(note.id)!;
      after = page.nextCursor;
    } while (after);
    assertEquals(store.countCitations(note.id), 500);
    const seen = new Set<string>();
    do {
      const page = store.listCitations(note.id, { after, limit: 13 });
      for (const ref of page.items) seen.add(ref.id);
      after = page.nextCursor;
    } while (after);
    assertEquals(seen.size, 500);
    assertEquals(store.listCitations(note.id, { query: "119 hr500" }).items.length, 1);
    for (let index = 0; index < 55; index++) {
      store.createNote(notebook.id, { title: `Finding ${index}`, body: "" });
    }
    const noteIds = new Set<string>();
    do {
      const page = store.listNotes(notebook.id, { after, limit: 7 });
      for (const summary of page.items) {
        assertEquals("body" in summary, false);
        noteIds.add(summary.id);
      }
      after = page.nextCursor;
    } while (after);
    assertEquals(noteIds.size, 56);
    assertEquals(store.listNotes(notebook.id, { query: "finding" }).items.length, 50);
    assertEquals(store.listNotes(notebook.id, { query: "' OR 1=1 --" }).items, []);
    assertThrows(() => store.listNotes(notebook.id, { limit: 0 }));
    assertThrows(() => store.listCitations(note.id, { limit: 251 }));
    assertThrows(() => store.createNote(notebook.id, { title: " ", body: "" }));
    assertThrows(() =>
      store.changeCitations(note.id, note.revision, { add: Array(251).fill("id") })
    );
  });
});

Deno.test("v2 migration preserves research and creates a private restorable snapshot", async () => {
  const directory = await Deno.makeTempDir();
  const filePath = `${directory}/research.sqlite3`;
  try {
    const original = await ResearchStore.open(filePath);
    const search = original.createSearch(definition);
    const notebook = original.createNotebook("Migrated");
    original.addReferences(notebook.id, [{ congress: 119, type: "hr", number: 1 }]);
    const reference = original.listReferences(notebook.id).items[0];
    original.close();
    const database = new DatabaseSync(filePath);
    database.exec(
      "DROP TABLE import_mappings; DROP TABLE import_runs; DROP TABLE reference_metadata; DROP TABLE note_citations; DROP TABLE notes; PRAGMA user_version = 2",
    );
    database.close();
    const migrated = await ResearchStore.open(filePath);
    try {
      assertEquals(migrated.getSearch(search.id), search);
      assertEquals(migrated.listReferences(notebook.id).items, [reference]);
      const note = migrated.createNote(
        notebook.id,
        { title: "Migrated note", body: "# Markdown" },
        [reference.id],
      );
      assertEquals(migrated.countCitations(note.id), 1);
    } finally {
      migrated.close();
    }
    const backups: string[] = [];
    for await (const entry of Deno.readDir(directory)) {
      if (entry.name.endsWith(".bak")) backups.push(entry.name);
    }
    assertEquals(backups.length, 1);
    const snapshotPath = `${directory}/${backups[0]}`;
    assertEquals(backups[0].startsWith("research.sqlite3.v2-"), true);
    assertEquals((await Deno.stat(snapshotPath)).mode! & 0o777, 0o600);
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      assertEquals(snapshot.prepare("PRAGMA user_version").get()!.user_version, 2);
    } finally {
      snapshot.close();
    }
    const restorePath = `${directory}/restored.sqlite3`;
    await Deno.copyFile(snapshotPath, restorePath);
    const restored = await ResearchStore.open(restorePath);
    try {
      assertEquals(restored.getSearch(search.id), search);
      assertEquals(restored.listReferences(notebook.id).items, [reference]);
      assertEquals(restored.countNotes(notebook.id), 0);
    } finally {
      restored.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("failed v3 migration rolls back without altering v2 research", async () => {
  const directory = await Deno.makeTempDir();
  const filePath = `${directory}/research.sqlite3`;
  try {
    const original = await ResearchStore.open(filePath);
    const notebook = original.createNotebook("Keep");
    original.close();
    const database = new DatabaseSync(filePath);
    database.exec(
      "DROP TABLE import_mappings; DROP TABLE import_runs; DROP TABLE reference_metadata; DROP TABLE note_citations; DROP TABLE notes; CREATE TABLE note_citations (precious TEXT); INSERT INTO note_citations VALUES ('keep'); PRAGMA user_version = 2",
    );
    database.close();
    await assertRejects(() => ResearchStore.open(filePath), Error, "migration rolled back");
    const check = new DatabaseSync(filePath);
    try {
      assertEquals(check.prepare("PRAGMA user_version").get()!.user_version, 2);
      assertEquals(
        check.prepare("SELECT title FROM notebooks WHERE id = ?").get(notebook.id)!.title,
        "Keep",
      );
      assertEquals(check.prepare("SELECT precious FROM note_citations").get()!.precious, "keep");
      assertEquals(
        check.prepare("SELECT name FROM sqlite_master WHERE name = 'notes'").get(),
        undefined,
      );
    } finally {
      check.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("failed reference deletion rolls back citation unlinking and note revisions", async () => {
  await withStore((store, filePath) => {
    const notebook = store.createNotebook("Atomic unlink");
    store.addReferences(notebook.id, [{ congress: 119, type: "hr", number: 1 }]);
    const reference = store.listReferences(notebook.id).items[0];
    const note = store.createNote(notebook.id, { title: "Keep", body: "Keep all content" }, [
      reference.id,
    ]);
    const before = store.getNotebook(notebook.id)!;
    const database = new DatabaseSync(filePath);
    try {
      database.exec(
        "CREATE TRIGGER reject_removal BEFORE DELETE ON notebook_references BEGIN SELECT RAISE(ABORT, 'Simulated write failure'); END",
      );
      assertThrows(
        () =>
          store.removeReference(notebook.id, reference.id, before.revision, {
            unlinkCitations: true,
          }),
        Error,
        "Simulated write failure",
      );
      assertEquals(store.getNote(note.id), note);
      assertEquals(store.getNotebook(notebook.id), before);
      assertEquals(store.countReferences(notebook.id), 1);
      assertEquals(store.countCitations(note.id), 1);
      database.exec("DROP TRIGGER reject_removal");
      store.removeReference(notebook.id, reference.id, before.revision, { unlinkCitations: true });
      assertEquals(store.countReferences(notebook.id), 0);
    } finally {
      database.close();
    }
  });
});
