import { cp, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import plist from "plist";
import * as asar from "@electron/asar";
import {
  DEFAULT_APPCAST_URL,
  PROJECT_ROOT,
  copyFileWithMode,
  downloadFile,
  ensureDir,
  fail,
  fetchReleaseIndex,
  findExecutableOnPath,
  info,
  mapNodeArchToElectronArch,
  pathExists,
  removeIfExists,
  requireBuildDependencies,
  run,
  selectRelease,
  warn,
  writeExecutable,
} from "./shared.mjs";

function parseArgs(argv) {
  const options = {
    appcastUrl: DEFAULT_APPCAST_URL,
    cacheDir: resolve(PROJECT_ROOT, ".cache"),
    force: false,
    keepWorkDir: false,
    outputDir: null,
    sourceZip: null,
    version: null,
    workDir: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--version":
        options.version = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--zip":
        options.sourceZip = resolve(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--output-dir":
        options.outputDir = resolve(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--cache-dir":
        options.cacheDir = resolve(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--work-dir":
        options.workDir = resolve(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--appcast-url":
        options.appcastUrl = argv[index + 1] ?? DEFAULT_APPCAST_URL;
        index += 1;
        break;
      case "--force":
        options.force = true;
        break;
      case "--keep-work-dir":
        options.keepWorkDir = true;
        break;
      default:
        fail(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

const AVATAR_OVERLAY_MOUSE_PASSTHROUGH_CALL =
  "e.setIgnoreMouseEvents(!0,{forward:!0});return";
const AVATAR_OVERLAY_MOUSE_INTERACTIVE_CALL =
  "e.setIgnoreMouseEvents(!1);return;;;;;;;;;;;;;";
const AVATAR_OVERLAY_DRAG_METHODS_START_MARKERS = [
  "startDrag(e,t,n=!1){",
  "startDrag(e,{pointerWindowX:t,pointerWindowY:r})",
  "startDrag(e,{pointerWindowX:t,pointerWindowY:n})",
];
const AVATAR_OVERLAY_DRAG_METHODS_END_MARKERS = [
  "setCompositionState(e,t){",
  "async ensureWindow(e){",
  "async ensureWindow(){",
];
const AVATAR_OVERLAY_LINUX_INTERACTION_METHODS = [
  "startDrag(e,t,n=!1){}",
  "moveDrag(e,t){}",
  "endDrag(e,t){}",
  "throwWithVelocity(e,t,n,r=!1){}",
  "startMascotResize(e,t){}",
  "moveMascotResize(e,t){}",
  "endMascotResize(e,t){}",
  "setElementSize(e,{mascot:t,tray:n}){let r=this.window;r==null||r.isDestroyed()||r.webContents.id!==e||(this.cancelMomentum(),this.anchor={...this.anchor,x:r.getBounds().x+(this.layout?.mascot.left??0),y:r.getBounds().y+(this.layout?.mascot.top??0),width:t.width,height:t.height},this.mascotSize=t,this.traySize=n,this.applyLayout(r))}",
].join("");
const AVATAR_OVERLAY_OPEN_MAIN_WINDOW_CALL =
  "r&&i.startedOnMascot&&!i.hasMoved&&f.dispatchMessage(`open-current-main-window`,{})";
const AVATAR_OVERLAY_DISABLED_OPEN_MAIN_WINDOW_CALL =
  "r&&i.startedOnMascot&&!i.hasMoved&&false&&f.dispatchMessage(`open-current-main-window`,{})";
const AVATAR_OVERLAY_OPEN_MAIN_WINDOW_DISPATCH =
  "dispatchMessage(`open-current-main-window`,";
const WORK_LOUDER_NODE_HID_MODULE =
  "node_modules/@worklouder/device-kit-oai/node_modules/@worklouder/wl-device-kit/node_modules/node-hid";

function relativeParts(moduleId) {
  return moduleId.split("/").filter(Boolean);
}

async function collectDirectReleaseArtifacts(moduleRoot) {
  const artifacts = [];
  const releaseDir = join(moduleRoot, "build", "Release");
  if (await pathExists(releaseDir)) {
    for (const entry of await readdir(releaseDir, { withFileTypes: true })) {
      if (entry.isFile()) {
        artifacts.push(join("build", "Release", entry.name));
      }
    }
  }

  const prebuildsDir = join(moduleRoot, "prebuilds");
  if (await pathExists(prebuildsDir)) {
    for (const platformDir of await readdir(prebuildsDir, { withFileTypes: true })) {
      if (!platformDir.isDirectory()) {
        continue;
      }
      const platformPath = join(prebuildsDir, platformDir.name);
      for (const entry of await readdir(platformPath, { withFileTypes: true })) {
        if (entry.isFile()) {
          artifacts.push(join("prebuilds", platformDir.name, entry.name));
        }
      }
    }
  }

  return artifacts.sort();
}

async function collectNativeModuleCandidates(nodeModulesDir) {
  const candidates = [];

  async function maybeAddModule(moduleId, moduleRoot) {
    const releaseArtifacts = await collectDirectReleaseArtifacts(moduleRoot);
    if (releaseArtifacts.length > 0) {
      candidates.push({
        moduleId,
        moduleRoot,
        releaseArtifacts,
      });
    }
  }

  for (const entry of await readdir(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.name.startsWith("@")) {
      const scopeRoot = join(nodeModulesDir, entry.name);
      for (const scopedEntry of await readdir(scopeRoot, { withFileTypes: true })) {
        if (!scopedEntry.isDirectory()) {
          continue;
        }
        await maybeAddModule(
          `${entry.name}/${scopedEntry.name}`,
          join(scopeRoot, scopedEntry.name),
        );
      }
      continue;
    }

    await maybeAddModule(entry.name, join(nodeModulesDir, entry.name));
  }

  return candidates.sort((left, right) => left.moduleId.localeCompare(right.moduleId));
}

function readJsonFromAsar(archivePath, filePath) {
  return JSON.parse(asar.extractFile(archivePath, filePath).toString("utf8"));
}

function readJsonFromAsarOrNull(archivePath, filePath) {
  try {
    return readJsonFromAsar(archivePath, filePath);
  } catch (error) {
    if (String(error?.message ?? "").includes("was not found in this archive")) {
      return null;
    }
    throw error;
  }
}

function normalizeExactPackageVersion(version, packageName) {
  if (typeof version !== "string") {
    return null;
  }

  const match = version.match(/^(?:npm:[^@]+@)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
  if (match == null) {
    fail(
      `Expected ${packageName} to be pinned to an exact version, but found ${JSON.stringify(
        version,
      )}.`,
    );
  }

  return match[1];
}

async function readLegacyElectronFrameworkInfo(appContentsDir) {
  const plistPath = join(
    appContentsDir,
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Resources",
    "Info.plist",
  );
  if (!(await pathExists(plistPath))) {
    return null;
  }

  return plist.parse(await readFile(plistPath, "utf8"));
}

async function resolveElectronVersion(appContentsDir, packageJson) {
  const packageVersion = normalizeExactPackageVersion(
    packageJson.devDependencies?.electron ?? packageJson.dependencies?.electron,
    "electron",
  );
  if (packageVersion != null) {
    return packageVersion;
  }

  const frameworkInfo = await readLegacyElectronFrameworkInfo(appContentsDir);
  if (frameworkInfo == null) {
    fail(
      "Could not determine Electron version from package.json or legacy Electron Framework Info.plist.",
    );
  }

  return String(frameworkInfo.CFBundleShortVersionString ?? frameworkInfo.CFBundleVersion);
}

function npmPlatformFieldAllows(field, currentValue) {
  if (!Array.isArray(field) || field.length === 0) {
    return true;
  }

  const values = field.map((value) => String(value));
  if (values.includes(`!${currentValue}`)) {
    return false;
  }

  const allowedValues = values.filter((value) => !value.startsWith("!"));
  return allowedValues.length === 0 || allowedValues.includes(currentValue);
}

function packageSupportsCurrentPlatform(packageJson) {
  return (
    npmPlatformFieldAllows(packageJson.os, process.platform) &&
    npmPlatformFieldAllows(packageJson.cpu, process.arch)
  );
}

async function discoverNativeModules(appAsarPath, unpackedDir) {
  const nodeModulesDir = join(unpackedDir, "node_modules");
  if (!(await pathExists(nodeModulesDir))) {
    return {
      nativeModules: [],
      skippedNativeModules: [],
    };
  }

  const modules = [];
  const skippedModules = [];
  for (const candidate of await collectNativeModuleCandidates(nodeModulesDir)) {
    const packageJsonPath = `node_modules/${candidate.moduleId}/package.json`;
    const packageJson = readJsonFromAsarOrNull(appAsarPath, packageJsonPath);
    if (packageJson == null) {
      skippedModules.push({
        moduleId: candidate.moduleId,
        version: "unknown",
        releaseArtifacts: candidate.releaseArtifacts,
        missingPackageJson: packageJsonPath,
      });
      continue;
    }
    const moduleInfo = {
      moduleId: candidate.moduleId,
      version: String(packageJson.version),
      releaseArtifacts: candidate.releaseArtifacts,
    };
    if (!packageSupportsCurrentPlatform(packageJson)) {
      skippedModules.push({
        ...moduleInfo,
        cpu: packageJson.cpu ?? null,
        os: packageJson.os ?? null,
      });
      continue;
    }
    modules.push(moduleInfo);
  }

  return {
    nativeModules: modules,
    skippedNativeModules: skippedModules,
  };
}

function buildCodexWrapper() {
  return `#!/usr/bin/env bash
set -euo pipefail

if [[ -n "\${CODEX_APP_SYSTEM_CODEX:-}" ]]; then
  exec "\${CODEX_APP_SYSTEM_CODEX}" "$@"
fi

if command -v codex >/dev/null 2>&1; then
  target="$(command -v codex)"
  if [[ "$(realpath "$target")" != "$(realpath "$0")" ]]; then
    exec "$target" "$@"
  fi
fi

echo "Codex CLI not found. Install @openai/codex or set CODEX_APP_SYSTEM_CODEX." >&2
exit 127
`;
}

function buildRipgrepWrapper() {
  return `#!/usr/bin/env bash
set -euo pipefail

if [[ -n "\${CODEX_APP_SYSTEM_RG:-}" ]]; then
  exec "\${CODEX_APP_SYSTEM_RG}" "$@"
fi

if command -v rg >/dev/null 2>&1; then
  target="$(command -v rg)"
  if [[ "$(realpath "$target")" != "$(realpath "$0")" ]]; then
    exec "$target" "$@"
  fi
fi

echo "ripgrep not found. Install rg or set CODEX_APP_SYSTEM_RG." >&2
exit 127
`;
}

function buildStartScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export PATH="\${ROOT_DIR}/resources:\${PATH}"
export CODEX_CLI_PATH="\${CODEX_CLI_PATH:-\${ROOT_DIR}/resources/codex}"
WEBVIEW_PORT="\${CODEX_APP_WEBVIEW_PORT:-5175}"
export ELECTRON_RENDERER_URL="\${ELECTRON_RENDERER_URL:-http://127.0.0.1:\${WEBVIEW_PORT}}"

WEBVIEW_DIR="\${ROOT_DIR}/content/webview"
WEBVIEW_PID=""

cleanup() {
  if [[ -n "\${WEBVIEW_PID}" ]]; then
    kill "\${WEBVIEW_PID}" >/dev/null 2>&1 || true
    wait "\${WEBVIEW_PID}" >/dev/null 2>&1 || true
  fi
}

check_webview_host() {
  local host="$1"
  if { exec 3<>"/dev/tcp/\${host}/\${WEBVIEW_PORT}"; } 2>/dev/null; then
    exec 3>&-
    exec 3<&-
    return 0
  fi
  return 1
}

wait_for_webview() {
  local attempt
  for attempt in {1..50}; do
    if [[ -n "\${WEBVIEW_PID}" ]] && ! kill -0 "\${WEBVIEW_PID}" >/dev/null 2>&1; then
      return 1
    fi
    if check_webview_host 127.0.0.1 && check_webview_host localhost; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

trap cleanup EXIT INT TERM HUP

if [[ -d "\${WEBVIEW_DIR}" ]]; then
  ELECTRON_RUN_AS_NODE=1 "\${ROOT_DIR}/electron" "\${ROOT_DIR}/serve-webview.mjs" "\${WEBVIEW_DIR}" "\${WEBVIEW_PORT}" &
  WEBVIEW_PID=$!
  if ! wait_for_webview; then
    echo "Failed to start the local ChatGPT webview server on port \${WEBVIEW_PORT}." >&2
    exit 1
  fi
  sleep 0.5
fi

if "\${ROOT_DIR}/electron" --no-sandbox "$@"; then
  exit_code=0
else
  exit_code=$?
fi

exit "\${exit_code}"
`;
}

function buildWebviewServerScript() {
  return `import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? "5175");

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".wav", "audio/wav"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function resolveRequestPath(urlString) {
  const url = new URL(urlString, "http://127.0.0.1");
  const decodedPath = decodeURIComponent(url.pathname);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\\//, "");
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new Error("Forbidden");
  }
  return candidate;
}

async function handleRequest(request, response) {
  let filePath;
  try {
    filePath = resolveRequestPath(request.url ?? "/");
  } catch {
    response.statusCode = 403;
    response.end("Forbidden");
    return;
  }

  try {
    let fileStats = await stat(filePath);
    if (fileStats.isDirectory()) {
      filePath = join(filePath, "index.html");
      fileStats = await stat(filePath);
    }

    response.statusCode = 200;
    response.setHeader(
      "Content-Type",
      mimeTypes.get(extname(filePath)) ?? "application/octet-stream",
    );
    response.setHeader("Content-Length", String(fileStats.size));
    createReadStream(filePath).pipe(response);
  } catch {
    response.statusCode = 404;
    response.end("Not found");
  }
}

async function listenOnHost(host) {
  const server = createServer(handleRequest);
  return await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", (error) => {
      if (error && typeof error === "object" && error.code === "EADDRINUSE") {
        resolvePromise({ host, server: null, reused: true });
        return;
      }
      if (error && typeof error === "object" && error.code === "EADDRNOTAVAIL") {
        resolvePromise({ host, server: null, unavailable: true });
        return;
      }
      rejectPromise(error);
    });
    server.listen(port, host, () => {
      resolvePromise({ host, server, reused: false, unavailable: false });
    });
  });
}

const listeners = await Promise.all([listenOnHost("127.0.0.1"), listenOnHost("::1")]);
const activeServers = listeners
  .map((listener) => listener.server)
  .filter((server) => server != null);

if (activeServers.length === 0 && listeners.every((listener) => listener.reused !== true)) {
  console.error(\`Failed to listen on any loopback address for port \${port}.\`);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    let pending = activeServers.length;
    if (pending === 0) {
      process.exit(0);
      return;
    }
    for (const server of activeServers) {
      server.close(() => {
        pending -= 1;
        if (pending === 0) {
          process.exit(0);
        }
      });
    }
  });
}
`;
}

function electronMajorVersion(electronVersion) {
  const majorVersion = Number(String(electronVersion).split(".")[0]);
  if (!Number.isInteger(majorVersion) || majorVersion <= 0) {
    fail(`Could not parse Electron version: ${electronVersion}`);
  }
  return majorVersion;
}

async function replaceTextOnce(filePath, before, after, description) {
  const source = await readFile(filePath, "utf8");
  const firstIndex = source.indexOf(before);
  if (firstIndex < 0) {
    fail(`Could not find ${description} in ${filePath}.`);
  }
  if (source.indexOf(before, firstIndex + before.length) >= 0) {
    fail(`Found ${description} more than once in ${filePath}.`);
  }
  await writeFile(filePath, source.replace(before, after));
}

async function patchBetterSqlite3SourcesForElectron42(moduleRoot) {
  await replaceTextOnce(
    join(moduleRoot, "src", "util", "macros.cpp"),
    "#define OnlyAddon static_cast<Addon*>(info.Data().As<v8::External>()->Value())",
    [
      "#define BetterSqlite3ExternalPointerTag v8::kExternalPointerTypeTagDefault",
      "#define BetterSqlite3ExternalValue(external) (external)->Value(BetterSqlite3ExternalPointerTag)",
      "#define BetterSqlite3ExternalNew(isolate, value) v8::External::New((isolate), (value), BetterSqlite3ExternalPointerTag)",
      "#define OnlyAddon static_cast<Addon*>(BetterSqlite3ExternalValue(info.Data().As<v8::External>()))",
    ].join("\n"),
    "better-sqlite3 external pointer accessor",
  );
  await replaceTextOnce(
    join(moduleRoot, "src", "better_sqlite3.cpp"),
    "v8::Local<v8::External> data = v8::External::New(isolate, addon);",
    "v8::Local<v8::External> data = BetterSqlite3ExternalNew(isolate, addon);",
    "better-sqlite3 external pointer creation",
  );
  await replaceTextOnce(
    join(moduleRoot, "src", "util", "helpers.cpp"),
    "\t\tfunc,\n\t\t0,\n\t\tdata\n",
    "\t\tfunc,\n\t\tnullptr,\n\t\tdata\n",
    "better-sqlite3 native data property setter",
  );
}

async function patchNativeModuleSourcesForElectron(buildDir, electronVersion, nativeModules) {
  if (electronMajorVersion(electronVersion) < 42) {
    return;
  }

  for (const nativeModule of nativeModules) {
    if (nativeModule.moduleId !== "better-sqlite3") {
      continue;
    }
    const moduleRoot = join(buildDir, "node_modules", ...relativeParts(nativeModule.moduleId));
    await patchBetterSqlite3SourcesForElectron42(moduleRoot);
    nativeModule.sourcePatches = ["electron-42-v8-external-pointer-tag"];
    info("Patched better-sqlite3 native sources for Electron 42.");
  }
}

async function createBuildWorkspace(buildDir, electronVersion, nativeModules) {
  await ensureDir(buildDir);
  await writeFile(
    join(buildDir, "package.json"),
    JSON.stringify(
      {
        private: true,
      },
      null,
      2,
    ),
  );

  const installArgs = ["install", "--no-package-lock", "--ignore-scripts", `electron@${electronVersion}`];
  for (const nativeModule of nativeModules) {
    installArgs.push(`${nativeModule.moduleId}@${nativeModule.version}`);
  }

  info(`Installing rebuild workspace dependencies in ${buildDir}`);
  await run("npm", installArgs, {
    cwd: buildDir,
  });
  await patchNativeModuleSourcesForElectron(buildDir, electronVersion, nativeModules);

  const rebuildCli = join(
    PROJECT_ROOT,
    "node_modules",
    "@electron",
    "rebuild",
    "lib",
    "cli.js",
  );
  const rebuildArgs = [
    rebuildCli,
    "-f",
    "-v",
    electronVersion,
    "-m",
    buildDir,
    "-w",
    nativeModules.map((nativeModule) => nativeModule.moduleId).join(","),
  ];

  info(`Rebuilding native modules for Electron ${electronVersion}`);
  await run("node", rebuildArgs, {
    cwd: buildDir,
  });
}

async function addWorkLouderNodeHidLinuxPrebuilds(extractedAsarDir, installDir) {
  const bundledPackagePath = join(extractedAsarDir, WORK_LOUDER_NODE_HID_MODULE, "package.json");
  if (!(await pathExists(bundledPackagePath))) {
    return [];
  }

  const packageJson = JSON.parse(await readFile(bundledPackagePath, "utf8"));
  const version = String(packageJson.version);
  const prebuildPrefix = `HID_hidraw-linux-${process.arch}`;
  const bundledPrebuildsDir = join(extractedAsarDir, WORK_LOUDER_NODE_HID_MODULE, "prebuilds");
  if (await pathExists(bundledPrebuildsDir)) {
    const alreadyBundled = (await readdir(bundledPrebuildsDir, { withFileTypes: true })).some(
      (entry) => entry.isDirectory() && entry.name.startsWith(prebuildPrefix),
    );
    if (alreadyBundled) {
      return [];
    }
  }

  await ensureDir(installDir);
  await writeFile(
    join(installDir, "package.json"),
    JSON.stringify(
      {
        private: true,
      },
      null,
      2,
    ),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-package-lock", `node-hid@${version}`], {
    cwd: installDir,
  });

  const installedPrebuildsDir = join(installDir, "node_modules", "node-hid", "prebuilds");
  const added = [];
  for (const entry of await readdir(installedPrebuildsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prebuildPrefix)) {
      continue;
    }
    const sourceDir = join(installedPrebuildsDir, entry.name);
    for (const artifact of await readdir(sourceDir, { withFileTypes: true })) {
      if (!artifact.isFile() || !artifact.name.endsWith(".node")) {
        continue;
      }
      const relativeArtifact = join("prebuilds", entry.name, artifact.name);
      const destination = join(extractedAsarDir, WORK_LOUDER_NODE_HID_MODULE, relativeArtifact);
      await copyFileWithMode(join(sourceDir, artifact.name), destination);
      added.push({
        moduleId: WORK_LOUDER_NODE_HID_MODULE,
        version,
        artifact: join(WORK_LOUDER_NODE_HID_MODULE, relativeArtifact),
      });
    }
  }

  if (added.length === 0) {
    fail(`Could not find node-hid ${prebuildPrefix} native prebuilds for Linux.`);
  }

  info(
    `Added Work Louder node-hid Linux prebuild(s): ${added
      .map((artifact) => artifact.artifact)
      .join(", ")}`,
  );
  return added;
}

async function replaceNativeArtifacts(builtNodeModulesDir, outputUnpackedDir, nativeModules) {
  const missingArtifacts = [];

  for (const nativeModule of nativeModules) {
    const builtModuleRoot = join(builtNodeModulesDir, ...relativeParts(nativeModule.moduleId));
    const outputModuleRoot = join(outputUnpackedDir, "node_modules", ...relativeParts(nativeModule.moduleId));

    for (const relativeArtifact of nativeModule.releaseArtifacts) {
      const source = join(builtModuleRoot, relativeArtifact);
      const destination = join(outputModuleRoot, relativeArtifact);
      if (!(await pathExists(source))) {
        if (relativeArtifact.endsWith("spawn-helper")) {
          continue;
        }
        missingArtifacts.push(`${nativeModule.moduleId}:${relativeArtifact}`);
        continue;
      }
      await copyFileWithMode(source, destination);
    }
  }

  return missingArtifacts;
}

async function patchAvatarOverlayMousePassthrough(appAsarPath) {
  const before = Buffer.from(AVATAR_OVERLAY_MOUSE_PASSTHROUGH_CALL);
  const after = Buffer.from(AVATAR_OVERLAY_MOUSE_INTERACTIVE_CALL);
  if (before.length !== after.length) {
    fail("Avatar overlay mouse passthrough patch must preserve app.asar byte length.");
  }

  const archive = await readFile(appAsarPath);
  const firstIndex = archive.indexOf(before);
  if (firstIndex < 0) {
    fail("Could not find avatar overlay mouse passthrough call in app.asar.");
  }
  if (archive.indexOf(before, firstIndex + before.length) >= 0) {
    fail("Avatar overlay mouse passthrough call matched more than once in app.asar.");
  }

  after.copy(archive, firstIndex);
  await writeFile(appAsarPath, archive);
  info("Patched avatar overlay mouse passthrough for Linux.");
}

function patchAvatarOverlayDragMethods(archive) {
  const matches = AVATAR_OVERLAY_DRAG_METHODS_START_MARKERS.flatMap((marker) => {
    const markerBuffer = Buffer.from(marker);
    const startIndex = archive.indexOf(markerBuffer);
    return startIndex < 0 ? [] : [{ markerBuffer, startIndex }];
  });
  if (matches.length === 0) {
    fail("Could not find avatar overlay drag methods in app.asar.");
  }
  if (matches.length > 1) {
    fail("Avatar overlay drag methods matched more than once in app.asar.");
  }
  const [{ markerBuffer: startMarker, startIndex }] = matches;
  if (archive.indexOf(startMarker, startIndex + startMarker.length) >= 0) {
    fail("Avatar overlay drag methods matched more than once in app.asar.");
  }

  const endIndex = AVATAR_OVERLAY_DRAG_METHODS_END_MARKERS.map((marker) =>
    archive.indexOf(Buffer.from(marker), startIndex),
  )
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (endIndex == null) {
    fail("Could not find end of avatar overlay drag methods in app.asar.");
  }

  const beforeLength = endIndex - startIndex;
  const after = Buffer.from(AVATAR_OVERLAY_LINUX_INTERACTION_METHODS);
  if (after.length > beforeLength) {
    fail("Avatar overlay Linux interaction patch does not fit in app.asar.");
  }

  after.copy(archive, startIndex);
  archive.fill(";".charCodeAt(0), startIndex + after.length, endIndex);
  info("Patched avatar overlay drag handling for Linux.");
}

async function patchAvatarOverlayForLinux(appAsarPath) {
  await patchAvatarOverlayMousePassthrough(appAsarPath);
  const archive = await readFile(appAsarPath);
  patchAvatarOverlayDragMethods(archive);
  await writeFile(appAsarPath, archive);
}

async function listFilesRecursive(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

async function patchAvatarOverlayWebviewForLinux(webviewDir) {
  const files = await listFilesRecursive(webviewDir);
  let patchedCount = 0;

  for (const file of files) {
    if (!file.endsWith(".js") || !basename(file).includes("avatar-overlay")) {
      continue;
    }
    let source = await readFile(file, "utf8");
    if (
      !source.includes(AVATAR_OVERLAY_OPEN_MAIN_WINDOW_CALL) &&
      !source.includes(AVATAR_OVERLAY_OPEN_MAIN_WINDOW_DISPATCH)
    ) {
      continue;
    }
    let patched;
    if (source.includes(AVATAR_OVERLAY_OPEN_MAIN_WINDOW_CALL)) {
      patched = source.replace(
        AVATAR_OVERLAY_OPEN_MAIN_WINDOW_CALL,
        AVATAR_OVERLAY_DISABLED_OPEN_MAIN_WINDOW_CALL,
      );
      if (patched.includes(AVATAR_OVERLAY_OPEN_MAIN_WINDOW_CALL)) {
        fail("Avatar overlay open-main-window call matched more than once in webview.");
      }
    } else if (source.includes("onMascotClick")) {
      patched = source.replace(
        /onMascotClick:\(\)=>\{[A-Za-z_$][\w$]*\.dispatchMessage\(`open-current-main-window`,\{[^{}]*\}\)\}/,
        "onMascotClick:()=>{}",
      );
      if (patched === source) {
        fail("Could not patch avatar overlay native mascot click handler in webview.");
      }
    } else {
      const dispatchIndex = source.indexOf(AVATAR_OVERLAY_OPEN_MAIN_WINDOW_DISPATCH);
      if (source.indexOf(AVATAR_OVERLAY_OPEN_MAIN_WINDOW_DISPATCH, dispatchIndex + 1) >= 0) {
        fail("Avatar overlay open-main-window dispatch matched more than once in webview.");
      }

      const guardIndex = source.lastIndexOf("&&(", dispatchIndex);
      const guardPrefix = source.slice(Math.max(0, guardIndex - 100), guardIndex);
      if (
        guardIndex < 0 ||
        !guardPrefix.includes(".startedOnMascot") ||
        (!guardPrefix.includes(".hasMoved") && !guardPrefix.includes("!"))
      ) {
        fail("Could not find avatar overlay mascot-click guard in webview.");
      }
      patched = `${source.slice(0, guardIndex)}&&false&&(${source.slice(guardIndex + 3)}`;
    }
    await writeFile(file, patched);
    patchedCount += 1;
  }

  if (patchedCount === 0) {
    fail("Expected to patch at least one avatar overlay webview asset.");
  }

  info("Patched avatar overlay mascot click handling for Linux.");
}

async function findAppContentsDir(extractedZipDir) {
  const appBundles = (await readdir(extractedZipDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => entry.name)
    .sort();

  if (appBundles.length !== 1) {
    fail(
      `Expected exactly one macOS app bundle in ${extractedZipDir}, found: ${
        appBundles.join(", ") || "none"
      }`,
    );
  }

  return join(extractedZipDir, appBundles[0], "Contents");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (process.platform !== "linux") {
    fail("This builder currently only supports running on Linux.");
  }

  await requireBuildDependencies();

  await ensureDir(options.cacheDir);
  await ensureDir(join(options.cacheDir, "work"));

  let release = null;
  let sourceZipPath = options.sourceZip;
  if (sourceZipPath == null) {
    const releases = await fetchReleaseIndex(options.appcastUrl);
    release = selectRelease(releases, options.version);
    const cacheZipPath = join(
      options.cacheDir,
      "downloads",
      basename(new URL(release.enclosureUrl).pathname),
    );
    const downloaded = await downloadFile(release.enclosureUrl, cacheZipPath);
    info(
      downloaded
        ? `Downloaded upstream archive to ${cacheZipPath}`
        : `Using cached upstream archive ${cacheZipPath}`,
    );
    sourceZipPath = cacheZipPath;
  } else if (!(await pathExists(sourceZipPath))) {
    fail(`Zip file does not exist: ${sourceZipPath}`);
  }

  const workDir =
    options.workDir ??
    (await mkdtemp(join(options.cacheDir, "work", "codex-")));
  await ensureDir(workDir);

  try {
    const extractedZipDir = join(workDir, "upstream");
    await ensureDir(extractedZipDir);
    info(`Extracting ${basename(sourceZipPath)} into ${extractedZipDir}`);
    await run("unzip", ["-q", sourceZipPath, "-d", extractedZipDir]);

    const appContentsDir = await findAppContentsDir(extractedZipDir);
    const upstreamResourcesDir = join(appContentsDir, "Resources");
    const upstreamUnpackedDir = join(upstreamResourcesDir, "app.asar.unpacked");
    const upstreamAsarPath = join(upstreamResourcesDir, "app.asar");

    const appInfo = plist.parse(await readFile(join(appContentsDir, "Info.plist"), "utf8"));
    const packageJson = readJsonFromAsar(upstreamAsarPath, "package.json");
    const bundleUrlTypes = Array.isArray(appInfo.CFBundleURLTypes)
      ? appInfo.CFBundleURLTypes
      : [];
    const bundleUrlSchemes = bundleUrlTypes.flatMap((urlType) =>
      Array.isArray(urlType.CFBundleURLSchemes)
        ? urlType.CFBundleURLSchemes.map(String)
        : [],
    );
    const { nativeModules, skippedNativeModules } = await discoverNativeModules(
      upstreamAsarPath,
      upstreamUnpackedDir,
    );
    if (nativeModules.length === 0) {
      fail("No rebuildable native modules were discovered in app.asar.unpacked.");
    }
    if (skippedNativeModules.length > 0) {
      warn(
        `Skipping native module(s) unsupported on ${process.platform}/${process.arch}: ${skippedNativeModules
          .map((nativeModule) => `${nativeModule.moduleId}@${nativeModule.version}`)
          .join(", ")}`,
      );
    }

    const appVersion = String(appInfo.CFBundleShortVersionString ?? packageJson.version);
    const buildVersion = String(appInfo.CFBundleVersion ?? release?.buildVersion ?? "unknown");
    const electronVersion = await resolveElectronVersion(appContentsDir, packageJson);
    const outputDir =
      options.outputDir ?? resolve(PROJECT_ROOT, "out", `codex-linux-${appVersion}`);

    if (await pathExists(outputDir)) {
      if (!options.force) {
        fail(`Output directory already exists: ${outputDir}. Use --force to replace it.`);
      }
      await removeIfExists(outputDir);
    }

    const electronArch = mapNodeArchToElectronArch(process.arch);
    const electronZipUrl = `https://github.com/electron/electron/releases/download/v${electronVersion}/electron-v${electronVersion}-linux-${electronArch}.zip`;
    const electronZipPath = join(
      options.cacheDir,
      "downloads",
      basename(new URL(electronZipUrl).pathname),
    );
    const downloadedElectron = await downloadFile(electronZipUrl, electronZipPath);
    info(
      downloadedElectron
        ? `Downloaded Electron runtime to ${electronZipPath}`
        : `Using cached Electron runtime ${electronZipPath}`,
    );

    info(`Extracting Electron runtime into ${outputDir}`);
    await ensureDir(outputDir);
    await run("unzip", ["-q", electronZipPath, "-d", outputDir]);

    const rebuiltUnpackedDir = join(workDir, "rebuilt-app.asar.unpacked");
    await cp(upstreamUnpackedDir, rebuiltUnpackedDir, {
      recursive: true,
      force: true,
    });

    const nativeBuildDir = join(workDir, "native-build");
    await createBuildWorkspace(nativeBuildDir, electronVersion, nativeModules);
    const missingArtifacts = await replaceNativeArtifacts(
      join(nativeBuildDir, "node_modules"),
      rebuiltUnpackedDir,
      nativeModules,
    );
    if (missingArtifacts.length > 0) {
      warn(`Some upstream native artifacts were not replaced: ${missingArtifacts.join(", ")}`);
    }

    const outputResourcesDir = join(outputDir, "resources");
    await cp(upstreamResourcesDir, outputResourcesDir, {
      recursive: true,
      force: true,
    });
    await cp(rebuiltUnpackedDir, join(outputResourcesDir, "app.asar.unpacked"), {
      recursive: true,
      force: true,
    });

    const defaultAppAsar = join(outputResourcesDir, "default_app.asar");
    if (await pathExists(defaultAppAsar)) {
      await removeIfExists(defaultAppAsar);
    }

    const extractedAsarDir = join(workDir, "asar");
    const outputAppAsarPath = join(outputResourcesDir, "app.asar");
    asar.extractAll(outputAppAsarPath, extractedAsarDir);
    const addedNativePrebuilds = await addWorkLouderNodeHidLinuxPrebuilds(
      extractedAsarDir,
      join(workDir, "node-hid-prebuild"),
    );
    if (addedNativePrebuilds.length > 0) {
      await asar.createPackage(extractedAsarDir, outputAppAsarPath);
    }
    await patchAvatarOverlayForLinux(outputAppAsarPath);

    const extractedWebviewDir = join(extractedAsarDir, "webview");
    if (await pathExists(extractedWebviewDir)) {
      const outputWebviewDir = join(outputDir, "content", "webview");
      await cp(extractedWebviewDir, outputWebviewDir, {
        recursive: true,
        force: true,
      });
      await patchAvatarOverlayWebviewForLinux(outputWebviewDir);
    } else {
      warn("No webview directory was found inside app.asar.");
    }

    await writeExecutable(join(outputResourcesDir, "codex"), buildCodexWrapper());
    await writeExecutable(join(outputResourcesDir, "rg"), buildRipgrepWrapper());
    await writeExecutable(join(outputDir, "start.sh"), buildStartScript());
    await writeExecutable(join(outputDir, "serve-webview.mjs"), buildWebviewServerScript());

    const manifest = {
      builtAt: new Date().toISOString(),
      appVersion,
      buildVersion,
      electronVersion,
      upstreamApp: {
        displayName: String(
          appInfo.CFBundleDisplayName ?? appInfo.CFBundleName ?? packageJson.productName,
        ),
        bundleName: String(appInfo.CFBundleName ?? packageJson.productName),
        bundleIdentifier: String(appInfo.CFBundleIdentifier),
        executable: String(appInfo.CFBundleExecutable),
        urlSchemes: bundleUrlSchemes,
        appBrand: String(packageJson.codexAppBrand ?? ""),
        packageName: String(packageJson.name),
        productName: String(packageJson.productName),
      },
      source: release ?? {
        shortVersion: options.version ?? appVersion,
        enclosureUrl: sourceZipPath,
      },
      nativeModules: nativeModules.map((nativeModule) => ({
        moduleId: nativeModule.moduleId,
        version: nativeModule.version,
        ...(nativeModule.sourcePatches == null
          ? {}
          : { sourcePatches: nativeModule.sourcePatches }),
        replacedArtifacts: nativeModule.releaseArtifacts,
      })),
      skippedNativeModules: skippedNativeModules.map((nativeModule) => ({
        moduleId: nativeModule.moduleId,
        version: nativeModule.version,
        os: nativeModule.os,
        cpu: nativeModule.cpu,
        ...(nativeModule.missingPackageJson == null
          ? {}
          : { missingPackageJson: nativeModule.missingPackageJson }),
        preservedArtifacts: nativeModule.releaseArtifacts,
      })),
      addedNativePrebuilds,
      runtimeWrappers: {
        codex: "resources/codex",
        rg: "resources/rg",
      },
      renderer: {
        webviewDir: "content/webview",
        url: "http://127.0.0.1:5175",
      },
    };
    await writeFile(
      join(outputDir, "codex-linux-manifest.json"),
      JSON.stringify(manifest, null, 2),
    );

    if ((await findExecutableOnPath("codex")) == null) {
      warn("No system codex CLI found on PATH; the packaged app will need CODEX_APP_SYSTEM_CODEX or a codex install.");
    }
    if ((await findExecutableOnPath("rg")) == null) {
      warn("No system rg found on PATH; the packaged app will need CODEX_APP_SYSTEM_RG or ripgrep installed.");
    }

    info(`Built Linux package in ${outputDir}`);
    info(`Launch with ${join(outputDir, "start.sh")}`);
  } finally {
    if (options.keepWorkDir || options.workDir != null) {
      info(`Keeping work directory at ${workDir}`);
    } else {
      await removeIfExists(workDir);
    }
  }
}

await main();
