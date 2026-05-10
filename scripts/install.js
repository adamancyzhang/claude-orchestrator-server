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

const repo =
  process.env.ORCHESTRATOR_REPO || "adamancyzhang/claude-orchestrator-server";
const version =
  process.env.ORCHESTRATOR_VERSION || "v0.1.0";

// ── Helpers ──

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "claude-orchestrator-installer" } }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest, { mode: 0o755 });
    https
      .get(
        url,
        { headers: { Accept: "application/octet-stream", "User-Agent": "claude-orchestrator-installer" } },
        (response) => {
          if (response.statusCode === 302 || response.statusCode === 301) {
            file.close();
            fs.unlinkSync(dest);
            return download(response.headers.location, dest).then(resolve).catch(reject);
          }
          if (response.statusCode !== 200) {
            file.close();
            fs.unlinkSync(dest);
            reject(new Error(`Download failed: HTTP ${response.statusCode}`));
            return;
          }
          response.pipe(file);
          file.on("finish", () => {
            file.close();
            resolve();
          });
        }
      )
      .on("error", (err) => {
        file.close();
        try { fs.unlinkSync(dest); } catch (_) {}
        reject(err);
      });
  });
}

// ── Main ──

async function install() {
  // Step 1: Get asset download URL from GitHub Releases API
  const apiUrl = `https://api.github.com/repos/${repo}/releases/tags/${version}`;
  console.log(`Resolving ${binaryName} via ${apiUrl}...`);

  let release;
  try {
    release = await httpGetJSON(apiUrl);
  } catch (e) {
    console.error(`Failed to fetch release info: ${e.message}`);
    console.error(`Build it locally: bash scripts/build-binary.sh`);
    process.exit(1);
  }

  const asset = (release.assets || []).find((a) => a.name === binaryName);
  if (!asset) {
    console.error(
      `No prebuilt binary for ${platform}-${arch}. ` +
        `Available assets: ${(release.assets || []).map((a) => a.name).join(", ") || "none"}. ` +
        `Build it locally: bash scripts/build-binary.sh`
    );
    process.exit(1);
  }

  console.log(`Found ${binaryName} (${(asset.size / 1024 / 1024).toFixed(1)} MB), downloading...`);

  // Step 2: Download via asset API URL (requires Accept header)
  try {
    await download(asset.url, BINARY_PATH);
  } catch (e) {
    console.error(`Download failed: ${e.message}`);
    console.error(`Build it locally: bash scripts/build-binary.sh`);
    process.exit(1);
  }

  fs.chmodSync(BINARY_PATH, 0o755);
  console.log(`Installed ${binaryName} to ${BINARY_PATH}`);
}

install();
