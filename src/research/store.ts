import { backup, DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join } from "node:path";
import type { EnvReader } from "../config.ts";
import { type BillDetail, type BillRef, type BillSummary, recordLimitations } from "../types.ts";

const SCHEMA_VERSION = 4;
const BILL_TYPES = new Set(["hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"]);

export type CongressSelection = { mode: "current" } | { mode: "fixed"; congress: number };

export interface SearchDefinition {
  name: string;
  query: string;
  type: string | null;
  congress: CongressSelection;
}

export interface SavedSearch extends SearchDefinition {
  id: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface Notebook {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface NotebookReference extends BillRef {
  id: string;
  source: "congress.gov";
  kind: "bill";
  addedAt: string;
  metadata?: ReferenceMetadata;
}

export interface ReferenceMetadata {
  title: string;
  sourceUrl: string;
  sourceUpdatedAt: string;
  retrievedAt: string | null;
  limitations: string[];
  refreshError: string | null;
  attemptedAt: string;
}

function metadataSnapshot(detail: BillSummary, retrievedAt: string): ReferenceMetadata {
  if (!Number.isFinite(Date.parse(retrievedAt))) throw new Error("Invalid retrieval timestamp.");
  const source = new URL(detail.url);
  if (
    source.protocol !== "https:" ||
    !(source.hostname === "congress.gov" || source.hostname.endsWith(".congress.gov")) ||
    source.username || source.password ||
    [...source.searchParams.keys()].some((key) => key !== "format") || source.hash
  ) {
    throw new Error("Metadata source must be a credential-free Congress.gov HTTPS URL.");
  }
  source.search = "";
  return {
    title: detail.title,
    sourceUrl: source.toString(),
    sourceUpdatedAt: detail.updateDate,
    retrievedAt,
    limitations: "completeness" in detail
      ? recordLimitations(detail as BillDetail)
      : ["Summary snapshot; actions and subjects completeness was not retrieved."],
    refreshError: null,
    attemptedAt: retrievedAt,
  };
}

export interface NotebookPageOptions {
  after?: string;
  limit?: number;
  query?: string;
}

export interface NoteDefinition {
  title: string;
  body: string;
}

export interface NoteSummary {
  id: string;
  notebookId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface Note extends NoteSummary {
  body: string;
}

function validateNote(input: NoteDefinition): void {
  if (typeof input.title !== "string" || !input.title.trim()) {
    throw new Error("Note title is required.");
  }
  if (typeof input.body !== "string") throw new Error("Note body must be Markdown text.");
}

function readNoteSummary(row: Record<string, unknown>): NoteSummary {
  return {
    id: row.id as string,
    notebookId: row.notebook_id as string,
    title: row.title as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    revision: row.revision as number,
  };
}

function validateCitationBatch(ids: readonly string[]): void {
  if (!Array.isArray(ids) || ids.length > 250) {
    throw new Error("Change citations in batches of at most 250; notes have no citation cap.");
  }
  if (ids.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error("Invalid citation identifier.");
  }
}

function readReference(row: Record<string, unknown>): NotebookReference {
  return {
    id: row.id as string,
    source: "congress.gov",
    kind: "bill",
    congress: row.congress as number,
    type: row.type as string,
    number: row.number as number,
    addedAt: row.added_at as string,
  };
}

function pageLimit(limit = 50): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
    throw new Error("Page size must be between 1 and 250.");
  }
  return limit;
}

function notebookText(title: string, description: string): void {
  if (typeof title !== "string" || !title.trim()) throw new Error("Notebook title is required.");
  if (typeof description !== "string") throw new Error("Notebook description must be text.");
}

function readNotebook(row: Record<string, unknown>): Notebook {
  return {
    id: row.id as string,
    title: row.title as string,
    description: row.description as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    revision: row.revision as number,
  };
}

function canonicalReference(ref: BillRef): BillRef {
  if (
    !Number.isSafeInteger(ref.congress) || ref.congress < 1 ||
    !Number.isSafeInteger(ref.number) || ref.number < 1 || typeof ref.type !== "string" ||
    !BILL_TYPES.has(ref.type.toLowerCase())
  ) {
    throw new Error(
      "Invalid legislative reference: use a positive Congress, bill type, and number.",
    );
  }
  return { congress: ref.congress, type: ref.type.toLowerCase(), number: ref.number };
}

export class ResearchConflictError extends Error {
  constructor(entity = "Saved search") {
    super(`${entity} changed or was deleted. Reload before saving again.`);
    this.name = "ResearchConflictError";
  }
}

export function researchPath(env: EnvReader = Deno.env): string {
  const dataHome = env.get("XDG_DATA_HOME");
  if (dataHome && isAbsolute(dataHome)) return join(dataHome, "billie", "research.sqlite3");
  const home = env.get("HOME");
  if (home && isAbsolute(home)) return join(home, ".local", "share", "billie", "research.sqlite3");
  throw new Error("Set an absolute XDG_DATA_HOME or HOME to store Billie research data.");
}

function validateDefinition(input: SearchDefinition): SearchDefinition {
  if (typeof input.name !== "string" || !input.name.trim()) {
    throw new Error("Search name is required.");
  }
  if (typeof input.query !== "string" || !input.query.trim()) {
    throw new Error("Search query is required.");
  }
  if (input.type !== null && !BILL_TYPES.has(input.type)) throw new Error("Unsupported bill type.");
  const selection = input.congress;
  if (!selection || (selection.mode !== "current" && selection.mode !== "fixed")) {
    throw new Error("Choose a fixed or current Congress.");
  }
  if (
    selection.mode === "fixed" &&
    (!Number.isSafeInteger(selection.congress) || selection.congress < 1)
  ) {
    throw new Error("Congress must be a positive integer.");
  }
  return {
    name: input.name.trim(),
    query: input.query.trim(),
    type: input.type,
    congress: selection.mode === "current"
      ? { mode: "current" }
      : { mode: "fixed", congress: selection.congress },
  };
}

function readSearch(row: Record<string, unknown>): SavedSearch {
  return {
    id: row.id as string,
    name: row.name as string,
    query: row.query as string,
    type: row.bill_type as string | null,
    congress: row.congress_mode === "current"
      ? { mode: "current" }
      : { mode: "fixed", congress: row.congress as number },
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    revision: row.revision as number,
  };
}

function schemaVersion(database: DatabaseSync): number {
  return Number(database.prepare("PRAGMA user_version").get()!.user_version);
}

function validateSchema(database: DatabaseSync): void {
  const version = schemaVersion(database);
  if (version < 0) throw new Error("Invalid research database schema version.");
  if (version > SCHEMA_VERSION) {
    throw new Error("Research database requires a newer version of Billie.");
  }
  if (
    version === 0 &&
    database.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()
  ) {
    throw new Error("Unrecognized research database; existing data was not migrated.");
  }
  if (version >= 1) {
    database.prepare(
      "SELECT id, name, query, bill_type, congress_mode, congress, created_at, updated_at, revision FROM saved_searches LIMIT 0",
    ).all();
  }
  if (version >= 2) {
    database.prepare(
      "SELECT id, title, description, created_at, updated_at, revision FROM notebooks LIMIT 0",
    ).all();
    database.prepare(
      "SELECT id, source, kind, congress, type, number FROM legislation_references LIMIT 0",
    ).all();
    database.prepare("SELECT notebook_id, reference_id, added_at FROM notebook_references LIMIT 0")
      .all();
  }
  if (version >= 3) {
    database.prepare(
      "SELECT id, notebook_id, title, body, created_at, updated_at, revision FROM notes LIMIT 0",
    ).all();
    database.prepare("SELECT note_id, notebook_id, reference_id FROM note_citations LIMIT 0").all();
  }
  if (version >= 4) {
    database.prepare("SELECT reference_id, snapshot FROM reference_metadata LIMIT 0").all();
    database.prepare("SELECT id, next_record FROM import_runs LIMIT 0").all();
    database.prepare("SELECT run_id, entity, old_id, new_id FROM import_mappings LIMIT 0").all();
  }
}

export class ResearchStore {
  private constructor(private readonly database: DatabaseSync, readonly filePath: string) {}

