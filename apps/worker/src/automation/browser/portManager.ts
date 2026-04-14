import * as net from "node:net";

/**
 * Checks if a specific port is completely free and available to bind to.
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Sweeps ascending ports from the starting port to find a free bind location.
 */
export async function getAvailablePort(startPort: number = 9222, maxAttempts: number = 100): Promise<number> {
  let port = startPort;
  while (port < startPort + maxAttempts) {
    if (await isPortAvailable(port)) {
      return port;
    }
    port++;
  }
  throw new Error("Port unavailable: Could not find an open port in the given range.");
}

/**
 * Scans a range of ports to detect an explicitly active Chromium DevTools Protocol (CDP) WebSocket.
 */
export async function findActiveCDPPort(
  start: number = 9222,
  end: number = 9235,
  timeoutMs: number = 200
): Promise<number | null> {
  const checkPort = async (port: number): Promise<number | null> => {
    try {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: abortController.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        // A valid CDP target will define a webSocketDebuggerUrl
        if (data && data.webSocketDebuggerUrl) {
          return port;
        }
      }
    } catch (e) {
      // Expected if port is closed or isn't HTTP CDP
    }
    return null;
  };

  const tasks = [];
  for (let p = start; p <= end; p++) {
    tasks.push(checkPort(p));
  }

  // Await all checks. Return the first one that successfully returned a port number.
  const results = await Promise.all(tasks);
  const activePort = results.find(r => r !== null);
  return activePort || null;
}
