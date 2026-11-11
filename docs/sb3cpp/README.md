# SB3 → C++ / WebAssembly

Scratch 3.0 project loader and an incremental C++ execution runtime, delivered as a browser app.

## Run it

1. Open the tool through a local HTTP server or the deployed GitHub Pages URL. Do not open the HTML as a `file://` URL.
2. Select an `.sb3` file or load a shared Scratch project URL/ID.
3. Wait for the C++ / WASM runtime to load, then press **C++で実行**.

The WASM runtime is built by the GitHub Actions workflow and committed to `docs/sb3cpp/build/`. The same browser build works on macOS and Windows. A local build requires Emscripten 3.1.64.

## Current execution support

The C++ runtime currently executes the following simple, straight-line commands inside `event_whenflagclicked` scripts:

- Motion: move steps, turn left/right, set/change x/y, go to x/y, point in direction.
- Looks: say, show/hide, set/change size.
- Initial sprite position, direction, size and visibility are loaded from the SB3 project.
- The first costume image for each sprite is drawn by the browser host after C++ execution.

Control-flow blocks (wait/repeat/forever/if), variable and list reporters, broadcasts, clones, pen, sound, sensing, extensions, costume switching, backdrop switching, and most other Scratch VM behavior are not implemented yet. Unsupported blocks are counted and reported; they are not silently claimed as executed. The current execution model runs each sprite's green-flag command chain sequentially and is not yet Scratch VM thread scheduling.

## Architecture

- JavaScript reads the SB3 ZIP and lowers a supported subset of block chains to a compact command ABI.
- C++ executes those commands and owns the resulting sprite state.
- Emscripten compiles the C++ runtime to WebAssembly.
- JavaScript handles browser-only ZIP loading and canvas drawing.

This is an incremental runtime, not a complete Scratch-to-C++ compiler. "All Scratch projects" remains the compatibility goal, not the current support level.

## Tests

The GitHub Actions build runs a native C++ command-state test before compiling the WASM runtime.
