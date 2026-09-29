import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { JSONParser, TokenType } from "@streamparser/json";
import { ResearchStore } from "./store.ts";

const columns = {
  saved_searches: [
    "id",
    "name",
    "query",
    "bill_type",
    "congress_mode",
    "congress",
    "created_at",
    "updated_at",
    "revision",
  ],
  notebooks: ["id", "title", "description", "created_at", "updated_at", "revision"],
  legislation_references: ["id", "source", "kind", "congress", "type", "number"],
  notebook_references: ["notebook_id", "reference_id", "added_at"],
  notes: ["id", "notebook_id", "title", "body", "created_at", "updated_at", "revision"],
  note_citations: ["note_id", "notebook_id", "reference_id"],
  reference_metadata: ["reference_id", "snapshot"],
} as const;
type Table = keyof typeof columns;
type Row = Record<string, string | number | null>;
type RecordEntry = { table: Table; row: Row };
const tables = Object.keys(columns) as Table[];

function validate(entry: unknown): RecordEntry {
  if (!entry || typeof entry !== "object") throw new Error("Invalid archive record.");
  if (
    Object.keys(entry).length !== 2 || !Object.hasOwn(entry, "table") ||
    !Object.hasOwn(entry, "row")
  ) throw new Error("Unexpected archive record fields.");
  const { table, row } = entry as RecordEntry;
  if (!Object.hasOwn(columns, table) || !row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Unknown archive record type.");
  }
  const expected: readonly string[] = columns[table];
  if (
    Object.keys(row).length !== expected.length || expected.some((key) => !Object.hasOwn(row, key))
  ) throw new Error("Unexpected archive fields.");
  for (const [key, value] of Object.entries(row)) {
    if (["revision", "congress", "number"].includes(key)) {
      if (value === null && table === "saved_searches" && key === "congress") continue;
      if (!Number.isSafeInteger(value) || Number(value) < 1) {
        throw new Error("Invalid archive integer.");
      }
    } else if (key === "bill_type" && value === null) continue;
    else if (typeof value !== "string") throw new Error("Invalid archive text.");
    if (
      (key === "id" || key.endsWith("_id")) &&
      (typeof value !== "string" || !/^[\w-]+$/.test(value))
    ) throw new Error("Record IDs cannot be paths.");
    if (key.endsWith("_at") && !Number.isFinite(Date.parse(String(value)))) {
      throw new Error("Invalid archive timestamp.");
    }
  }
  if (table === "reference_metadata") {
    const data = JSON.parse(row.snapshot as string);
    const keys = [
      "title",
      "sourceUrl",
      "sourceUpdatedAt",
      "retrievedAt",
      "limitations",
      "refreshError",
      "attemptedAt",
    ];
    if (
      !data || Object.keys(data).length !== keys.length || keys.some((key) =>
        !Object.hasOwn(data, key)
      ) ||
      ![data.title, data.sourceUrl, data.sourceUpdatedAt, data.attemptedAt].every((value) =>
        typeof value === "string"
      ) ||
      !Number.isFinite(Date.parse(data.attemptedAt)) ||
      (data.retrievedAt !== null &&
        (typeof data.retrievedAt !== "string" || !Number.isFinite(Date.parse(data.retrievedAt)))) ||
      (data.refreshError !== null && typeof data.refreshError !== "string") ||
      !Array.isArray(data.limitations) || !data.limitations.every((value: unknown) =>
        typeof value === "string"
      )
    ) throw new Error("Invalid metadata snapshot.");
    if (data.sourceUrl) {
      const url = new URL(data.sourceUrl);
      if (
        url.protocol !== "https:" ||
        !(url.hostname === "congress.gov" || url.hostname.endsWith(".congress.gov")) ||
        url.username || url.password || url.search || url.hash
      ) throw new Error("Unsafe metadata source URL.");
    }
  }
  return { table, row };
}

function insert(database: DatabaseSync, entry: RecordEntry, schema = "main"): void {
  const names = columns[entry.table];
  database.prepare(
    `INSERT INTO ${schema}.${entry.table} (${names.join(",")}) VALUES (${
      names.map(() => "?").join(",")
    })`,
  )
    .run(...names.map((name) => entry.row[name]));
}