  static async open(filePath = researchPath()): Promise<ResearchStore> {
    try {
      const info = await Deno.lstat(filePath);
      if (!info.isFile || info.isSymlink) {
        throw new Error("Research database must be a regular file.");
      }
      const existing = new DatabaseSync(filePath, { readOnly: true });
      try {
        validateSchema(existing);
      } finally {
        existing.close();
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const directory = dirname(filePath);
    await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
    await Deno.chmod(directory, 0o700);
    try {
      const file = await Deno.open(filePath, { createNew: true, write: true, mode: 0o600 });
      file.close();
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
    await Deno.chmod(filePath, 0o600);
    const database = new DatabaseSync(filePath);
    try {
      database.exec("PRAGMA busy_timeout = 1500; PRAGMA foreign_keys = ON;");
      let backupPath: string | undefined;
      const previousVersion = schemaVersion(database);
      if (previousVersion > 0 && previousVersion < SCHEMA_VERSION) {
        validateSchema(database);
        backupPath = `${filePath}.v${previousVersion}-${crypto.randomUUID()}.bak`;
        const backupFile = await Deno.open(backupPath, {
          createNew: true,
          write: true,
          mode: 0o600,
        });
        try {
          await backup(database, backupPath);
          backupFile.syncSync();
        } catch (error) {
          throw new Error(
            `Research backup failed; migration was not started: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          backupFile.close();
        }
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        validateSchema(database);
        if (schemaVersion(database) === 0) {
          database.exec(`
            CREATE TABLE saved_searches (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL CHECK(length(trim(name)) > 0),
              query TEXT NOT NULL CHECK(length(trim(query)) > 0),
              bill_type TEXT CHECK(bill_type IS NULL OR bill_type IN ('hr','s','hjres','sjres','hconres','sconres','hres','sres')),
              congress_mode TEXT NOT NULL CHECK(congress_mode IN ('fixed','current')),
              congress INTEGER,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK(revision >= 1),
              CHECK((congress_mode = 'current' AND congress IS NULL) OR
                    (congress_mode = 'fixed' AND congress IS NOT NULL AND congress > 0))
            ) STRICT;
            PRAGMA user_version = 1;
          `);
        }
        if (schemaVersion(database) === 1) {
          database.exec(`
            CREATE TABLE notebooks (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL CHECK(length(trim(title)) > 0),
              description TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK(revision >= 1)
            ) STRICT;
            CREATE TABLE legislation_references (
              id TEXT PRIMARY KEY,
              source TEXT NOT NULL CHECK(source = 'congress.gov'),
              kind TEXT NOT NULL CHECK(kind = 'bill'),
              congress INTEGER NOT NULL CHECK(congress > 0),
              type TEXT NOT NULL CHECK(type IN ('hr','s','hjres','sjres','hconres','sconres','hres','sres')),
              number INTEGER NOT NULL CHECK(number > 0),
              UNIQUE(source, kind, congress, type, number)
            ) STRICT;
            CREATE TABLE notebook_references (
              notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
              reference_id TEXT NOT NULL REFERENCES legislation_references(id),
              added_at TEXT NOT NULL,
              PRIMARY KEY(notebook_id, reference_id)
            ) STRICT;
            CREATE INDEX membership_by_reference ON notebook_references(reference_id);
            PRAGMA user_version = 2;
          `);
        }
        if (schemaVersion(database) === 2) {
          database.exec(`
            CREATE TABLE notes (
              id TEXT PRIMARY KEY,
              notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
              title TEXT NOT NULL CHECK(length(trim(title)) > 0),
              body TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK(revision >= 1),
              UNIQUE(id, notebook_id)
            ) STRICT;
            CREATE INDEX notes_by_notebook ON notes(notebook_id, id);
            CREATE TABLE note_citations (
              note_id TEXT NOT NULL,
              notebook_id TEXT NOT NULL,
              reference_id TEXT NOT NULL,
              PRIMARY KEY(note_id, reference_id),
              FOREIGN KEY(note_id, notebook_id) REFERENCES notes(id, notebook_id) ON DELETE CASCADE,
              FOREIGN KEY(notebook_id, reference_id) REFERENCES notebook_references(notebook_id, reference_id)
            ) STRICT;
            CREATE INDEX citations_by_membership ON note_citations(notebook_id, reference_id, note_id);
            PRAGMA user_version = 3;
          `);
        }
        if (schemaVersion(database) === 3) {
          database.exec(`CREATE TABLE reference_metadata (
            reference_id TEXT PRIMARY KEY REFERENCES legislation_references(id) ON DELETE CASCADE,
            snapshot TEXT NOT NULL CHECK(json_valid(snapshot))
          ) STRICT;
          CREATE TABLE import_runs (id TEXT PRIMARY KEY, next_record INTEGER NOT NULL) STRICT;
          CREATE TABLE import_mappings (
            run_id TEXT NOT NULL REFERENCES import_runs(id), entity TEXT NOT NULL,
            old_id TEXT NOT NULL, new_id TEXT NOT NULL,
            PRIMARY KEY(run_id, entity, old_id)
          ) STRICT;
          PRAGMA user_version = 4;`);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        if (backupPath) {
          throw new Error(
            `Research migration rolled back. Prior schema backup: ${backupPath}. ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        throw error;
      }
      return new ResearchStore(database, filePath);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  getMetadata(referenceId: string): ReferenceMetadata | undefined {
    const row = this.database.prepare(
      "SELECT snapshot FROM reference_metadata WHERE reference_id = ?",
    ).get(referenceId);
    return row ? JSON.parse(row.snapshot as string) : undefined;
  }

  saveMetadata(referenceId: string, detail: BillDetail, retrievedAt: string): void {
    const reference = this.database.prepare("SELECT * FROM legislation_references WHERE id = ?")
      .get(referenceId);
    if (
      !reference || reference.congress !== detail.congress || reference.type !== detail.type ||
      reference.number !== detail.number
    ) {
      throw new Error("Metadata must match an existing reference.");
    }
    this.writeMetadata(referenceId, metadataSnapshot(detail, retrievedAt));
  }

  failMetadata(referenceId: string, attemptedAt: string): void {
    if (!Number.isFinite(Date.parse(attemptedAt))) throw new Error("Invalid refresh timestamp.");
    this.writeMetadata(referenceId, {
      title: "",
      sourceUrl: "",
      sourceUpdatedAt: "",
      retrievedAt: null,
      limitations: [],
      ...this.getMetadata(referenceId),
      attemptedAt,
      refreshError: "Refresh failed; previous metadata retained. Retry explicit refresh.",
    });
  }

  private writeMetadata(referenceId: string, metadata: ReferenceMetadata): void {
    this.transaction(() => {
      this.database.prepare(
        "INSERT INTO reference_metadata VALUES (?, ?) ON CONFLICT(reference_id) DO UPDATE SET snapshot = excluded.snapshot",
      )
        .run(referenceId, JSON.stringify(metadata));
      this.database.prepare(
        "UPDATE notebooks SET revision = revision + 1 WHERE id IN (SELECT notebook_id FROM notebook_references WHERE reference_id = ?)",
      ).run(referenceId);
    });
  }

  private referenceWithMetadata(row: Record<string, unknown>): NotebookReference {
    const reference = readReference(row);
    const metadata = this.getMetadata(reference.id);
    return metadata ? { ...reference, metadata } : reference;
  }

  private retainMetadata(referenceId: string, reference: BillRef): void {
    if (
      !("retrievedAt" in reference) || typeof reference.retrievedAt !== "string" ||
      !("title" in reference) || !("url" in reference) || !("updateDate" in reference)
    ) return;
    const snapshot = metadataSnapshot(reference as BillSummary, reference.retrievedAt);
    this.database.prepare(
      "INSERT INTO reference_metadata VALUES (?, ?) ON CONFLICT(reference_id) DO NOTHING",
    )
      .run(referenceId, JSON.stringify(snapshot));
  }

  createNotebook(title: string, description = ""): Notebook {
    notebookText(title, description);
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const row = this.database.prepare(`
      INSERT INTO notebooks VALUES (?, ?, ?, ?, ?, 1) RETURNING *
    `).get(id, title.trim(), description.trim(), timestamp, timestamp)!;
    return readNotebook(row);
  }

  getNotebook(id: string): Notebook | null {
    const row = this.database.prepare("SELECT * FROM notebooks WHERE id = ?").get(id);
    return row ? readNotebook(row) : null;
  }

  listNotebooks(options: NotebookPageOptions = {}): { items: Notebook[]; nextCursor?: string } {
    const limit = pageLimit(options.limit);
    const rows = this.database.prepare(`
      SELECT * FROM notebooks WHERE id > ? AND instr(lower(title), lower(?)) > 0 ORDER BY id LIMIT ?
    `).all(options.after ?? "", options.query ?? "", limit + 1);
    const items = rows.slice(0, limit).map(readNotebook);
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : undefined };
  }

  updateNotebook(id: string, revision: number, title: string, description: string): Notebook {
    notebookText(title, description);
    this.checkRevision(revision);
    const row = this.database.prepare(`
      UPDATE notebooks SET title = ?, description = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND revision = ? RETURNING *
    `).get(title.trim(), description.trim(), new Date().toISOString(), id, revision);
    if (!row) throw new ResearchConflictError("Notebook");
    return readNotebook(row);
  }

  deleteNotebook(id: string, revision: number): void {
    this.checkRevision(revision);
    const result = this.database.prepare("DELETE FROM notebooks WHERE id = ? AND revision = ?").run(
      id,
      revision,
    );
    if (result.changes !== 1) throw new ResearchConflictError("Notebook");
  }

  addReferences(
    notebookId: string,
    references: readonly BillRef[],
  ): { added: number; existing: number } {
    if (references.length > 250) {
      throw new Error("Add references in batches of at most 250; notebook membership has no cap.");
    }
    const validated = references.map(canonicalReference);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.getNotebook(notebookId)) throw new ResearchConflictError("Notebook");
      const insertReference = this.database.prepare(`
        INSERT INTO legislation_references VALUES (?, 'congress.gov', 'bill', ?, ?, ?)
        ON CONFLICT(source, kind, congress, type, number) DO NOTHING
      `);
      const findReference = this.database.prepare(`
        SELECT id FROM legislation_references WHERE source = 'congress.gov' AND kind = 'bill'
          AND congress = ? AND type = ? AND number = ?
      `);
      const insertMembership = this.database.prepare(`
        INSERT INTO notebook_references VALUES (?, ?, ?) ON CONFLICT(notebook_id, reference_id) DO NOTHING
      `);
      const timestamp = new Date().toISOString();
      let added = 0;
      for (const [index, ref] of validated.entries()) {
        insertReference.run(crypto.randomUUID(), ref.congress, ref.type, ref.number);
        const id = findReference.get(ref.congress, ref.type, ref.number)!.id as string;
        added += Number(insertMembership.run(notebookId, id, timestamp).changes);
        this.retainMetadata(id, references[index]);
      }
      if (added) this.touchNotebook(notebookId);
      this.database.exec("COMMIT");
      return { added, existing: references.length - added };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listReferences(
    notebookId: string,
    options: NotebookPageOptions = {},
  ): { items: NotebookReference[]; nextCursor?: string } {
    const limit = pageLimit(options.limit);
    const rows = this.database.prepare(`
      SELECT reference.*, membership.added_at FROM notebook_references AS membership
      JOIN legislation_references AS reference ON reference.id = membership.reference_id
      WHERE membership.notebook_id = ? AND membership.reference_id > ?
        AND instr(lower(reference.congress || ' ' || reference.type || reference.number), lower(?)) > 0
      ORDER BY membership.reference_id LIMIT ?
    `).all(notebookId, options.after ?? "", options.query ?? "", limit + 1);
    const items = rows.slice(0, limit).map((row) => this.referenceWithMetadata(row));
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : undefined };
  }

  countReferences(notebookId: string): number {
    return Number(
      this.database.prepare(
        "SELECT count(*) AS total FROM notebook_references WHERE notebook_id = ?",
      ).get(notebookId)!.total,
    );
  }

  removeReference(
    notebookId: string,
    referenceId: string,
    revision: number,
    options: { unlinkCitations?: boolean } = {},
  ): void {
    this.checkRevision(revision);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (this.getNotebook(notebookId)?.revision !== revision) {
        throw new ResearchConflictError("Notebook");
      }
      const citingNotes = this.countCitingNotes(notebookId, referenceId);
      if (citingNotes && !options.unlinkCitations) {
        throw new Error(
          `Reference is cited by ${citingNotes} notes. Explicitly unlink citations before removing it.`,
        );
      }
      if (citingNotes) {
        this.database.prepare(`
          UPDATE notes SET revision = revision + 1, updated_at = ? WHERE id IN (
            SELECT note_id FROM note_citations WHERE notebook_id = ? AND reference_id = ?
          )
        `).run(new Date().toISOString(), notebookId, referenceId);
        this.database.prepare(
          "DELETE FROM note_citations WHERE notebook_id = ? AND reference_id = ?",
        ).run(notebookId, referenceId);
      }
      const result = this.database.prepare(
        "DELETE FROM notebook_references WHERE notebook_id = ? AND reference_id = ?",
      ).run(notebookId, referenceId);
      if (result.changes !== 1) throw new ResearchConflictError("Notebook reference");
      this.touchNotebook(notebookId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private touchNotebook(id: string): void {
    this.database.prepare(
      "UPDATE notebooks SET revision = revision + 1, updated_at = ? WHERE id = ?",
    )
      .run(new Date().toISOString(), id);
  }

  createNote(notebookId: string, input: NoteDefinition, citationIds: readonly string[] = []): Note {
    validateNote(input);
    validateCitationBatch(citationIds);
    return this.transaction(() => {
      if (!this.getNotebook(notebookId)) throw new ResearchConflictError("Notebook");
      const id = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      this.database.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, 1)")
        .run(id, notebookId, input.title.trim(), input.body, timestamp, timestamp);
      this.insertCitations(id, notebookId, citationIds);
      this.touchNotebook(notebookId);
      return this.getNote(id)!;
    });
  }

  getNote(id: string): Note | null {
    const row = this.database.prepare("SELECT * FROM notes WHERE id = ?").get(id);
    return row ? { ...readNoteSummary(row), body: row.body as string } : null;
  }

  listNotes(
    notebookId: string,
    options: NotebookPageOptions = {},
  ): { items: NoteSummary[]; nextCursor?: string } {
    const limit = pageLimit(options.limit);
    const rows = this.database.prepare(`
      SELECT id, notebook_id, title, created_at, updated_at, revision FROM notes
      WHERE notebook_id = ? AND id > ? AND instr(lower(title), lower(?)) > 0 ORDER BY id LIMIT ?
    `).all(notebookId, options.after ?? "", options.query ?? "", limit + 1);
    const items = rows.slice(0, limit).map(readNoteSummary);
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : undefined };
  }

  countNotes(notebookId: string): number {
    return Number(
      this.database.prepare("SELECT count(*) AS total FROM notes WHERE notebook_id = ?").get(
        notebookId,
      )!.total,
    );
  }

  updateNote(id: string, revision: number, input: NoteDefinition): Note {
    validateNote(input);
    this.checkRevision(revision);
    return this.transaction(() => {
      const note = this.requireNoteRevision(id, revision);
      this.database.prepare(
        "UPDATE notes SET title = ?, body = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
      )
        .run(input.title.trim(), input.body, new Date().toISOString(), id);
      this.touchNotebook(note.notebookId);
      return this.getNote(id)!;
    });
  }

  deleteNote(id: string, revision: number): void {
    this.checkRevision(revision);
    this.transaction(() => {
      const note = this.requireNoteRevision(id, revision);
      this.database.prepare("DELETE FROM notes WHERE id = ?").run(id);
      this.touchNotebook(note.notebookId);
    });
  }

  changeCitations(
    id: string,
    revision: number,
    changes: { add?: readonly string[]; remove?: readonly string[] },
  ): NoteSummary {
    this.checkRevision(revision);
    const additions = changes.add ?? [];
    const removals = changes.remove ?? [];
    validateCitationBatch([...additions, ...removals]);
    if (additions.some((referenceId) => removals.includes(referenceId))) {
      throw new Error("Cannot add and remove the same citation in one change.");
    }
    return this.transaction(() => {
      const note = this.requireNoteRevision(id, revision);
      let changed = this.insertCitations(id, note.notebookId, additions);
      const remove = this.database.prepare(
        "DELETE FROM note_citations WHERE note_id = ? AND reference_id = ?",
      );
      for (const referenceId of removals) changed += Number(remove.run(id, referenceId).changes);
      if (changed) {
        this.database.prepare(
          "UPDATE notes SET revision = revision + 1, updated_at = ? WHERE id = ?",
        )
          .run(new Date().toISOString(), id);
        this.touchNotebook(note.notebookId);
      }
      return this.requireNoteRevision(id, revision + (changed ? 1 : 0));
    });
  }

  citeReference(id: string, revision: number, reference: BillRef): NoteSummary {
    this.checkRevision(revision);
    const ref = canonicalReference(reference);
    return this.transaction(() => {
      const note = this.requireNoteRevision(id, revision);
      this.database.prepare(`
        INSERT INTO legislation_references VALUES (?, 'congress.gov', 'bill', ?, ?, ?)
        ON CONFLICT(source, kind, congress, type, number) DO NOTHING
      `).run(crypto.randomUUID(), ref.congress, ref.type, ref.number);
      const referenceId = this.database.prepare(`
        SELECT id FROM legislation_references WHERE source = 'congress.gov' AND kind = 'bill'
          AND congress = ? AND type = ? AND number = ?
      `).get(ref.congress, ref.type, ref.number)!.id as string;
      const timestamp = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO notebook_references VALUES (?, ?, ?)
        ON CONFLICT(notebook_id, reference_id) DO NOTHING
      `).run(note.notebookId, referenceId, timestamp);
      this.retainMetadata(referenceId, reference);
      const added = this.insertCitations(id, note.notebookId, [referenceId]);
      if (added) {
        this.database.prepare(
          "UPDATE notes SET revision = revision + 1, updated_at = ? WHERE id = ?",
        ).run(timestamp, id);
        this.touchNotebook(note.notebookId);
      }
      return this.requireNoteRevision(id, revision + added);
    });
  }

  listCitations(
    noteId: string,
    options: NotebookPageOptions = {},
  ): { items: NotebookReference[]; nextCursor?: string } {
    const limit = pageLimit(options.limit);
    const rows = this.database.prepare(`
      SELECT reference.*, membership.added_at FROM note_citations AS citation
      JOIN legislation_references AS reference ON reference.id = citation.reference_id
      JOIN notebook_references AS membership ON membership.notebook_id = citation.notebook_id AND membership.reference_id = citation.reference_id
      WHERE citation.note_id = ? AND citation.reference_id > ?
        AND instr(lower(reference.congress || ' ' || reference.type || reference.number), lower(?)) > 0
      ORDER BY citation.reference_id LIMIT ?
    `).all(noteId, options.after ?? "", options.query ?? "", limit + 1);
    const items = rows.slice(0, limit).map((row) => this.referenceWithMetadata(row));
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : undefined };
  }

  countCitations(noteId: string): number {
    return Number(
      this.database.prepare("SELECT count(*) AS total FROM note_citations WHERE note_id = ?").get(
        noteId,
      )!.total,
    );
  }

  countCitingNotes(notebookId: string, referenceId: string): number {
    return Number(
      this.database.prepare(
        "SELECT count(*) AS total FROM note_citations WHERE notebook_id = ? AND reference_id = ?",
      ).get(notebookId, referenceId)!.total,
    );
  }

  private requireNoteRevision(id: string, revision: number): NoteSummary {
    const row = this.database.prepare(
      "SELECT id, notebook_id, title, created_at, updated_at, revision FROM notes WHERE id = ? AND revision = ?",
    ).get(id, revision);
    if (!row) throw new ResearchConflictError("Note");
    return readNoteSummary(row);
  }

  private insertCitations(
    noteId: string,
    notebookId: string,
    referenceIds: readonly string[],
  ): number {
    const insert = this.database.prepare(
      "INSERT INTO note_citations VALUES (?, ?, ?) ON CONFLICT(note_id, reference_id) DO NOTHING",
    );
    const membership = this.database.prepare(
      "SELECT 1 FROM notebook_references WHERE notebook_id = ? AND reference_id = ?",
    );
    let added = 0;
    for (const referenceId of referenceIds) {
      if (!membership.get(notebookId, referenceId)) {
        throw new Error("Citations must reference legislation in the same notebook.");
      }
      added += Number(insert.run(noteId, notebookId, referenceId).changes);
    }
    return added;
  }

  private transaction<Value>(operation: () => Value): Value {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  createSearch(input: SearchDefinition): SavedSearch {
    const definition = validateDefinition(input);
    const timestamp = new Date().toISOString();
    const id = crypto.randomUUID();
    this.database.prepare(`
      INSERT INTO saved_searches VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      id,
      definition.name,
      definition.query,
      definition.type,
      definition.congress.mode,
      definition.congress.mode === "fixed" ? definition.congress.congress : null,
      timestamp,
      timestamp,
    );
    return this.getSearch(id)!;
  }

  getSearch(id: string): SavedSearch | null {
    const row = this.database.prepare("SELECT * FROM saved_searches WHERE id = ?").get(id);
    return row ? readSearch(row) : null;
  }

  listSearches(
    options: { after?: string; limit?: number; name?: string } = {},
  ): { items: SavedSearch[]; nextCursor?: string } {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
      throw new Error("Page size must be between 1 and 250.");
    }
    const rows = this.database.prepare(`
      SELECT * FROM saved_searches
      WHERE id > ? AND instr(lower(name), lower(?)) > 0
      ORDER BY id LIMIT ?
    `).all(options.after ?? "", options.name ?? "", limit + 1);
    const items = rows.slice(0, limit).map(readSearch);
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : undefined };
  }

  updateSearch(id: string, revision: number, input: SearchDefinition): SavedSearch {
    const definition = validateDefinition(input);
    this.checkRevision(revision);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE saved_searches SET name = ?, query = ?, bill_type = ?, congress_mode = ?, congress = ?,
          updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?
      `).run(
        definition.name,
        definition.query,
        definition.type,
        definition.congress.mode,
        definition.congress.mode === "fixed" ? definition.congress.congress : null,
        new Date().toISOString(),
        id,
        revision,
      );
      if (result.changes !== 1) throw new ResearchConflictError();
      const saved = this.getSearch(id)!;
      this.database.exec("COMMIT");
      return saved;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  deleteSearch(id: string, revision: number): void {
    this.checkRevision(revision);
    const result = this.database.prepare("DELETE FROM saved_searches WHERE id = ? AND revision = ?")
      .run(id, revision);
    if (result.changes !== 1) throw new ResearchConflictError();
  }

  private checkRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error("Invalid research revision.");
    }
  }
}
