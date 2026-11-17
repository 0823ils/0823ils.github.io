/**
 * Measures SVG bounding boxes with `getBBox()` inside a sandboxed iframe.
 *
 * Scratch 2 SVGs have unreliable `width`/`height`/`viewBox`, so the real drawn
 * size has to be measured by putting the SVG in a live document. That is unsafe
 * in the editor's own document, so it happens in the frame instead.
 *
 * The Scratch font CSS is sent as init data rather than written into this file,
 * so the file can be served as a static asset.
 *
 * Untranspiled, so capped at ES2017.
 */
(function () {
  // Replaced by onSandboxInit; text measures wrong until fonts have decoded.
  var fontsReady = Promise.resolve();
  window.onSandboxInit = function (fontCSS) {
    var style = document.createElement('style');
    style.textContent = fontCSS;
    document.head.appendChild(style);

    // data: URIs mean no network wait, but decoding must finish before
    // getBBox is accurate for text.
    var fontPromises = [];
    document.fonts.forEach(function (font) {
      // Not every font is used by every SVG; one bad face must not fail all.
      fontPromises.push(font.load()["catch"](function () {}));
    });
    fontsReady = Promise.all(fontPromises);
  };
  var measureSvg = function measureSvg(svgString) {
    var container = document.createElement('span');
    try {
      container.innerHTML = svgString;
      document.body.appendChild(container);
      var svgEl = container.children[0];
      if (!svgEl || typeof svgEl.getBBox !== 'function') {
        throw new Error('SVG element not found or does not support getBBox');
      }
      var bbox = svgEl.getBBox();
      return {
        x: bbox.x,
        y: bbox.y,
        width: bbox.width,
        height: bbox.height
      };
    } finally {
      if (container.parentNode) {
        container.parentNode.removeChild(container);
      }
    }
  };
  window.onSandboxMessage = function (payload) {
    var isBatch = Array.isArray(payload);
    var items = isBatch ? payload : [payload];
    return fontsReady.then(function () {
      var results = items.map(measureSvg);
      return isBatch ? results : results[0];
    });
  };
})();