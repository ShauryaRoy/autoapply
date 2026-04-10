import express from "express";
import cors from "cors";
import pino from "pino";
import path from "node:path";
import fs from "node:fs";
import { createApplicationRouter } from "./routes/applications.js";
import { createAuthRouter } from "./routes/auth.js";
import { authRequired } from "./auth/jwt.js";
import { createDlqRouter } from "./routes/dlq.js";
import { createInternalWorkerRouter } from "./routes/internalWorker.js";

// Screenshots are written here by the worker process
const PREVIEWS_ROOT = path.resolve(
  process.env.WORKER_RUNTIME_PATH ?? path.join(process.cwd(), "..", "worker", "runtime"),
  "automation-previews"
);

const logger = pino();

export function createApp(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      logger.info(
        {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: Date.now() - start
        },
        "request"
      );
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/auth", createAuthRouter());
  app.use("/api/internal/worker", createInternalWorkerRouter());
  app.use("/api/applications", authRequired, createApplicationRouter());
  app.use("/api/dlq", authRequired, createDlqRouter());

  // Serve worker screenshots so the Electron renderer can display them via HTTP
  // The worker stores screenshots in runtime/automation-previews/<appId>/<file>.png
  app.use("/api/previews", cors(), express.static(PREVIEWS_ROOT, {
    maxAge: 0,
    etag: false,
    setHeaders: (res) => { res.set("Cache-Control", "no-cache, no-store"); }
  }));

  // /api/previews/:appId/latest — returns the most recent screenshot URL
  app.get("/api/previews/:appId/latest", (req, res) => {
    const dir = path.join(PREVIEWS_ROOT, req.params.appId);
    try {
      if (!fs.existsSync(dir)) { res.status(404).json({ url: null }); return; }
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith(".png"))
        .sort() // filenames start with timestamps so sort = chronological
        .reverse();
      if (files.length === 0) { res.status(404).json({ url: null }); return; }
      const apiBase = process.env.API_BASE_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`;
      res.json({ url: `${apiBase}/api/previews/${req.params.appId}/${files[0]}` });
    } catch {
      res.status(500).json({ url: null });
    }
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ message: err.message || "Internal server error" });
  });

  return app;
}
