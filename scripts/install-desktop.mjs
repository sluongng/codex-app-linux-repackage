import { cp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  PROJECT_ROOT,
  ensureDir,
  fail,
  findExecutableOnPath,
  pathExists,
  removeIfExists,
  run,
  writeExecutable,
} from "./shared.mjs";

function defaultDataHome() {
  return process.env.XDG_DATA_HOME || resolve(homedir(), ".local", "share");
}

function defaultInstallRoot() {
  return resolve(homedir(), ".local", "opt", "codex-app");
}

function parseArgs(argv) {
  const options = {
    desktopFile: null,
    dir: null,
    force: false,
    installRoot: defaultInstallRoot(),
    version: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--desktop-file":
        options.desktopFile = resolve(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--dir":
        options.dir = resolve(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--install-root":
        options.installRoot = resolve(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--version":
        options.version = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--force":
        options.force = true;
        break;
      default:
        fail(`Unknown argument: ${argument}`);
    }
  }

  if (options.desktopFile == null) {
    options.desktopFile = resolve(defaultDataHome(), "applications", "codex-app.desktop");
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

async function resolveBundledIcon(outputDir) {
  const assetsDir = join(outputDir, "content", "webview", "assets");
  if (await pathExists(assetsDir)) {
    const entries = (await readdir(assetsDir))
      .filter((entry) => /^app-.*\.png$/i.test(entry))
      .sort();
    if (entries.length > 0) {
      return {
        kind: "copy",
        source: join(assetsDir, entries[0]),
      };
    }
  }

  const fallbackIcns = join(outputDir, "resources", "electron.icns");
  if (await pathExists(fallbackIcns)) {
    return {
      kind: "convert-icns",
      source: fallbackIcns,
    };
  }

  fail(`No bundled icon asset found in ${outputDir}`);
}

async function convertIcnsToPng(sourcePath, destinationPath) {
  await run("python3", [
    "-c",
    "from PIL import Image; import sys; Image.open(sys.argv[1]).save(sys.argv[2])",
    sourcePath,
    destinationPath,
  ]);
}

async function replaceSymlink(linkPath, targetPath) {
  await removeIfExists(linkPath);
  await symlink(targetPath, linkPath);
}

function buildDesktopFile({ execPath, iconPath, installPath }) {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=Codex
Comment=OpenAI Codex desktop app
Exec=${execPath} %U
TryExec=${execPath}
Path=${installPath}
Icon=${iconPath}
Terminal=false
Categories=Development;IDE;
Keywords=OpenAI;Codex;AI;Development;
StartupNotify=true
`;
}

function buildDesktopLauncher({ codexPath, rgPath }) {
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    'ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'USER_DATA_DIR="${CODEX_APP_USER_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/codex-app/profile}"',
    'mkdir -p "${USER_DATA_DIR}"',
  ];

  if (codexPath != null) {
    lines.push(`export CODEX_APP_SYSTEM_CODEX="\${CODEX_APP_SYSTEM_CODEX:-${codexPath}}"`);
  }
  if (rgPath != null) {
    lines.push(`export CODEX_APP_SYSTEM_RG="\${CODEX_APP_SYSTEM_RG:-${rgPath}}"`);
  }

  lines.push('has_user_data_dir=0');
  lines.push('for arg in "$@"; do');
  lines.push('  if [[ "${arg}" == --user-data-dir=* || "${arg}" == "--user-data-dir" ]]; then');
  lines.push('    has_user_data_dir=1');
  lines.push('    break');
  lines.push('  fi');
  lines.push('done');
  lines.push('');
  lines.push('if [[ "${has_user_data_dir}" -eq 1 ]]; then');
  lines.push('  exec "${ROOT_DIR}/start.sh" "$@"');
  lines.push('else');
  lines.push('  exec "${ROOT_DIR}/start.sh" "--user-data-dir=${USER_DATA_DIR}" "$@"');
  lines.push('fi');
  lines.push("");
  return lines.join("\n");
}

function buildPinnedBinaryWrapper({ envVar, executablePath, label }) {
  return `#!/usr/bin/env bash
set -euo pipefail

if [[ -n "\${${envVar}:-}" ]]; then
  exec "\${${envVar}}" "$@"
fi

exec "${executablePath}" "$@"
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = await resolveOutputDir(options);
  const manifest = JSON.parse(
    await readFile(join(outputDir, "codex-linux-manifest.json"), "utf8"),
  );

  const installRoot = options.installRoot;
  const installPath = join(installRoot, manifest.appVersion);
  const currentLink = join(installRoot, "current");
  const iconDestinationPath = join(installPath, "codex.png");
  const desktopLauncherPath = join(installPath, "desktop-launch.sh");
  const bundledIcon = await resolveBundledIcon(outputDir);
  const systemCodexPath = await findExecutableOnPath("codex");
  const systemRgPath = await findExecutableOnPath("rg");

  if (!(await pathExists(join(outputDir, "start.sh")))) {
    fail(`Missing build output: ${join(outputDir, "start.sh")}`);
  }
  if (!(await pathExists(join(outputDir, "codex-linux-manifest.json")))) {
    fail(`Missing build output manifest in ${outputDir}`);
  }
  await ensureDir(installRoot);
  if (await pathExists(installPath)) {
    if (!options.force) {
      fail(`Install target already exists: ${installPath}. Use --force to replace it.`);
    }
    await removeIfExists(installPath);
  }
  await cp(outputDir, installPath, {
    recursive: true,
    force: true,
  });

  if (bundledIcon.kind === "copy") {
    await cp(bundledIcon.source, iconDestinationPath, { force: true });
  } else {
    await convertIcnsToPng(join(installPath, "resources", "electron.icns"), iconDestinationPath);
  }
  if (systemCodexPath != null) {
    await writeExecutable(
      join(installPath, "resources", "codex"),
      buildPinnedBinaryWrapper({
        envVar: "CODEX_APP_SYSTEM_CODEX",
        executablePath: systemCodexPath,
        label: "Codex CLI",
      }),
    );
  }
  if (systemRgPath != null) {
    await writeExecutable(
      join(installPath, "resources", "rg"),
      buildPinnedBinaryWrapper({
        envVar: "CODEX_APP_SYSTEM_RG",
        executablePath: systemRgPath,
        label: "ripgrep",
      }),
    );
  }
  await writeExecutable(
    desktopLauncherPath,
    buildDesktopLauncher({
      codexPath: systemCodexPath,
      rgPath: systemRgPath,
    }),
  );

  await replaceSymlink(currentLink, installPath);
  await ensureDir(dirname(options.desktopFile));
  await writeFile(
    options.desktopFile,
    buildDesktopFile({
      execPath: join(currentLink, "desktop-launch.sh"),
      iconPath: join(currentLink, "codex.png"),
      installPath: currentLink,
    }),
  );

  await run("desktop-file-validate", [options.desktopFile]);
  await run("update-desktop-database", [dirname(options.desktopFile)]);

  const resolvedDesktopFile = await realpath(options.desktopFile).catch(() => options.desktopFile);
  console.log(`Installed Codex ${manifest.appVersion} to ${installPath}`);
  console.log(`Desktop entry: ${resolvedDesktopFile}`);
  console.log(`Launcher: ${join(currentLink, "desktop-launch.sh")}`);
}

await main();
