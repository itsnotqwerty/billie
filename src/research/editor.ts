import { basename, dirname, join, resolve } from "node:path";
import { researchPath } from "./store.ts";

export interface NoteEditor {
  check(): Promise<void>;
  edit(filePath: string): Promise<void>;
}

export class MicroEditor implements NoteEditor {
  async check(): Promise<void> {
    try {
      const result = await new Deno.Command("micro", {
        args: ["-version"],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).output();
      if (!result.success) throw new Error(`micro exited with code ${result.code}`);
    } catch (error) {
      throw new Error(
        `Cannot launch micro. Install micro and ensure it is on PATH and allowed by --allow-run=typst,micro. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async edit(filePath: string): Promise<void> {
    const configDirectory = join(dirname(filePath), "micro");
    await Deno.mkdir(configDirectory, { recursive: true, mode: 0o700 });
    const child = new Deno.Command("micro", {
      args: [
        "-config-dir",
        configDirectory,
        "-backup",
        "false",
        "-autosave",
        "0",
        "-saveundo",
        "false",
        "-savecursor",
        "false",
        "-filetype",
        "markdown",
        filePath,
      ],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const result = await child.status;
    if (!result.success) {
      throw new Error(`micro exited with code ${result.code}. Draft retained at ${filePath}`);
    }
  }
}

export interface NoteDraft {
  directory: string;
  filePath: string;
  notebookId: string;
  noteId: string | null;
  revision: number | null;
  title: string;
  createdAt: string;
  exportOnSave?: boolean;
}

export class NoteDrafts {
  readonly root: string;

  constructor(root = join(dirname(researchPath()), "drafts")) {
    this.root = resolve(root);
  }

  async create(
    input: {
      notebookId: string;
      noteId: string | null;
      revision: number | null;
      title: string;
      body: string;
      exportOnSave?: boolean;
    },
  ): Promise<NoteDraft> {
    await Deno.mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await Deno.lstat(this.root);
    if (!info.isDirectory || info.isSymlink) {
      throw new Error("Draft directory must not be a symlink.");
    }
    await Deno.chmod(this.root, 0o700);
    const directory = await Deno.makeTempDir({ dir: this.root, prefix: "note-" });
    await Deno.chmod(directory, 0o700);
    const draft: NoteDraft = {
      directory,
      filePath: join(directory, "note.md"),
      notebookId: input.notebookId,
      noteId: input.noteId,
      revision: input.revision,
      title: input.title,
      createdAt: new Date().toISOString(),
      ...(input.exportOnSave ? { exportOnSave: true } : {}),
    };
    try {
      await Deno.writeTextFile(draft.filePath, input.body, { createNew: true, mode: 0o600 });
      await this.writeMetadata(draft);
      return draft;
    } catch (error) {
      throw new Error(
        `Could not prepare note draft at ${directory}. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async read(draft: NoteDraft): Promise<string> {
    await this.validateDirectory(draft.directory);
    const info = await Deno.lstat(draft.filePath);
    if (draft.filePath !== join(draft.directory, "note.md") || !info.isFile || info.isSymlink) {
      throw new Error("Draft must be a regular Markdown file, not a symlink.");
    }
    await Deno.chmod(draft.filePath, 0o600);
    return await Deno.readTextFile(draft.filePath);
  }

  async rename(draft: NoteDraft, title: string): Promise<NoteDraft> {
    const updated = { ...draft, title };
    await this.validateDirectory(draft.directory);
    await this.writeMetadata(updated);
    return updated;
  }

  async discard(draft: NoteDraft): Promise<void> {
    await this.validateDirectory(draft.directory);
    await Deno.remove(draft.directory, { recursive: true });
  }

  async latest(notebookId: string): Promise<NoteDraft | null> {
    let latest: NoteDraft | null = null;
    try {
      for await (const entry of Deno.readDir(this.root)) {
        if (!entry.isDirectory || !entry.name.startsWith("note-")) continue;
        const directory = join(this.root, entry.name);
        try {
          await this.validateDirectory(directory);
          const metadataPath = join(directory, "draft.json");
          const info = await Deno.lstat(metadataPath);
          if (!info.isFile || info.isSymlink) continue;
          const metadata = JSON.parse(await Deno.readTextFile(metadataPath));
          if (
            metadata.notebookId !== notebookId || typeof metadata.title !== "string" ||
            typeof metadata.createdAt !== "string" ||
            !Number.isFinite(Date.parse(metadata.createdAt)) ||
            !(metadata.noteId === null && metadata.revision === null ||
              typeof metadata.noteId === "string" && Number.isSafeInteger(metadata.revision) &&
                metadata.revision > 0)
          ) continue;
          const draft: NoteDraft = {
            directory,
            filePath: join(directory, "note.md"),
            notebookId,
            noteId: metadata.noteId,
            revision: metadata.revision,
            title: metadata.title,
            createdAt: metadata.createdAt,
            ...(metadata.exportOnSave === true ? { exportOnSave: true } : {}),
          };
          if (!latest || draft.createdAt > latest.createdAt) latest = draft;
        } catch {
          continue;
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return latest;
  }

  private async validateDirectory(directory: string): Promise<void> {
    if (dirname(directory) !== this.root || !/^note-[\w-]+$/.test(basename(directory))) {
      throw new Error("Invalid draft directory.");
    }
    const info = await Deno.lstat(directory);
    if (!info.isDirectory || info.isSymlink) {
      throw new Error("Draft directory must not be a symlink.");
    }
  }

  private async writeMetadata(draft: NoteDraft): Promise<void> {
    const temporary = join(draft.directory, `${crypto.randomUUID()}.json`);
    await Deno.writeTextFile(
      temporary,
      JSON.stringify({
        notebookId: draft.notebookId,
        noteId: draft.noteId,
        revision: draft.revision,
        title: draft.title,
        createdAt: draft.createdAt,
        ...(draft.exportOnSave ? { exportOnSave: true } : {}),
      }),
      { createNew: true, mode: 0o600 },
    );
    await Deno.rename(temporary, join(draft.directory, "draft.json"));
  }
}
