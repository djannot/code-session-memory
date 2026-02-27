/**
 * Web server for code-session-memory.
 *
 * Serves both the REST API and the built React SPA.
 * Launched via: npx code-session-memory web [--port <n>]
 */

import express from "express";
import path from "path";
import { createApiRouter } from "./api-routes";

export interface WebServerOptions {
  port: number;
  host: string;
}

export function startWebServer(options: WebServerOptions): void {
  const app = express();
  app.use(express.json());

  // API routes
  app.use("/api", createApiRouter());

  // Serve built frontend static files
  const staticDir = path.join(__dirname, "..", "..", "web-dist");
  app.use(express.static(staticDir));

  // SPA fallback: serve index.html for all non-API routes
  app.get("/{*splat}", (_req, res) => {
    const indexPath = path.join(staticDir, "index.html");
    res.sendFile(indexPath, (err) => {
      if (err) {
        res.status(404).send("Web UI not built. Run: npm run build:web");
      }
    });
  });

  app.listen(options.port, options.host, () => {
    console.log(`\ncode-session-memory web UI`);
    console.log(`  Local: http://${options.host === "0.0.0.0" ? "localhost" : options.host}:${options.port}`);
    console.log(`  Press Ctrl+C to stop\n`);
  });
}
