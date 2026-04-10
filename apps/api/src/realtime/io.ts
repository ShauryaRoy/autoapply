import type { Server } from "socket.io";

let io: Server | null = null;

export function setSocketServer(server: Server): void {
  io = server;
}

export function emitApplicationUpdate(
  applicationId: string,
  eventType: "step" | "event" | "status",
  payload: Record<string, unknown>
): void {
  if (!io) {
    return;
  }

  io.to(`application:${applicationId}`).emit("application:update", {
    applicationId,
    eventType,
    payload,
    timestamp: new Date().toISOString()
  });
}
