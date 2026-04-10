import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("desktopApi", {
  version: "1.0.0",
  apiBaseUrl: process.env.API_BASE_URL ?? "http://localhost:4000"
});
