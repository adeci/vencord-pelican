import React from "react";
// This fixture deliberately has no native adapter: use Vesktop's real preload.
async function start() {
  const native = window.VencordNative?.pluginHelpers?.Pelican;
  for (const method of [
    "beginUpload",
    "uploadChunk",
    "status",
    "cancel",
    "dismiss",
  ]) {
    if (typeof native?.[method] !== "function")
      throw new Error(
        `Packaged VencordNative.pluginHelpers.Pelican.${method} is missing`,
      );
  }
  // Keep real settings persistence even when the explicit missing-helper
  // scenario hides Pelican. This VM uses only a disposable Vencord profile.
  window.fixtureNative = new URL(location.href).searchParams.has(
    "missing-native",
  )
    ? { ...window.VencordNative, pluginHelpers: {} }
    : window.VencordNative;
  window.Vencord = { Webpack: { Common: { React } } };
  // Intentionally test the preload boundary before evaluating the production plugin.
  await import("./host");
}
start().catch((error) => {
  window.fixtureError = String(error);
  document.getElementById("root")!.textContent = String(error);
});