function* records(database: DatabaseSync, notebookId?: string): Generator<RecordEntry> {
  for (const table of tables) {
    let where = "";
    if (notebookId) {
      if (table === "saved_searches") continue;
      if (table === "notebooks") where = " WHERE id = ?";
      else if (table === "legislation_references") {
        where = " WHERE id IN (SELECT reference_id FROM notebook_references WHERE notebook_id = ?)";
      } else if (table === "reference_metadata") {
        where =
          " WHERE reference_id IN (SELECT reference_id FROM notebook_references WHERE notebook_id = ?)";
      } else where = " WHERE notebook_id = ?";
    }
    let after = 0;
    while (true) {
      const rows = database.prepare(
        `SELECT rowid AS cursor, ${columns[table].join(",")} FROM ${table}${where}${
          where ? " AND" : " WHERE"
        } rowid > ? ORDER BY rowid LIMIT 250`,
      ).all(...(notebookId ? [notebookId] : []), after);
      if (!rows.length) break;
      for (const row of rows) {
        const { cursor, ...values } = row;
        after = Number(cursor);
        yield { table, row: values as Row };
      }
    }
  }
}

export async function exportResearch(
  store: Pick<ResearchStore, "filePath">,
  directory: string,
  format: "json" | "markdown",
  notebookId?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (format === "markdown" && !notebookId) {
    throw new Error("Choose a notebook for Markdown export.");
  }
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  const output = join(
    directory,
    `research-${crypto.randomUUID()}.${format === "json" ? "json" : "md"}`,
  );
  const partial = `${output}.partial`;
  const file = await Deno.open(partial, { write: true, createNew: true, mode: 0o600 });
  let fileClosed = false;
  const encoder = new TextEncoder();
  const write = async (text: string) => {
    signal?.throwIfAborted();
    const bytes = encoder.encode(text);
    let offset = 0;
    while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
  };
  const database = new DatabaseSync(store.filePath, { readOnly: true });
  try {
    database.exec("BEGIN");
    if (notebookId && !database.prepare("SELECT 1 FROM notebooks WHERE id = ?").get(notebookId)) {
      throw new Error("Notebook was deleted.");
    }
    if (format === "json") {
      await write('{"format":"billie-research","version":1,"records":[\n');
      let first = true;
      for (const entry of records(database, notebookId)) {
        await write(`${first ? "" : ",\n"}${JSON.stringify(entry)}`);
        first = false;
      }
      await write("\n]}\n");
    } else {
      const notebook = database.prepare("SELECT * FROM notebooks WHERE id = ?").get(notebookId!)!;
      await write(`# ${notebook.title}\n\n${notebook.description}\n\n## Reference index\n\n`);
      for (
        const ref of database.prepare(
          `SELECT r.*, m.snapshot FROM notebook_references n JOIN legislation_references r ON r.id = n.reference_id LEFT JOIN reference_metadata m ON m.reference_id = r.id WHERE n.notebook_id = ? ORDER BY r.id`,
        ).iterate(notebookId!)
      ) {
        const metadata = ref.snapshot ? JSON.parse(ref.snapshot as string) : undefined;
        await write(
          `- ${
            String(ref.type).toUpperCase()
          } ${ref.number} (${ref.congress}th Congress) [${ref.id}]\n  - ${
            metadata?.title ?? "Unresolved reference"
          }\n  - Source: ${
            metadata?.sourceUrl || `https://www.congress.gov/bill/${ref.congress}th-congress/${
              ({
                hr: "house-bill",
                s: "senate-bill",
                hjres: "house-joint-resolution",
                sjres: "senate-joint-resolution",
                hconres: "house-concurrent-resolution",
                sconres: "senate-concurrent-resolution",
                hres: "house-resolution",
                sres: "senate-resolution",
              } as Record<string, string>)[String(ref.type)]
            }/${ref.number}`
          }\n  - Retrieved: ${metadata?.retrievedAt ?? "never"}; source updated: ${
            metadata?.sourceUpdatedAt || "unknown"
          }\n`,
        );
        for (const notice of metadata?.limitations ?? []) {
          await write(`  - Limitation: ${notice}\n`);
        }
        if (metadata?.refreshError) await write(`  - Refresh error: ${metadata.refreshError}\n`);
      }
      await write(
        "\n## Research notes\n\nUser-authored or explicitly saved generated content; not authoritative legislative records.\n\n",
      );
      for (
        const note of database.prepare("SELECT * FROM notes WHERE notebook_id = ? ORDER BY id")
          .iterate(notebookId!)
      ) {
        await write(`### ${note.title}\n\n${note.body}\n\nCitations:\n`);
        for (
          const cite of database.prepare(
            "SELECT reference_id FROM note_citations WHERE note_id = ? ORDER BY reference_id",
          ).iterate(note.id!)
        ) await write(`- ${cite.reference_id}\n`);
        await write("\n");
      }
    }
    database.exec("COMMIT");
    await file.sync();
    file.close();
    fileClosed = true;
    await Deno.rename(partial, output);
    return output;
  } catch (error) {
    if (!fileClosed) file.close();
    await Deno.remove(partial).catch(() => {});
    throw error;
  } finally {
    database.close();
  }
}

