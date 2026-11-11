#include <cstdint>
#include <emscripten/emscripten.h>

// Stable ABI marker for the browser host. The runtime is intentionally small
// until the Scratch-compatible execution model and its tests are implemented.
extern "C" {
EMSCRIPTEN_KEEPALIVE
std::uint32_t sb3cpp_runtime_abi() {
    return 1;
}

EMSCRIPTEN_KEEPALIVE
const char* sb3cpp_runtime_name() {
    return "SB3 C++ Runtime";
}
}
