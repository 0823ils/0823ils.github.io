# Modifications to the vendored paint editor

This directory is a locally modified fork of Scratch Paint 15.3.0
(upstream: https://github.com/scratchfoundation/scratch-paint).
The upstream paint editor is AGPL-3.0-only. This fork also contains code
adapted from GPL-3.0 projects, as identified below.

The GPL-3.0 portions remain under GPL-3.0. The combined application is
distributed under AGPL-3.0-only; GPLv3 section 13 permits combination with
AGPLv3, subject to the applicable source and notice requirements. The full
GPL-3.0 text is included as `LICENSE-GPL-3.0` in this directory and at the
repository root. The upstream AGPL text is included as `LICENSE`.

Modification date: 2026-11-11.

## Adapted or added areas

- Rounded-rectangle tool and its mode UI:
  `helper/tools/rect-tool.js`, `helper/tools/rounded-rect-tool.js`, related
  mode containers.
- TurboWarp-style color picker and opacity UI:
  `containers/color-picker.jsx`, `components/color-picker/*`.
- Theme/canvas behavior: `helper/layer.js`.
- Pen, Shapes/Stamp, boolean operations, alignment, stroke controls:
  `helper/tools/pen-tool.js`, `helper/tools/sussy-tool.js`,
  `containers/mode-tools.jsx`, `components/mode-tools/mode-tools.jsx`.
- Snap behavior informed by Scratch Addons `paint-snap` (independently
  implemented; no addon source is bundled).
- SVG/raster import normalization inspired by Scratch Addons
  `better-img-uploads` and `fix-uploaded-svgs` (see `src/lib/files.js`).
- Additional local changes for Costume Studio: text-to-path handling,
  text-on-path snapping and detachment (`helper/path-text.js` and the
  move-tool integration), size snapping while scaling
  (`helper/selection-tools/scale-snap.js`), corner rounding handles in
  Reshape mode (`helper/selection-tools/round-corners.js`), object effects
  (blur/shadow/glow via canvas and SVG filters, using the standard Scratch
  color picker), a multi-stop advanced gradient editor available from the
  fill/stroke color pickers, logical layers with active-layer editing,
  per-layer visibility, opaque/translucent/hidden inactive-layer display,
  hover highlighting, drag-to-reorder layers, delete confirmation with
  contents removal, undoable layer deletion, and SVG layer metadata, a combined
  polygon/rectangle drawing tool with side count, star ratio, rounded
  corners, and Shift-regular polygons, editor range/stage options, stroke
  toggling,
  keyboard shortcuts, custom fonts, color history, and the color palette
  panel.

This is a provenance summary, not a verified line-by-line inventory. Review
the linked upstream projects and the repository history before redistributing
or preparing a public release.

## Upstream sources

- Scratch Paint: https://github.com/scratchfoundation/scratch-paint
- TurboWarp scratch-paint (GPL-3.0): https://github.com/TurboWarp/scratch-paint
- PenguinMod Paint (GPL-3.0): https://github.com/PenguinMod/PenguinMod-Paint
- Scratch Addons (GPL-3.0): https://github.com/ScratchAddons/ScratchAddons
- Scratch Addons paint-snap:
  https://github.com/ScratchAddons/ScratchAddons/tree/master/addons/paint-snap
