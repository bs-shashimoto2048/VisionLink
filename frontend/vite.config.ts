import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function readHttpsOptions() {
  const certDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "certs");
  const keyPath = path.join(certDir, "localhost-key.pem");
  const certPath = path.join(certDir, "localhost.pem");
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
  }
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    https: readHttpsOptions(),
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true
      }
    }
  }
});
