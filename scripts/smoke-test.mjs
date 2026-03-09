import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { PROJECT_ROOT, fail, pathExists } from "./shared.mjs";

function parseArgs(argv) {
  const options = {
    dir: null,
    timeoutMs: 10000,
    version: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--dir":
        options.dir = resolve(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(argv[index + 1] ?? "0");
        index += 1;
        break;
      case "--version":
        options.version = argv[index + 1] ?? null;
        index += 1;
        break;
      default:
        fail(`Unknown argument: ${argument}`);
    }
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    fail(`Invalid --timeout-ms value: ${options.timeoutMs}`);
  }

  return options;
}

async function resolveOutputDir(options) {
  if (options.dir != null) {
    return options.dir;
  }
  if (options.version != null) {
    return resolve(PROJECT_ROOT, "out", `codex-linux-${options.version}`);
  }

  const outDir = resolve(PROJECT_ROOT, "out");
  if (!(await pathExists(outDir))) {
    fail("No out/ directory found. Run npm run repackage first.");
  }

  const candidates = (await readdir(outDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("codex-linux-"))
    .map((entry) => resolve(outDir, entry.name))
    .sort();

  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length === 0) {
    fail("No codex-linux-* output directories found. Run npm run repackage first.");
  }

  fail("Multiple output directories found. Pass --dir or --version.");
}

async function assertExists(pathname, label) {
  if (!(await pathExists(pathname))) {
    fail(`Missing ${label}: ${pathname}`);
  }
}

async function assertElf(pathname) {
  const contents = await readFile(pathname);
  if (
    contents.length < 4 ||
    contents[0] !== 0x7f ||
    contents[1] !== 0x45 ||
    contents[2] !== 0x4c ||
    contents[3] !== 0x46
  ) {
    fail(`Expected an ELF binary at ${pathname}`);
  }
}

async function fetchOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForAllUrls(urls, timeoutMs, child) {
  for (const url of urls) {
    await waitForUrl(url, timeoutMs, child);
  }
}

async function waitForUrl(url, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      fail(`Packaged app exited before ${url} became reachable.`);
    }
    if (await fetchOnce(url)) {
      return;
    }
    await delay(200);
  }

  fail(`Timed out waiting for ${url}`);
}

async function waitForUrlToClose(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await fetchOnce(url))) {
      return;
    }
    await delay(200);
  }

  fail(`Timed out waiting for ${url} to stop responding.`);
}

async function waitForAllUrlsToClose(urls, timeoutMs) {
  for (const url of urls) {
    await waitForUrlToClose(url, timeoutMs);
  }
}

async function allocatePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port =
    address != null && typeof address === "object" && typeof address.port === "number"
      ? address.port
      : null;
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
  });

  if (port == null) {
    fail("Failed to allocate a temporary webview port.");
  }
  return port;
}

function collectOutput(child) {
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  return {
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Timed out waiting for pid ${child.pid} to exit.`));
    }, timeoutMs);

    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

async function terminateChild(child) {
  if (child.exitCode != null) {
    return await waitForExit(child, 1000).catch(() => ({
      code: child.exitCode,
      signal: child.signalCode,
    }));
  }

  child.kill("SIGTERM");
  try {
    return await waitForExit(child, 5000);
  } catch {
    child.kill("SIGKILL");
    return await waitForExit(child, 5000);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = await resolveOutputDir(options);

  const manifestPath = join(outputDir, "codex-linux-manifest.json");
  const startScriptPath = join(outputDir, "start.sh");
  const serveWebviewPath = join(outputDir, "serve-webview.mjs");
  const webviewDir = join(outputDir, "content", "webview");
  const webviewPort = await allocatePort();
  const rendererUrls = [
    `http://127.0.0.1:${webviewPort}/`,
    `http://localhost:${webviewPort}/`,
  ];
  const userDataDir = await mkdtemp(join(tmpdir(), "codex-smoke-profile-"));

  await assertExists(manifestPath, "manifest");
  await assertExists(startScriptPath, "launcher");
  await assertExists(serveWebviewPath, "webview server");
  await assertExists(webviewDir, "webview directory");

  const webviewEntries = await readdir(webviewDir);
  if (webviewEntries.length === 0) {
    fail(`Webview directory is empty: ${webviewDir}`);
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.renderer?.url !== "http://127.0.0.1:5175") {
    fail(`Unexpected renderer URL in manifest: ${manifest.renderer?.url ?? "missing"}`);
  }

  await assertElf(
    join(
      outputDir,
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    ),
  );
  await assertElf(
    join(
      outputDir,
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "node-pty",
      "build",
      "Release",
      "pty.node",
    ),
  );

  for (const rendererUrl of rendererUrls) {
    if (await fetchOnce(rendererUrl)) {
      fail(`${rendererUrl} is already responding before the smoke test starts.`);
    }
  }

  const child = spawn(startScriptPath, [`--user-data-dir=${userDataDir}`], {
    cwd: outputDir,
    env: {
      ...process.env,
      CODEX_APP_WEBVIEW_PORT: String(webviewPort),
      ELECTRON_ENABLE_LOGGING: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectOutput(child);

  try {
    await waitForAllUrls(rendererUrls, options.timeoutMs, child);
    const exit = await terminateChild(child);
    await waitForAllUrlsToClose(rendererUrls, 5000);
    await rm(userDataDir, { recursive: true, force: true });

    console.log(`Smoke test passed for ${outputDir}`);
    console.log(`Renderer URLs responded: ${rendererUrls.join(", ")}`);
    console.log(`Packaged app exit: code=${exit.code ?? "null"} signal=${exit.signal ?? "null"}`);
  } catch (error) {
    await terminateChild(child).catch(() => null);
    await rm(userDataDir, { recursive: true, force: true });
    const details = [output.stdout(), output.stderr()].filter(Boolean).join("\n");
    if (details) {
      console.error(details);
    }
    throw error;
  }
}

await main();
