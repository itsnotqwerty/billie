/** Billie entry point. */

import { loadConfig } from "./config.ts";
import { App } from "./ui/app.ts";

if (import.meta.main) {
  const config = await loadConfig();
  const app = new App(config);
  try {
    await app.run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
  Deno.exit(0);
}
