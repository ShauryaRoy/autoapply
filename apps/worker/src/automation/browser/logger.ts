/**
 * Simple structured logger for observability.
 */
export const logger = {
  info: (event: string, meta?: Record<string, any>) => {
    console.log(JSON.stringify({ level: "info", event, timestamp: Date.now(), ...meta }));
  },
  warn: (event: string, meta?: Record<string, any>) => {
    console.warn(JSON.stringify({ level: "warn", event, timestamp: Date.now(), ...meta }));
  },
  error: (event: string, meta?: Record<string, any>) => {
    console.error(JSON.stringify({ level: "error", event, timestamp: Date.now(), ...meta }));
  }
};
