/** Configuration loading, persistence, and secret redaction. */

export interface EnvReader {
  get(name: string): string | undefined;
}

export interface AppConfig {
  congressApiKey: string | null;
  aiProvider: string | null;
  aiApiKey: string | null;
  aiBaseUrl: string;
  aiModel: string;
  requestTimeoutMs: number;
  aiTimeoutMs: number;
  exportDir: string;
}

interface FileConfig {
  congressApiKey?: string;
  aiProvider?: string;
  aiApiKey?: string;
  aiBaseUrl?: string;
  aiModel?: string;
  exportDir?: string;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_AI_TIMEOUT_MS = 120_000;
export const DEFAULT_AI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_AI_MODEL = "gpt-4o-mini";

export function isLocalAiEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : ".";
}

export function configPath(env: EnvReader): string {
  const base = env.get("XDG_CONFIG_HOME") ?? `${env.get("HOME") ?? "."}/.config`;
  return `${base}/billie/config.json`;
}

export function defaultExportDir(env: EnvReader): string {
  return `${env.get("HOME") ?? "."}/Documents`;
}

export function expandHomePath(path: string, env: EnvReader = Deno.env): string {
  if (path === "~") return env.get("HOME") ?? ".";
  if (path.startsWith("~/")) return `${env.get("HOME") ?? "."}/${path.slice(2)}`;
  return path;
}

async function readFileConfig(path: string): Promise<FileConfig> {
  try {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(path));
    if (parsed !== null && typeof parsed === "object") return parsed as FileConfig;
  } catch {
    // Missing or invalid config file: start from an empty file config.
  }
  return {};
}
/** Load configuration. Environment variables take precedence over the config file. */
export async function loadConfig(env: EnvReader = Deno.env): Promise<AppConfig> {
  const file = await readFileConfig(configPath(env));
  return {
    congressApiKey: env.get("BILLIE_CONGRESS_API_KEY") ?? env.get("CONGRESS_API_KEY") ??
      file.congressApiKey ?? null,
    aiProvider: env.get("BILLIE_AI_PROVIDER") ?? file.aiProvider ?? null,
    aiApiKey: env.get("BILLIE_AI_API_KEY") ?? file.aiApiKey ?? null,
    aiBaseUrl: env.get("BILLIE_AI_BASE_URL") ?? file.aiBaseUrl ?? DEFAULT_AI_BASE_URL,
    aiModel: env.get("BILLIE_AI_MODEL") ?? file.aiModel ?? DEFAULT_AI_MODEL,
    requestTimeoutMs: DEFAULT_TIMEOUT_MS,
    aiTimeoutMs: DEFAULT_AI_TIMEOUT_MS,
    exportDir: env.get("BILLIE_EXPORT_DIR") ?? file.exportDir ?? defaultExportDir(env),
  };
}

/** Persist the Congress.gov API key, preserving other settings. Returns the path written. */
export async function saveCongressApiKey(key: string, env: EnvReader = Deno.env): Promise<string> {
  const path = configPath(env);
  const existing = await readFileConfig(path);
  existing.congressApiKey = key;
  await Deno.mkdir(parentDir(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 });
  return path;
}
/** Replace any configured secrets in diagnostic text with a mask. */
export function redactSecrets(text: string, config: AppConfig): string {
  let out = text;
  const secrets = [config.congressApiKey, config.aiApiKey]
    .filter((secret): secret is string => Boolean(secret))
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    out = out.split(secret).join("***");
  }
  return out;
}

/** Display-safe rendering of a secret: last four characters only. */
export function maskSecret(secret: string | null): string {
  if (!secret) return "(not set)";
  if (secret.length <= 4) return "***";
  return `…${secret.slice(-4)}`;
}

async function updateFileConfig(
  env: EnvReader,
  mutate: (existing: FileConfig) => void,
): Promise<string> {
  const path = configPath(env);
  const existing = await readFileConfig(path);
  mutate(existing);
  await Deno.mkdir(parentDir(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 });
  return path;
}

export function saveAiApiKey(key: string, env: EnvReader = Deno.env): Promise<string> {
  return updateFileConfig(env, (existing) => {
    existing.aiApiKey = key;
  });
}

export function saveAiModel(model: string, env: EnvReader = Deno.env): Promise<string> {
  return updateFileConfig(env, (existing) => {
    existing.aiModel = model;
  });
}

export function saveAiBaseUrl(url: string, env: EnvReader = Deno.env): Promise<string> {
  return updateFileConfig(env, (existing) => {
    existing.aiBaseUrl = url;
  });
}

export function saveExportDir(dir: string, env: EnvReader = Deno.env): Promise<string> {
  return updateFileConfig(env, (existing) => {
    existing.exportDir = dir;
  });
}
