import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  PROJECT_ROOT,
  ensureDir,
  fail,
  info,
  pathExists,
  removeIfExists,
} from "./shared.mjs";

const AUTOMATION_TEMPLATE_RE =
  /\{id:`([^`]+)`,promptMessage:(?:[\w$]+\()?\{id:`([^`]+)`,defaultMessage:`([^`]*)`,description:`([^`]*)`\}\)?,automationPromptMessage:(?:[\w$]+\()?\{id:`([^`]+)`,defaultMessage:`([^`]*)`,description:`([^`]*)`\}\)?,iconName:`([^`]+)`,mode:`([^`]+)`,isAutomation:!0\}/gs;

const AUTOMATION_MESSAGE_RE =
  /id:`settings\.automations\.([^`]+)`,defaultMessage:`([^`]*)`,description:`([^`]*)`/g;

function parseArgs(argv) {
  const options = {
    dir: null,
    outputDir: resolve(PROJECT_ROOT, "automation-examples"),
    version: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--dir":
        options.dir = resolve(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--output-dir":
        options.outputDir = resolve(argv[index + 1] ?? "");
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

async function findAssetBySource(outputDir, entryMatcher, sourceMatcher, label) {
  return (await findAssetsBySource(outputDir, entryMatcher, sourceMatcher, label))[0];
}

async function findAssetsBySource(outputDir, entryMatcher, sourceMatcher, label) {
  const assetsDir = join(outputDir, "content", "webview", "assets");
  if (!(await pathExists(assetsDir))) {
    fail(`Missing assets directory: ${assetsDir}`);
  }

  const candidates = (await readdir(assetsDir))
    .filter((entry) => entry.endsWith(".js") && entryMatcher(entry))
    .sort();

  const matches = [];
  for (const entry of candidates) {
    const assetPath = join(assetsDir, entry);
    const source = await readFile(assetPath, "utf8");
    if (sourceMatcher(source)) {
      matches.push({
        assetPath,
        source,
      });
    }
  }

  if (matches.length > 0) {
    return matches;
  }

  fail(`Could not find ${label} in ${assetsDir}`);
}

function extractAutomationTemplates(source) {
  const templates = [];

  let match;
  while ((match = AUTOMATION_TEMPLATE_RE.exec(source)) != null) {
    const preview = match[6].split("\n\n", 1)[0]?.trim() ?? "";
    templates.push({
      id: match[1],
      iconName: match[8],
      mode: match[9],
      preview,
      promptDescription: match[4],
      promptMessage: match[3],
      promptMessageId: match[2],
      automationPrompt: match[6],
      automationPromptDescription: match[7],
      automationPromptId: match[5],
    });
  }

  if (templates.length === 0) {
    fail("No automation templates found in the compiled home bundle.");
  }

  return templates;
}

function extractDialogMessages(source) {
  const messages = [];
  const seen = new Set();

  let match;
  while ((match = AUTOMATION_MESSAGE_RE.exec(source)) != null) {
    const key = match[1];
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    messages.push({
      description: match[3],
      key,
      message: match[2],
      messageId: `settings.automations.${key}`,
    });
  }

  if (messages.length === 0) {
    fail("No settings.automations.* messages found in the automation dialog bundle.");
  }

  return messages;
}

function renderTemplateMarkdown(template) {
  return `# ${template.promptMessage}

ID: \`${template.id}\`
Mode: \`${template.mode}\`
Icon: \`${template.iconName}\`

Card preview:

${template.preview}

Full automation prompt:

\`\`\`
${template.automationPrompt}
\`\`\`

Source message ids:

- ${template.promptMessageId}
- ${template.automationPromptId}
`;
}

function renderReadme({
  dialogAssetPaths,
  homeAssetPath,
  outputDir,
  templates,
  uiMessages,
  version,
}) {
  const dialogAssetList = dialogAssetPaths
    .map((assetPath) => `- \`${relative(PROJECT_ROOT, assetPath)}\``)
    .join("\n");

  return `# Automation Examples

Latest extracted app version: \`${version}\`

Extracted from the compiled home bundle: \`${relative(PROJECT_ROOT, homeAssetPath)}\`

Automation UI metadata extracted from:

${dialogAssetList}

Output directory: \`${relative(PROJECT_ROOT, outputDir)}\`

Found ${templates.length} automation template cards from the "Start with a template" UI.

Found ${uiMessages.length} automation UI messages.

Files:

- \`templates.json\`: machine-readable template manifest
- \`templates/\`: one markdown file per automation template
- \`ui-messages.json\`: automation UI labels, placeholders, and warnings
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = await resolveOutputDir(options);
  const manifestPath = join(outputDir, "codex-linux-manifest.json");
  if (!(await pathExists(manifestPath))) {
    fail(`Missing build manifest: ${manifestPath}`);
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const version = manifest.appVersion ?? options.version ?? "unknown-version";
  const extractionDir = options.outputDir;
  const templatesDir = join(extractionDir, "templates");

  const homeAsset = await findAssetBySource(
    outputDir,
    (entry) => /^(automation-dialog|index)-.*\.js$/i.test(entry),
    (source) => source.includes("home.useCases.") && source.includes("isAutomation:!0"),
    "automation templates bundle",
  );
  const dialogAssets = await findAssetsBySource(
    outputDir,
    (entry) => /^(automation-dialog|automations-page|composer|index)-.*\.js$/i.test(entry),
    (source) =>
      source.includes("id:`settings.automations.") && source.includes("defaultMessage:"),
    "automation UI message bundle",
  );

  const templates = extractAutomationTemplates(homeAsset.source);
  const uiMessages = extractDialogMessages(
    dialogAssets.map((dialogAsset) => dialogAsset.source).join("\n"),
  );

  await removeIfExists(extractionDir);
  await ensureDir(templatesDir);

  await writeFile(
    join(extractionDir, "templates.json"),
    `${JSON.stringify(
      {
        appVersion: version,
        extractedAt: new Date().toISOString(),
        sourceAsset: relative(PROJECT_ROOT, homeAsset.assetPath),
        sourceType: "compiled-webview-home-bundle",
        templateCount: templates.length,
        templates,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(extractionDir, "ui-messages.json"),
    `${JSON.stringify(
      {
        appVersion: version,
        extractedAt: new Date().toISOString(),
        sourceAsset: relative(PROJECT_ROOT, dialogAssets[0].assetPath),
        sourceAssets: dialogAssets.map((dialogAsset) =>
          relative(PROJECT_ROOT, dialogAsset.assetPath),
        ),
        sourceType: "compiled-webview-automation-ui-bundles",
        messageCount: uiMessages.length,
        messages: uiMessages,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(extractionDir, "README.md"),
    renderReadme({
      dialogAssetPaths: dialogAssets.map((dialogAsset) => dialogAsset.assetPath),
      homeAssetPath: homeAsset.assetPath,
      outputDir: extractionDir,
      templates,
      uiMessages,
      version,
    }),
  );

  for (let index = 0; index < templates.length; index += 1) {
    const template = templates[index];
    const prefix = String(index + 1).padStart(2, "0");
    await writeFile(
      join(templatesDir, `${prefix}-${template.id}.md`),
      renderTemplateMarkdown(template),
    );
  }

  info(`Extracted ${templates.length} automation template(s) to ${extractionDir}`);
}

await main();
