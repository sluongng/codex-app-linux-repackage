import { createWriteStream } from "node:fs";
import {
  access,
  chmod,
  constants,
  copyFile,
  mkdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { XMLParser } from "fast-xml-parser";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = resolve(__dirname, "..");
export const DEFAULT_APPCAST_URL =
  "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";

const FETCH_HEADERS = {
  "user-agent": "codex-app-linux-repacker/0.1",
};

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value == null) {
    return [];
  }
  return [value];
}

export function info(message) {
  console.log(`[info] ${message}`);
}

export function warn(message) {
  console.warn(`[warn] ${message}`);
}

export function fail(message) {
  throw new Error(message);
}

export async function pathExists(pathname) {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(pathname) {
  await mkdir(pathname, { recursive: true });
}

export async function removeIfExists(pathname) {
  await rm(pathname, { recursive: true, force: true });
}

export async function writeExecutable(pathname, contents) {
  await writeFile(pathname, contents, { mode: 0o755 });
}

export async function copyFileWithMode(source, destination) {
  const sourceStats = await stat(source);
  await ensureDir(dirname(destination));
  await copyFile(source, destination);
  await chmod(destination, sourceStats.mode);
}

export async function fetchText(url) {
  const response = await fetch(url, {
    headers: FETCH_HEADERS,
  });
  if (!response.ok) {
    fail(`Request failed for ${url}: ${response.status} ${response.statusText}`);
  }
  return await response.text();
}

export async function downloadFile(url, destination) {
  if (await pathExists(destination)) {
    return false;
  }

  await ensureDir(dirname(destination));
  const temporaryPath = `${destination}.tmp`;

  const response = await fetch(url, {
    headers: FETCH_HEADERS,
  });
  if (!response.ok || response.body == null) {
    fail(`Download failed for ${url}: ${response.status} ${response.statusText}`);
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath));
  await rename(temporaryPath, destination);
  return true;
}

export async function fetchReleaseIndex(appcastUrl = DEFAULT_APPCAST_URL) {
  const xml = await fetchText(appcastUrl);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const parsed = parser.parse(xml);
  const items = asArray(parsed?.rss?.channel?.item);
  if (items.length === 0) {
    fail(`No releases found in ${appcastUrl}`);
  }

  return items.map((item) => ({
    title: String(item.title),
    pubDate: String(item.pubDate),
    buildVersion: String(item["sparkle:version"]),
    shortVersion: String(item["sparkle:shortVersionString"] ?? item.title),
    enclosureUrl: String(item.enclosure?.["@_url"]),
    enclosureLength: Number(item.enclosure?.["@_length"] ?? 0),
    appcastUrl,
  }));
}

export function selectRelease(releases, version) {
  if (!version) {
    return releases[0];
  }

  const match = releases.find(
    (release) =>
      release.shortVersion === version ||
      release.title === version ||
      release.buildVersion === version,
  );
  if (!match) {
    fail(`Release ${version} was not found in the appcast feed.`);
  }
  return match;
}

export function mapNodeArchToElectronArch(nodeArch) {
  switch (nodeArch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    case "arm":
      return "armv7l";
    default:
      fail(`Unsupported Linux architecture: ${nodeArch}`);
  }
}

export async function run(command, args, options = {}) {
  await ensureDir(options.cwd ?? PROJECT_ROOT);

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? "inherit",
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(
        new Error(
          signal == null
            ? `${command} exited with status ${code}`
            : `${command} exited because of signal ${signal}`,
        ),
      );
    });
  });
}

export async function runCapture(command, args, options = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }

      rejectPromise(
        new Error(
          signal == null
            ? `${command} exited with status ${code}: ${stderr || stdout}`.trim()
            : `${command} exited because of signal ${signal}: ${stderr || stdout}`.trim(),
        ),
      );
    });
  });
}

export async function findExecutableOnPath(name) {
  const pathValue = process.env.PATH ?? "";
  for (const entry of pathValue.split(":")) {
    if (!entry) {
      continue;
    }
    const candidate = join(entry, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export async function requireBuildDependencies() {
  const required = ["npm", "unzip", "python3", "make", "g++"];
  const missing = [];
  for (const command of required) {
    if ((await findExecutableOnPath(command)) == null) {
      missing.push(command);
    }
  }
  if (missing.length > 0) {
    fail(`Missing build dependencies: ${missing.join(", ")}`);
  }
}
