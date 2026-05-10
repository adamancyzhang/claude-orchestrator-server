#!/usr/bin/env node

const https = require("https");
const fs = require("fs");
const path = require("path");

const BIN_DIR = path.resolve(__dirname, "..", "bin");
const BINARY_PATH = path.join(BIN_DIR, "orchestrator-binary");

if (fs.existsSync(BINARY_PATH)) {
  console.log("Binary already installed at", BINARY_PATH);
  process.exit(0);
}

const platform = process.platform; // "darwin", "linux"
const arch = process.arch === "arm64" ? "arm64" : "x64";
const binaryName = `claude-orchestrator-${platform}-${arch}`;

// Configurable via env var or package.json
const repo =
  process.env.ORCHESTRATOR_REPO || "adamancyzhang/ai-poc";
const version =
  process.env.ORCHESTRATOR_VERSION || "v0.1.0";

const url = `https://github.com/${repo}/releases/download/${version}/${binaryName}`;

console.log(`Downloading ${binaryName} from ${url}...`);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest, { mode: 0o755 });
    https
      .get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          file.close();
          fs.unlinkSync(dest);
          return download(response.headers.location, dest).then(resolve).catch(reject);
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          reject(
            new Error(
              `Download failed: HTTP ${response.statusCode} — ` +
                `no prebuilt binary for ${platform}-${arch}. ` +
                `Build it locally: bash scripts/build-binary.sh`
            )
          );
          return;
        }
        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", (err) => {
        file.close();
        try { fs.unlinkSync(dest); } catch (_) {}
        reject(
          new Error(
            `Download failed: ${err.message}. ` +
              `Build it locally: bash scripts/build-binary.sh`
          )
        );
      });
  });
}

download(url, BINARY_PATH)
  .then(() => {
    fs.chmodSync(BINARY_PATH, 0o755);
    console.log(`Installed ${binaryName} to ${BINARY_PATH}`);
  })
  .catch((err) => {
    console.error("Install error:", err.message);
    process.exit(1);
  });
