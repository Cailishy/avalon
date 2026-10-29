# Asset Attribution

Downloaded at: 2026-10-14T06:09:58.403Z

These open-license assets are used as style-compatible substitutes. They are not official Avalon assets.

The root MIT license covers project code, not an automatic relicensing of this media. See [asset scope](LICENSE.md), [licensing guidance](../../docs/media/licensing.md) and the [release review record](../../docs/media/assets.json). Attribution records provenance; it does not mark pending redistribution reviews as approved.

| Asset | Local file | Source | License |
| --- | --- | --- | --- |
| Unsolved Investigation by isaiah658 (game music) | game-investigation-loop.ogg | https://opengameart.org/content/unsolved-investigation | CC0 |
| Cathedral in the forest by congusbongus (game music) | game-ambient-loop.ogg | https://opengameart.org/content/cathedral-in-the-forest-ambient-loop | CC0 |
| Medieval fair loop by Woli34 | medieval-fair-loop.ogg | https://opengameart.org/content/medieval-fair-loop | CC0 |
| Fantasy UI Borders by Kenney | kenney-fantasy-ui-borders.zip | https://opengameart.org/content/fantasy-ui-borders | CC0 |
| Tileable Ice/Steel Castle Background by Spring Spring | castle-background.png | https://opengameart.org/content/tileable-icesteel-castle-background | CC0 |
| 2D RPG Character Portraits by Arcade Dream | rpg-character-portraits.zip | https://opengameart.org/content/2d-rpg-character-portraits | CC0 |

The legacy avatars/avatar-1.png through avatar-10.png are character images extracted from RPGCharacters.zip. The active theme uses the generated atlases documented below.

## Generated Art (2026-10-14)

Created with the built-in OpenAI image generation tool for this project, not official Avalon art and not third-party CC0 downloads. The original PNGs are stored in `public/assets`; no external image host is needed.

| File | Use | Layout |
| --- | --- | --- |
| avalon-portraits.png | Eight private role portraits and final revealed roles | Four columns, two rows; each cell has a 2:3 aspect ratio |
| avalon-guests.png | Female loyal servant variant in the first cell; second cell reserved | Two columns, one row; each cell has a 2:3 aspect ratio |
| avalon-public-portraits.png | Ten neutral civilian public seat portraits; no role art | Five columns, two rows; each cell has a 2:3 aspect ratio |
| avalon-table.png | Entry background and live table surface material | Overhead round table |

`portraits.ts` maps roles to atlas cells for private identity and final results. The server independently assigns each servant a male or female cosmetic variant at game start (50/50), preserves it on reconnect, and publishes only aggregate gender counts until final results. Public avatars use a separate atlas and depend only on seat number, never on a player's role. CSS keeps atlas positioning and crops heads in circles without generating per-player files.

Generation prompts are preserved in [ART-PROMPTS.md](ART-PROMPTS.md).

## Redistribution Review (2026-10-25)

The maintainer explicitly approved MIT distribution of the four project-generated PNGs, the project-created `icon.svg` and the two synthesized WAVs. See the [full MIT asset license](MIT-LICENSE.txt), [audit evidence and limitations](../../docs/media/provenance.md), and the hash-bound [review inventory](../../docs/media/assets.json). The six third-party downloads and ten derived avatars were verified against their upstream CC0 sources; they retain CC0 and are not relicensed as project-created MIT assets. Lucide UI icons retain their own ISC/Feather MIT notices.

The MIT asset approval does not cover MiniMax narration, future additions, third-party trademarks or likeness rights. On 2026-10-29 the project maintainer separately confirmed that the existing 16 narration MP3s may be publicly distributed with this project. This is a maintainer confirmation, not an independently obtained MiniMax license or a grant of MIT/CC0 rights; see [narration/NOTICE.md](narration/NOTICE.md).

## Original Result Sounds (2026-10-14)

`mission-success.wav` and `mission-fail.wav` are original synthesized project assets, generated locally by `scripts/media/generate-result-sounds.mjs`, not downloaded music or official game sound effects. Both are 44.1 kHz, mono, 16-bit PCM, 2.2 seconds. Success uses an ascending bell phrase; failure uses a descending low phrase. Regenerate with `node scripts/media/generate-result-sounds.mjs`.

## Prerecorded Narration (2026-10-20)

The 16 MP3 files in `narration/` were generated through the [MiniMax official TTS website](https://www.minimax.io/audio/text-to-speech) on 2026-10-19 and manually exported on 2026-10-20. Voice: **Serene Narrator - Deep,Resonant,Measured**, model `speech-2.8-hd`, speed `0.9`, pitch `0`. The recordings are already speed-adjusted; runtime playback uses the normal audio playback rate.

`src/shared/narration.ts` contains the fixed project scripts; `narration/manifest.json` records every published cue, measured duration, content hash and filename. One accidentally combined recording is excluded. The game serves only local static files, with no MiniMax SDK, API key, online TTS or voice cloning at runtime.

These recordings are not official Avalon audio and are not declared MIT or CC0 by this repository. The maintainer confirmed public distribution with this project on 2026-10-29; the file-specific inventory and scope are recorded in [narration/NOTICE.md](narration/NOTICE.md) and the review ledger. This does not establish unrestricted reuse rights for unrelated projects, commercial use or voice cloning. Provenance and update instructions are in [docs/media/narration.md](../../docs/media/narration.md).
