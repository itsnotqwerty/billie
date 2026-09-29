/** Billie entry point. */

import { loadConfig, redactSecrets } from "./config.ts";
import { App } from "./ui/app.ts";
import { sanitizeTerminalText } from "./ui/terminal.ts";

if (import.meta.main) {
  const config = await loadConfig();
  const app = new App(config);
  try {
    await app.run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(sanitizeTerminalText(redactSecrets(message, config)));
    Deno.exit(1);
  }
  Deno.exit(0);
}
