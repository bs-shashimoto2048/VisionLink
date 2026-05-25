import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import selfsigned from "selfsigned";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const certDir = path.join(rootDir, "certs");
const keyPath = path.join(certDir, "localhost-key.pem");
const certPath = path.join(certDir, "localhost.pem");

function getLanIps() {
  const interfaces = os.networkInterfaces();
  const ips = new Set(["localhost", "127.0.0.1"]);
  for (const details of Object.values(interfaces)) {
    for (const detail of details ?? []) {
      if (detail.family === "IPv4" && !detail.internal) {
        ips.add(detail.address);
      }
    }
  }
  return [...ips];
}

function ensureCerts() {
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return;
  }
  fs.mkdirSync(certDir, { recursive: true });
  const alt = getLanIps();
  const pems = selfsigned.generate(
    [{ name: "commonName", value: "VisionLink Local Dev" }],
    {
      days: 365,
      keySize: 2048,
      algorithm: "sha256",
      extensions: [
        {
          name: "subjectAltName",
          altNames: alt.map((value) =>
            /^\d{1,3}(\.\d{1,3}){3}$/.test(value) ? { type: 7, ip: value } : { type: 2, value }
          ),
        },
      ],
    }
  );
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  console.log(`Generated HTTPS certificate for: ${alt.join(", ")}`);
}

ensureCerts();

