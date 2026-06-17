import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// The cloudflare plugin runs worker/index.ts alongside the SPA in `vite dev`,
// so the API and frontend share one origin with no proxy config.
export default defineConfig({
  plugins: [cloudflare()],
});
