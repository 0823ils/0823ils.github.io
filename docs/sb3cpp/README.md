# SB3 → C++ / WebAssembly

Browser-based toolchain prototype for Scratch 3.0 projects.

## Current status

**Phase 1: SB3 inspection prototype**

- Loads a local `.sb3` ZIP file in the browser.
- Parses `project.json`.
- Counts targets, blocks, top-level scripts, variables/lists and bundled assets.
- Lists opcodes used by the project.
- Exports a JSON analysis report.
- Does not upload the selected project.

This is deliberately not advertised as a complete converter yet. A faithful converter must reproduce Scratch VM scheduling, threads, clone lifecycle, casts, broadcasts, rendering, audio, input, extensions and browser APIs. Unsupported behavior must be detected rather than silently omitted.

## Target architecture

- C++ runtime compiled to WebAssembly with Emscripten.
- Browser host layer for DOM, input devices, audio and browser-only APIs.
- Scratch-compatible project loader and intermediate representation.
- Renderer/audio backends and extension adapters.
- Cross-platform browser delivery: the same web build runs on macOS and Windows.

## Development

Open `index.html` through a local web server or GitHub Pages. JSZip is loaded from jsDelivr. The selected SB3 is processed locally in the browser.

## Roadmap

1. Build a test corpus and opcode compatibility inventory.
2. Define Scratch-compatible values, lists, variables and thread scheduling.
3. Implement and test C++ runtime primitives.
4. Add C++ expression and statement lowering with explicit unsupported-opcode diagnostics.
5. Implement rendering, audio, clones, broadcasts, extensions and browser integrations.
6. Compile the runtime with Emscripten and run differential tests against Scratch VM.

"All Scratch projects" is the compatibility goal, not a claim about this prototype's current support.
