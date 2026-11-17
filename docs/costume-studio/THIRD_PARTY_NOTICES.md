# Third-party notices

Costume Studio distributes browser bundles containing JavaScript, font data and
other production dependencies. Direct dependency versions below are from
`package.json`; transitive versions come from `package-lock.json` and may vary
within declared ranges. Package license texts are in the corresponding npm
packages after `npm install`.

## Direct runtime dependencies

| Package | Version | License | Upstream |
| --- | --- | --- | --- |
| `@scratch/scratch-paint` (local fork: `src/vendor/scratch-paint/`) | 15.3.0 | AGPL-3.0-only | https://github.com/scratchfoundation/scratch-paint |
| `@scratch/scratch-svg-renderer` | 15.3.0 | AGPL-3.0-only | https://github.com/scratchfoundation/scratch-svg-renderer |
| `scratch-l10n` | 6.1.136 | AGPL-3.0-only | https://github.com/scratchfoundation/scratch-l10n |
| `@scratch/paper` (Paper.js) | 0.11.20221201200345 | MIT | https://github.com/scratchfoundation/paper.js |
| React / React DOM | 18.3.1 | MIT | https://github.com/facebook/react |
| Redux / React Redux | 4.2.1 / 8.1.3 | MIT | https://github.com/reduxjs/redux |
| `react-intl` | 6.8.9 | BSD-3-Clause | https://github.com/formatjs/formatjs |
| `react-intl-redux` | 2.4.1 | MIT | https://github.com/ratson/react-intl-redux |
| `react-popover` | 0.5.10 | MIT | https://github.com/littlebits/react-popover |
| `react-responsive` | 9.0.2 | MIT | https://github.com/contra/react-responsive |
| `react-style-proptype` | 3.2.2 | MIT | https://github.com/brigand/react-style-proptype |
| `react-tooltip` | 4.5.1 | MIT | https://github.com/wwayne/react-tooltip |
| CodeMirror 6 packages and `@lezer/highlight` | see `package.json` / lockfile | MIT | https://codemirror.net/ |
| `opentype.js` (font parsing for imported fonts) | 2.0.0 | MIT | https://github.com/opentypejs/opentype.js |
| `fontkit` (font outline extraction for imported fonts) | 2.0.4 | MIT | https://github.com/foliojs/fontkit |
| `classnames`, `keymirror`, `lodash.bindall`, `lodash.omit`, `parse-color`, `prop-types`, `process` | see lockfile | MIT / Apache-2.0 | see package metadata |

The editor, renderer, and localization packages above are AGPL-3.0-only. The
locally modified paint editor is vendored in `src/vendor/scratch-paint/`; the
complete corresponding project source and modifications are available here.
The project is distributed under AGPL-3.0-only as a whole. See `LICENSE` and
`NOTICE`.

## Font assets

Bundled font copyrights (also recorded in [`OFL.txt`](OFL.txt)):

- Noto Sans Medium — Copyright 2015 Google Inc. All Rights Reserved.
- Source Serif Pro — Copyright 2014, 2015, 2016 Adobe Systems Incorporated.
- Handlee — Copyright (c) 2011, Admix Designs.

`scratch-render-fonts@1.0.256` is an Apache-2.0 package, but individual font
files have separate terms. This app uses a local browser-safe subset rather than
bundling all assets from the package:

- Noto Sans Medium, Source Serif Pro, and Handlee carry SIL Open Font License
  1.1 metadata and are bundled. The package's `OFL.txt` is included here as
  [`OFL.txt`](OFL.txt). Knewave and Griffy are excluded pending confirmation of
  their exact license text.
- `Grand9K-Pixel.ttf` contains copyright metadata for 2009–2013 Grand Chaos
  Productions, credits Jayvee D. Enaguas (Grand Chaos), and embeds a URL to CC
  BY-SA 3.0. This app excludes it because the project does not carry a verified
  copy of that license's full legal code. The `Pixel` family currently falls
  back to Sans Serif. [`Grand9K-Pixel-ATTRIBUTION.md`](Grand9K-Pixel-ATTRIBUTION.md)
  records the asset's attribution and authoritative license URL, but is not the
  full license text.
