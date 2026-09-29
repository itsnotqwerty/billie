import fcntl
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import pty
import select
import sqlite3
import struct
import subprocess
import tempfile
import termios
import time
import threading


class Session:
    def __init__(self, binary, environment):
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        self.original = termios.tcgetattr(self.slave)
        def own_terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        self.process = subprocess.Popen(
            [str(binary)], stdin=self.slave, stdout=self.slave,
            stderr=self.slave, env=environment, preexec_fn=own_terminal,
        )
        self.output = bytearray()

    def expect(self, text):
        deadline = time.monotonic() + 15
        received = bytearray()
        while time.monotonic() < deadline:
            if select.select([self.master], [], [], max(0, deadline - time.monotonic()))[0]:
                chunk = os.read(self.master, 65536)
                received.extend(chunk)
                self.output.extend(chunk)
                if text.encode() in received:
                    return
        raise AssertionError(f"Missing {text!r}: {received.decode(errors='replace')[-3000:]}")

    def send(self, keys, expected):
        os.write(self.master, keys.encode())
        self.expect(expected)

    def finish(self):
        os.write(self.master, b"\x03")
        assert self.process.wait(timeout=10) == 0
        while select.select([self.master], [], [], 0)[0]:
            self.output.extend(os.read(self.master, 65536))
        assert termios.tcgetattr(self.slave) == self.original, "Terminal mode not restored"
        assert b"\x1b[?1049l" in self.output, "Alternate screen not restored"

    def close(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, 9)
            self.process.wait()
        os.close(self.master)
        os.close(self.slave)


def note_exports_smoke(binary, environment, database_path, directory):
    export_dir = Path(directory, "note-exports")
    session = Session(binary, dict(environment, BILLIE_EXPORT_DIR=str(export_dir)))
    try:
        session.expect("BILLIE")
        session.send("u", "Notebooks")
        session.send("\r", "Notebook: Micro research")
        session.send("n", "Notes")
        session.send("w", "File type: MARKDOWN")
        session.send("\x1b", "  Notes")
        assert not export_dir.exists()
        session.send("\r", "Note: Micro findings")
        session.send("w", "File type: MARKDOWN")
        for index, (kind, suffix) in enumerate((("MARKDOWN", "md"), ("XML", "xml"),
                                               ("JSON", "json"), ("CSV", "csv"),
                                               ("HTML", "html"), ("PDF", "pdf"))):
            if index:
                session.send("\x1b[C", f"File type: {kind}")
            session.send("e", "Wrote ")
            files = list(export_dir.glob(f"*.{suffix}"))
            assert len(files) == 1
            assert files[0].stat().st_mode & 0o777 == 0o600
            if kind == "PDF":
                assert files[0].read_bytes().startswith(b"%PDF-")
            elif kind == "JSON":
                payload = json.loads(files[0].read_text())
                assert payload["kind"] == "note"
                assert payload["unsavedDraft"] is False
                assert len(payload["citations"]) == 2
                assert payload["note"]["body"] == "# Recovered findings\nPreserved after restart\n"
            else:
                assert "Preserved after restart" in files[0].read_text()
        session.send("\x1b[D\x1b[D\x1b[D", "File type: JSON")
        session.send("\x1b[B\x1b[B\x1b[C", "Scope: current view")
        session.send("e", "Wrote ")
        payloads = [json.loads(item.read_text()) for item in export_dir.glob("*.json")]
        assert any(item["kind"] == "current-view" for item in payloads)
        changed_dir = Path(directory, "changed-exports")
        session.send("d", "Export directory")
        session.send("\x7f" * len(str(export_dir)) + str(changed_dir) + "\r", "Export directory saved")
        session.send("e", "Wrote ")
        assert len(list(changed_dir.glob("*.json"))) == 1
        blocked_dir = Path(directory, "blocked-export")
        blocked_dir.write_text("not a directory")
        session.send("d", "Export directory")
        session.send("\x7f" * len(str(changed_dir)) + str(blocked_dir) + "\r", "Export directory saved")
        session.send("e", "Export failed:")
        session.send("\x1b", "Note: Micro findings")
        with sqlite3.connect(database_path) as database:
            assert database.execute("SELECT revision FROM notes").fetchone()[0] == 4
            assert database.execute("SELECT count(*) FROM note_citations").fetchone()[0] == 2
        session.finish()
    finally:
        session.close()


