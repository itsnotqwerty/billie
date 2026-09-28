import {
  type AppConfig,
  configPath,
  DEFAULT_AI_TIMEOUT_MS,
  defaultExportDir,
  expandHomePath,
  loadConfig,
  maskSecret,
  redactSecrets,
  saveAiApiKey,
  saveAiBaseUrl,
  saveAiModel,
  saveCongressApiKey,
  saveExportDir,
} from "./config.ts";
import { assertEquals } from "@std/assert";

function fakeEnv(values: Record<string, string>) {
  return { get: (name: string) => values[name] };
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    congressApiKey: null,
    aiProvider: null,
    aiApiKey: null,
    aiBaseUrl: "https://api.openai.com/v1",
    aiModel: "gpt-4o-mini",
    requestTimeoutMs: 10_000,
    aiTimeoutMs: 120_000,
    exportDir: "/tmp/exports",
    ...overrides,
  };
}

Deno.test("configPath uses XDG_CONFIG_HOME when set", () => {
  assertEquals(
    configPath(fakeEnv({ XDG_CONFIG_HOME: "/cfg", HOME: "/home/x" })),
    "/cfg/billie/config.json",
  );
});

Deno.test("configPath falls back to HOME/.config", () => {
  assertEquals(configPath(fakeEnv({ HOME: "/home/x" })), "/home/x/.config/billie/config.json");
});

Deno.test("defaultExportDir uses the Documents directory", () => {
  assertEquals(
    defaultExportDir(fakeEnv({ XDG_DATA_HOME: "/data", HOME: "/home/x" })),
    "/home/x/Documents",
  );
});

Deno.test("expandHomePath resolves a tilde-prefixed export directory", () => {
  const env = fakeEnv({ HOME: "/home/x" });
  assertEquals(expandHomePath("~/Documents/billie", env), "/home/x/Documents/billie");
  assertEquals(expandHomePath("/tmp/output", env), "/tmp/output");
});

Deno.test("loadConfig prefers environment variables over the config file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const env = fakeEnv({
      XDG_CONFIG_HOME: dir,
      HOME: "/nonexistent",
      BILLIE_CONGRESS_API_KEY: "env-key",
    });
    await saveCongressApiKey("file-key", env);
    const config = await loadConfig(env);
    assertEquals(config.congressApiKey, "env-key");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("saveCongressApiKey persists and reloads the key", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const env = fakeEnv({ XDG_CONFIG_HOME: dir, HOME: "/nonexistent" });
    await saveCongressApiKey("abc123", env);
    const config = await loadConfig(fakeEnv({ XDG_CONFIG_HOME: dir, HOME: "/nonexistent" }));
    assertEquals(config.congressApiKey, "abc123");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadConfig tolerates a missing config file", async () => {
  const config = await loadConfig(fakeEnv({ XDG_CONFIG_HOME: "/nonexistent-dir", HOME: "" }));
  assertEquals(config.congressApiKey, null);
  assertEquals(config.requestTimeoutMs, 10_000);
  assertEquals(config.aiTimeoutMs, DEFAULT_AI_TIMEOUT_MS);
});

Deno.test("redactSecrets masks configured keys only", () => {
  const config = baseConfig({ congressApiKey: "supersecret", aiApiKey: "ai-secret" });
  assertEquals(redactSecrets("key=supersecret auth=ai-secret", config), "key=*** auth=***");
  assertEquals(redactSecrets("nothing here", config), "nothing here");
  const empty = baseConfig();
  assertEquals(redactSecrets("key=supersecret", empty), "key=supersecret");
});

Deno.test("maskSecret reveals only the last four characters", () => {
  assertEquals(maskSecret(null), "(not set)");
  assertEquals(maskSecret("abcdef1234"), "…1234");
});

Deno.test("saveAiApiKey persists without requiring an environment variable", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const env = fakeEnv({ XDG_CONFIG_HOME: dir, HOME: "/nonexistent" });
    await saveAiApiKey("sk-abc123", env);
    const config = await loadConfig(fakeEnv({ XDG_CONFIG_HOME: dir, HOME: "/nonexistent" }));
    assertEquals(config.aiApiKey, "sk-abc123");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("saveAiModel and saveAiBaseUrl persist alongside other fields", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const env = fakeEnv({ XDG_CONFIG_HOME: dir, HOME: "/nonexistent" });
    await saveCongressApiKey("congress-key", env);
    await saveAiModel("gpt-test", env);
    await saveAiBaseUrl("https://example.test/v1", env);
    const config = await loadConfig(fakeEnv({ XDG_CONFIG_HOME: dir, HOME: "/nonexistent" }));
    assertEquals(config.congressApiKey, "congress-key");
    assertEquals(config.aiModel, "gpt-test");
    assertEquals(config.aiBaseUrl, "https://example.test/v1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("saveExportDir persists and reloads the export destination", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const env = fakeEnv({ XDG_CONFIG_HOME: dir, HOME: "/home/x" });
    await saveExportDir("/tmp/billie-output", env);
    const config = await loadConfig(env);
    assertEquals(config.exportDir, "/tmp/billie-output");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