export async function stageImport(
  store: Pick<ResearchStore, "filePath">,
  source: string,
  signal?: AbortSignal,
): Promise<string> {
  const stagePath = join(dirname(store.filePath), `import-${crypto.randomUUID()}.sqlite3`);
  const stageStore = await ResearchStore.open(stagePath);
  stageStore.close();
  const database = new DatabaseSync(stagePath);
  let databaseClosed = false;
  database.exec("PRAGMA foreign_keys = ON");
  let format: unknown;
  let version: unknown;
  let order = -1;
  let count = 0;
  let parserError: unknown;
  const containers: Array<
    { object: boolean; key?: string; keys: Set<string>; expectKey: boolean }
  > = [];
  const rootKeys = new Set<string>();
  const parser = new JSONParser({
    paths: ["$.format", "$.version", "$.records.*"],
    keepStack: false,
  });
  parser.onToken = ({ token, value }) => {
    const current = containers.at(-1);
    if (!current && token !== TokenType.LEFT_BRACE && !parser.isEnded) {
      throw new Error("Archive root must be an object.");
    }
    if (current?.object && current.expectKey && token === TokenType.STRING) {
      const key = String(value);
      if (
        current.keys.has(key) || key === "__proto__" || key === "constructor" || key === "prototype"
      ) throw new Error("Duplicate or unsafe archive key.");
      current.keys.add(key);
      current.key = key;
      current.expectKey = false;
      if (containers.length === 1) {
        if (!["format", "version", "records"].includes(key)) {
          throw new Error("Unknown archive field.");
        }
        rootKeys.add(key);
      }
    } else if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) {
      if (
        containers.length === 1 && (current?.key !== "records" || token !== TokenType.LEFT_BRACKET)
      ) throw new Error("Archive records must be an array.");
      if (containers.length > 6) throw new Error("Unexpected archive nesting.");
      containers.push({
        object: token === TokenType.LEFT_BRACE,
        keys: new Set(),
        expectKey: token === TokenType.LEFT_BRACE,
      });
    } else if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) {
      containers.pop();
    } else if (token === TokenType.COMMA && current?.object) current.expectKey = true;
    else if (containers.length === 1 && current?.key === "records" && token !== TokenType.COLON) {
      throw new Error("Archive records must be an array.");
    }
  };
  parser.onValue = ({ value, key, stack }) => {
    if (stack.length === 1 && key === "format") {
      format = value;
      return;
    }
    if (stack.length === 1 && key === "version") {
      version = value;
      return;
    }
    const entry = validate(value);
    const position = tables.indexOf(entry.table);
    if (position < order) throw new Error("Archive records must follow dependency order.");
    order = position;
    insert(database, entry);
    count++;
  };
  parser.onError = (error) => {
    parserError = error;
  };
  try {
    const file = await Deno.open(source, { read: true });
    for await (const chunk of file.readable) {
      signal?.throwIfAborted();
      database.exec("BEGIN");
      try {
        parser.write(chunk);
        if (parserError) throw parserError;
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    if (!parser.isEnded) parser.end();
    if (parserError) throw parserError;
    if (format !== "billie-research" || version !== 1 || rootKeys.size !== 3) {
      throw new Error("Unsupported research archive format/version.");
    }
    if (database.prepare("PRAGMA foreign_key_check").get()) {
      throw new Error("Archive has invalid relationships.");
    }
    database.exec(
      `CREATE TABLE import_state (target TEXT NOT NULL, id TEXT NOT NULL, total INTEGER NOT NULL);`,
    );
    database.prepare("INSERT INTO import_state VALUES (?,?,?)").run(
      resolve(store.filePath),
      crypto.randomUUID(),
      count,
    );
    return stagePath;
  } catch (error) {
    database.close();
    databaseClosed = true;
    await Deno.remove(stagePath);
    throw error;
  } finally {
    if (!databaseClosed) database.close();
  }
}

export async function resumeImport(
  store: Pick<ResearchStore, "filePath">,
  stagePath: string,
  signal?: AbortSignal,
  progress?: (committed: number, total: number) => void,
): Promise<number> {
  const info = await Deno.lstat(stagePath);
  if (!info.isFile || info.isSymlink || (info.mode! & 0o077)) {
    throw new Error("Import stage must be a private regular file.");
  }
  const database = new DatabaseSync(store.filePath);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1500");
  let source: DatabaseSync | undefined;
  let committed = 0;
  try {
    source = new DatabaseSync(stagePath, { readOnly: true });
    const state = source.prepare("SELECT * FROM import_state").get();
    if (!state || state.target !== resolve(store.filePath)) {
      throw new Error("Import stage belongs to another database.");
    }
    if (typeof state.id !== "string" || !/^[\w-]+$/.test(state.id)) {
      throw new Error("Invalid import session.");
    }
    committed = Number(
      database.prepare("SELECT next_record FROM import_runs WHERE id=?").get(state.id)
        ?.next_record ?? 0,
    );
    const mapped = (entity: string, id: string): string => {
      const row = database.prepare(
        "SELECT new_id FROM import_mappings WHERE run_id = ? AND entity = ? AND old_id = ?",
      ).get(state.id, entity, id);
      if (!row) throw new Error("Missing imported relationship.");
      return row.new_id as string;
    };
    {
      let index = 0;
      let batch: RecordEntry[] = [];
      const commit = () => {
        signal?.throwIfAborted();
        database.exec("BEGIN IMMEDIATE");
        try {
          database.prepare("INSERT INTO import_runs VALUES (?,0) ON CONFLICT(id) DO NOTHING").run(
            state.id,
          );
          if (
            Number(
              database.prepare("SELECT next_record FROM import_runs WHERE id=?").get(state.id)!
                .next_record,
            ) !== committed
          ) throw new Error("Import is already running in another instance. Retry resume.");
          for (const entry of batch) {
            const { table } = entry;
            const row = { ...entry.row };
            if ("id" in row) {
              const previous = row.id as string;
              const existing = table === "legislation_references"
                ? database.prepare(
                  "SELECT id FROM legislation_references WHERE congress=? AND type=? AND number=?",
                ).get(row.congress, row.type, row.number)
                : undefined;
              row.id = existing ? existing.id as string : crypto.randomUUID();
              database.prepare("INSERT INTO import_mappings VALUES (?,?,?,?)").run(
                state.id,
                table,
                previous,
                row.id,
              );
              if (existing) continue;
            }
            for (
              const [key, entity] of [["notebook_id", "notebooks"], ["note_id", "notes"], [
                "reference_id",
                "legislation_references",
              ]]
            ) {
              if (key in row) row[key] = mapped(entity, row[key] as string);
            }
            if (table === "reference_metadata") {
              const existing = database.prepare(
                "SELECT snapshot FROM reference_metadata WHERE reference_id=?",
              ).get(row.reference_id);
              if (existing) continue;
            }
            insert(database, { table, row });
          }
          database.prepare("UPDATE import_runs SET next_record=? WHERE id=?").run(
            committed + batch.length,
            state.id,
          );
          database.exec("COMMIT");
          committed += batch.length;
          batch = [];
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        progress?.(committed, Number(state.total));
      };
      for (const entry of records(source)) {
        if (index++ < committed) continue;
        batch.push(validate(entry));
        if (batch.length === 250) {
          commit();
          await new Promise<void>((done) => setTimeout(done, 0));
        }
      }
      if (batch.length) commit();
      return committed;
    }
  } catch (error) {
    throw new Error(
      `Import retained ${committed} committed records. Resume from ${stagePath}. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    source?.close();
    database.close();
  }
}
