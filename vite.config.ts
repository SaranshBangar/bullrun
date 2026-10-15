import { defineConfig, type Plugin } from "vite";

// In production `api/stock.ts` runs as a Vercel Function. Under `vite dev` this
// middleware runs the same handler, so the SPA and API share one origin locally.
const devApi = (): Plugin => ({
  name: "bullrun-dev-api",
  configureServer(server) {
    server.middlewares.use("/api/stock", async (req, res) => {
      try {
        const mod = await server.ssrLoadModule("/api/stock.ts");
        const r: Response = await mod.default.fetch(new Request("http://localhost" + req.originalUrl));
        res.statusCode = r.status;
        r.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(await r.text());
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  },
});

export default defineConfig({ plugins: [devApi()] });
