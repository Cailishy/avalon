import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const assetDir = join(root, "public", "assets");
mkdirSync(assetDir, { recursive: true });

const assets = [
  {
    title: "Unsolved Investigation by isaiah658 (game music)",
    file: "game-investigation-loop.ogg",
    source: "https://opengameart.org/content/unsolved-investigation",
    url: "https://opengameart.org/sites/default/files/Unsolved-Investigation-isaiah658_0.ogg",
    license: "CC0",
  },
  {
    title: "Cathedral in the forest by congusbongus (game music)",
    file: "game-ambient-loop.ogg",
    source: "https://opengameart.org/content/cathedral-in-the-forest-ambient-loop",
    url: "https://opengameart.org/sites/default/files/forest_2_0.ogg",
    license: "CC0",
  },
  {
    title: "Medieval fair loop by Woli34",
    file: "medieval-fair-loop.ogg",
    source: "https://opengameart.org/content/medieval-fair-loop",
    url: "https://opengameart.org/sites/default/files/Medieval%20fair%20loop.ogg",
    license: "CC0",
  },
  {
    title: "Fantasy UI Borders by Kenney",
    file: "kenney-fantasy-ui-borders.zip",
    source: "https://opengameart.org/content/fantasy-ui-borders",
    url: "https://opengameart.org/sites/default/files/kenney_fantasy-ui-borders.zip",
    license: "CC0",
  },
  {
    title: "Tileable Ice/Steel Castle Background by Spring Spring",
    file: "castle-background.png",
    source: "https://opengameart.org/content/tileable-icesteel-castle-background",
    url: "https://opengameart.org/sites/default/files/bg1_3.png",
    license: "CC0",
  },
  {
    title: "2D RPG Character Portraits by Arcade Dream",
    file: "rpg-character-portraits.zip",
    source: "https://opengameart.org/content/2d-rpg-character-portraits",
    url: "https://opengameart.org/sites/default/files/RPGCharacters.zip",
    license: "CC0",
  },
];

async function download(asset) {
  const target = join(assetDir, asset.file);
  if (existsSync(target)) {
    console.log(`skip ${asset.file}`);
    return;
  }

  console.log(`download ${asset.title}`);
  const response = await fetch(asset.url, {
    headers: {
      "user-agent": "avalon-asset-downloader",
    },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${asset.url}: ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(target));
}

const requestedFiles = process.argv.slice(2);
for (const asset of assets.filter(asset => !requestedFiles.length || requestedFiles.includes(asset.file))) {
  await download(asset);
}

const downloadedAt = new Date().toISOString();
const attribution = [
  "# Asset Attribution",
  "",
  `Downloaded at: ${downloadedAt}`,
  "",
  "These open-license assets are used as style-compatible substitutes. They are not official Avalon assets.",
  "",
  "The root MIT license covers project code, not an automatic relicensing of this media. See [asset scope](LICENSE.md), [licensing guidance](../../docs/media/licensing.md) and the [release review record](../../docs/media/assets.json). Attribution records provenance; it does not mark pending redistribution reviews as approved.",
  "",
  "| Asset | Local file | Source | License |",
  "| --- | --- | --- | --- |",
  ...assets.map((asset) => `| ${asset.title} | ${asset.file} | ${asset.source} | ${asset.license} |`),
  "",
  "The legacy avatars/avatar-1.png through avatar-10.png are character images extracted from RPGCharacters.zip. The active theme uses the generated atlases documented below.",
  "",
].join("\n");

const attributionPath = join(assetDir, "ATTRIBUTION.md");
const previous = existsSync(attributionPath) ? readFileSync(attributionPath, "utf8") : "";
const generatedArt = previous.match(/^## Generated Art[\s\S]*$/m)?.[0] ?? "";
writeFileSync(attributionPath, attribution + (generatedArt ? `\n${generatedArt}` : ""), "utf8");
console.log("asset attribution written");
