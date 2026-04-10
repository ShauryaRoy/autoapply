import http from "node:http";
import { Server } from "socket.io";
import type { Socket } from "socket.io";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./db/prisma.js";
import { bootstrapTracing } from "./telemetry/tracing.js";
import { setSocketServer } from "./realtime/io.js";

async function bootstrap(): Promise<void> {
  await bootstrapTracing();

  const app = createApp();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: "*"
    }
  });
  setSocketServer(io);

  io.on("connection", (socket: Socket) => {
    socket.on("subscribe-application", (applicationId: string) => {
      socket.join(`application:${applicationId}`);
    });
  });

  server.listen(env.port, () => {
    console.log(`API listening on :${env.port}`);
  });
}

bootstrap().catch((error) => {
  console.error("Failed to bootstrap API", error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
