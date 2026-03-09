import { DEFAULT_APPCAST_URL, fetchReleaseIndex, selectRelease } from "./shared.mjs";

function parseArgs(argv) {
  const options = {
    version: null,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--version") {
      options.version = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));
const releases = await fetchReleaseIndex(DEFAULT_APPCAST_URL);
const release = selectRelease(releases, options.version);

if (options.json) {
  console.log(JSON.stringify(release, null, 2));
} else {
  console.log(`Version: ${release.shortVersion}`);
  console.log(`Build:   ${release.buildVersion}`);
  console.log(`Date:    ${release.pubDate}`);
  console.log(`Zip:     ${release.enclosureUrl}`);
}