- `Scratch.ttf` is **excluded**. The upstream maintainers state they may use this
  font but may not redistribute it: https://github.com/scratchfoundation/scratch-render-fonts/issues/23
  The legacy font-family name falls back to Sans Serif in this app's font inliner.
- `Knewave.ttf` and `Griffy-Regular.ttf` name OFL in their font metadata, but
  the exact package OFL file concerns Londrina and has not been verified as the
  license text for these fonts. They are therefore excluded from this app's
  shipped font subset too; the legacy `Marker` and `Curly` families fall back
  to Sans Serif. The package's Noto Sans, Source Serif Pro, and Handlee assets
  identify SIL OFL 1.1 in font metadata; `OFL.txt` is included for them.

The precise font provenance and metadata are recorded in
[`scratch-render-fonts-PROVENANCE.md`](scratch-render-fonts-PROVENANCE.md).

A generated `THIRD_PARTY_LICENSES.txt` is copied into the browser distribution
(`dist/THIRD_PARTY_LICENSES.txt`) during `npm run build`; it contains the
license texts for the installed production packages.
Font licenses govern font software, not documents created using fonts.

## Transitive runtime dependencies

The production dependency tree contains additional packages, including FormatJS,
CodeMirror/Lezer support packages, DOMPurify, SVGO, CSS parsers and general
utilities. Their exact versions and package license metadata are listed in
`package-lock.json` and the installed package manifests. The tree includes
permissive licenses including MIT, ISC, BSD variants, Apache-2.0, 0BSD, CC0-1.0,
CC BY-4.0, BlueOak-1.0.0, and MPL-2.0-or-Apache-2.0. Inspect a full dependency
tree with `npm ls --all`; package-specific notices accompany the npm packages.
`color-convert@0.5.3` does not declare a `license` field in its manifest, but its
included `LICENSE` file grants the MIT license.

## Referenced external projects and code provenance

Some features were independently implemented after studying other projects;
other parts of the vendored paint fork were adapted from or incorporate code
from upstream forks/add-ons. GPL-3.0 code remains subject to its original
license when combined with AGPL-3.0 code. GPLv3 §13 permits combination with
AGPLv3, while AGPL's network source requirement applies to the combined work.
This project includes [`LICENSE-GPL-3.0`](LICENSE-GPL-3.0) for third-party
GPL-3.0 code incorporated or adapted in the vendored fork. The vendored fork
also contains a GPL-3.0 copy and a modification/provenance summary at
[`src/vendor/scratch-paint/MODIFICATIONS.md`](src/vendor/scratch-paint/MODIFICATIONS.md).
File-level origin notes are present where known, but are not yet a complete
per-file inventory; review the listed upstream projects and source history when
redistributing.
Relevant sources:

- TurboWarp `scratch-paint` (GPL-3.0):
  https://github.com/TurboWarp/scratch-paint
- PenguinMod Paint, a TurboWarp paint fork (GPL-3.0):
  https://github.com/PenguinMod/PenguinMod-Paint
- Scratch Addons `paint-snap` (GPL-3.0):
  https://github.com/ScratchAddons/ScratchAddons/tree/master/addons/paint-snap
- Scratch Addons `better-img-uploads` and `fix-uploaded-svgs` (GPL-3.0):
  https://github.com/ScratchAddons/ScratchAddons

The handover record (`docs/HANDOVER.md`, §5.1 and §5.4) identifies these
adapted areas in the local fork: rounded rectangles (`helper/tools/rect-tool.js`,
`rounded-rect-tool.js`, their mode containers); TurboWarp color picker and
opacity (`containers/color-picker.jsx`, `components/color-picker/*`); theme
behavior (`helper/layer.js`); PenguinMod Pen, Sussy, Boolean, alignment and
stroke controls (`helper/tools/pen-tool.js`, `sussy-tool.js`,
`containers/mode-tools.jsx`, `components/mode-tools/mode-tools.jsx`); and
Scratch Addons-inspired raster upload / SVG normalization behavior
(`src/lib/files.js`). These are provenance statements from the project handover,
not a verified line-by-line diff against upstream. Independently implemented
behavior informed by paint-snap is documented in `helper/selection-tools/move-tool.js`;
no paint-snap source is bundled. The full Scratch Addons project is not a runtime
dependency.