def ai_notes_smoke(binary, environment, database_path, directory):
    prompts = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            prompts.append(payload["messages"][1]["content"])
            body = json.dumps({"choices": [{"message": {"content": "# AI questions\n\n- Who benefits?\n"}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    configured = dict(environment, BILLIE_AI_BASE_URL=f"http://127.0.0.1:{server.server_port}/v1",
                      BILLIE_AI_MODEL="fixture-model", BILLIE_EXPORT_DIR=f"{directory}/exports")
    session = Session(binary, configured)
    try:
        session.expect("BILLIE")
        session.send("u", "Notebooks")
        session.send("\r", "Notebook: Micro research")
        session.send("n", "Notes")
        session.send("a", "Generate AI note")
        session.send("Policy questions\r", "AI draft ready")
        session.send("W", "File type: MARKDOWN")
        session.send("\x1b[C\x1b[C", "File type: JSON")
        session.send("e", "Wrote ")
        draft_exports = list(Path(directory, "exports").glob("*.json"))
        assert len(draft_exports) == 1
        assert json.loads(draft_exports[0].read_text())["unsavedDraft"] is True
        session.send("\x1b", "Unsaved draft: Policy questions")
        with sqlite3.connect(database_path) as database:
            assert database.execute("SELECT count(*) FROM notes").fetchone()[0] == 1
        session.send("w", "Saved Policy questions")
        exports = list(Path(directory, "exports").glob("*.md"))
        assert len(exports) == 1
        assert "AI-generated draft" in exports[0].read_text()
        assert "# AI questions" in exports[0].read_text()
        assert exports[0].stat().st_mode & 0o777 == 0o600
        session.send("a", "Generate AI note")
        session.send("Edited policy questions\r", "AI draft ready")
        session.send("e", "note.md")
        session.send("\x01# Human revised note\rChecked by me\r\x13\x11", "Unsaved draft: Edited policy questions")
        session.send("w", "Saved Edited policy questions")
        exports = list(Path(directory, "exports").glob("*.md"))
        assert len(exports) == 2
        assert any(item.read_text() == "# Human revised note\nChecked by me\n" for item in exports)
        with sqlite3.connect(database_path) as database:
            assert database.execute("SELECT count(*) FROM notes").fetchone()[0] == 3
            assert database.execute("SELECT body FROM notes WHERE title = 'Edited policy questions'").fetchone()[0] == "# Human revised note\nChecked by me\n"
        assert prompts == ["Policy questions", "Edited policy questions"]
        session.finish()
    finally:
        session.close()
        server.shutdown()
        server.server_close()
        worker.join()


def notebook_archive_smoke(binary, environment, database_path, directory):
    export_dir = Path(directory, "archives")
    session = Session(binary, dict(environment, BILLIE_EXPORT_DIR=str(export_dir)))
    try:
        session.expect("BILLIE")
        session.send("u", "Notebooks")
        session.send("\r", "Notebook: Micro research")
        session.send("w", "Research archive")
        session.send("j", "Destination directory")
        session.send("\r", "Exported ")
        archive = next(export_dir.glob("*.json"))
        data = json.loads(archive.read_text())
        assert data["version"] == 1
        assert len([item for item in data["records"] if item["table"] == "notes"]) == 3
        session.send("w", "Research archive")
        session.send("m", "Destination directory")
        session.send("\r", "Exported ")
        markdown = next(export_dir.glob("*.md")).read_text()
        assert "Reference index" in markdown and "AI-generated draft" in markdown
        session.send("w", "Research archive")
        session.send("i", "Edit import")
        session.send(str(archive) + "\r", "Import research?")
        session.send("n", "Research archive")
        session.send("i", "Edit import")
        session.send(str(archive) + "\r", "Import research?")
        session.send("y", "Imported ")
        with sqlite3.connect(database_path) as database:
            assert database.execute("SELECT count(*) FROM notebooks").fetchone()[0] == 2
            assert database.execute("SELECT count(*) FROM notes").fetchone()[0] == 6
            assert database.execute("SELECT count(*) FROM legislation_references").fetchone()[0] == 3
            assert database.execute("SELECT count(*) FROM note_citations").fetchone()[0] == 4
            assert database.execute("PRAGMA foreign_key_check").fetchall() == []
        session.finish()
    finally:
        session.close()


def migration_backup_smoke(binary, environment, database_path):
    writer = sqlite3.connect(database_path)
    session = None
    try:
        writer.executescript("""
            PRAGMA journal_mode = WAL;
            PRAGMA wal_autocheckpoint = 0;
            DROP TABLE import_mappings;
            DROP TABLE import_runs;
            DROP TABLE reference_metadata;
            PRAGMA user_version = 3;
            UPDATE notebooks SET description = 'Committed WAL metadata';
        """)
        assert Path(database_path + "-wal").stat().st_size > 0
        session = Session(binary, environment)
        session.expect("BILLIE")
        session.send("u", "Notebooks")
        session.send("\r", "Notebook: Micro research")
        session.send("n", "Notes")
        session.finish()
        backups = list(Path(database_path).parent.glob("research.sqlite3.v3-*.bak"))
        assert len(backups) == 1
        assert backups[0].stat().st_mode & 0o777 == 0o600
        for candidate, version in ((database_path, 4), (backups[0], 3)):
            with sqlite3.connect(candidate) as database:
                assert database.execute("PRAGMA user_version").fetchone()[0] == version
                assert database.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                assert database.execute("PRAGMA foreign_key_check").fetchall() == []
                assert database.execute("SELECT description FROM notebooks").fetchone()[0] == "Committed WAL metadata"
                assert database.execute("SELECT body FROM notes").fetchone()[0] == "# Final findings\nLine one\nLine two\n"
                assert database.execute("SELECT count(*) FROM note_citations").fetchone()[0] == 3
    finally:
        if session is not None:
            session.close()
        writer.close()


def main():
    binary = Path(os.environ.get("BILLIE_TEST_BINARY", "dist/billie")).resolve()
    with tempfile.TemporaryDirectory(prefix="billie-micro-") as directory:
        environment = {
            key: value for key, value in os.environ.items()
            if not key.startswith(("BILLIE_", "CONGRESS_", "OPENAI_", "AI_"))
        }
        environment.update(
            HOME=directory, XDG_DATA_HOME=f"{directory}/data",
            XDG_CONFIG_HOME=f"{directory}/config", TERM="xterm-256color",
        )
        database_path = f"{directory}/data/billie/research.sqlite3"
        first = Session(binary, environment)
        try:
            first.expect("BILLIE")
            first.send("u", "Notebooks")
            first.send("n", "New notebook")
            first.send("n", "Edit title")
            first.send("Micro research\r", "Title: Micro research")
            first.send("w", "Notebook: Micro research")
            first.send("s", "Search legislation to add")
            first.send("health\r", "No Congress.gov API key configured")
            first.send("\x1b", "Notebook: Micro research")
            for reference in ("119 hr1", "118 s2", "119 hres3"):
                first.send("a", "Edit reference")
                first.send(reference + "\r", "Added 1; already present 0")
            first.send("n", "Notes")
            first.send("e", "Note title")
            first.send("Micro findings\r", "note.md")
            first.send("# Micro draft\rqqddw belong to the note\r\x13\x11", "Unsaved draft: Micro findings")
            with sqlite3.connect(database_path) as database:
                assert database.execute("SELECT count(*) FROM notes").fetchone()[0] == 0
            first.send("e", "note.md")
            first.send("\x01# Final findings\rLine one\rLine two\r\x13\x11", "Unsaved draft: Micro findings")
            first.send("c", "note.md")
            first.send("\x11", "Unsaved draft: Micro findings")
            first.send("w", "Saved Micro findings")
            with sqlite3.connect(database_path) as database:
                body = database.execute("SELECT body FROM notes").fetchone()[0]
                assert body == "# Final findings\nLine one\nLine two\n", repr(body)
            first.send("c", "Citations: Micro findings")
            first.send("s", "Search legislation to cite")
            first.send("health\r", "No Congress.gov API key configured")
            first.send("\x1b", "Citations: Micro findings")
            first.send("a", "Add citations: Micro findings")
            for count in range(1, 4):
                first.send(" ", f"({count} selected)")
                if count < 3:
                    first.send("j", "Add citations: Micro findings")
            with sqlite3.connect(database_path) as database:
                assert database.execute("SELECT count(*) FROM note_citations").fetchone()[0] == 0
            first.send("\r", "(3 cited)")
            first.send("\x1b", "Citations: Micro findings")
            first.send("x", "Remove citation to")
            first.send("n", "Citations: Micro findings")
            first.send("\x1b", "  Notes")
            first.send("e", "note.md")
            first.send("\x01Discard this text\r\x13\x11", "Unsaved draft: Micro findings")
            first.send("d", "Discard this draft")
            first.send("n", "Unsaved draft: Micro findings")
            first.send("d", "Discard this draft")
            first.send("y", "Draft discarded")
            first.send("e", "note.md")
            first.send("\x01# Recovered findings\rPreserved after restart\r\x13\x11", "Unsaved draft: Micro findings")
            first.finish()
        finally:
            first.close()

        migration_backup_smoke(binary, environment, database_path)

        recovery_files = list(Path(directory, "data/billie/drafts").glob("note-*/note.md"))
        assert len(recovery_files) == 1
        assert recovery_files[0].stat().st_mode & 0o777 == 0o600
        assert recovery_files[0].parent.stat().st_mode & 0o777 == 0o700
        second = Session(binary, environment)
        try:
            second.expect("BILLIE")
            second.send("u", "Notebooks")
            second.send("\r", "Notebook: Micro research")
            second.send("n", "Notes")
            second.send("R", "Recovered draft")
            second.send("w", "Saved Micro findings")
            second.send("c", "(3 cited)")
            second.send("x", "Remove citation to")
            second.send("y", "Citation removed")
            second.send("\x1b", "  Notes")
            second.finish()
        finally:
            second.close()
        with sqlite3.connect(database_path) as database:
            title, body, revision = database.execute("SELECT title, body, revision FROM notes").fetchone()
            assert title == "Micro findings"
            assert body == "# Recovered findings\nPreserved after restart\n", repr(body)
            assert revision == 4
            assert database.execute("SELECT count(*) FROM note_citations").fetchone()[0] == 2
            assert database.execute("SELECT count(*) FROM notebook_references").fetchone()[0] == 3
            assert database.execute("PRAGMA foreign_key_check").fetchall() == []
        assert not list(Path(directory, "data/billie/drafts").glob("note-*"))
        note_exports_smoke(binary, environment, database_path, directory)
        ai_notes_smoke(binary, environment, database_path, directory)
        notebook_archive_smoke(binary, environment, database_path, directory)
        print("PASS: real micro editing, compiled v3 migration/WAL backup, six note export formats, notebook JSON/Markdown export/import, AI drafts, recovery, citations, persistence, and terminal restoration")


if __name__ == "__main__":
    main()