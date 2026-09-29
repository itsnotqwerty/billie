/** Billie entry point. */

import { loadConfig, redactSecrets } from "./config.ts";
import { App } from "./ui/app.ts";
import { sanitizeTerminalText } from "./ui/terminal.ts";
import { ResearchStore } from "./research/store.ts";

if (import.meta.main) {
  const config = await loadConfig();
  let research: ResearchStore | undefined;
  let researchError: string | undefined;
  try {
    research = await ResearchStore.open();
  } catch (error) {
    researchError = error instanceof Error ? error.message : String(error);
  }
  const app = new App(config, { research, researchError });
  let exitCode = 0;
  try {
    await app.run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(sanitizeTerminalText(redactSecrets(message, config)));
    exitCode = 1;
  } finally {
    research?.close();
  }
  Deno.exit(exitCode);
}
