import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const minify = process.argv.includes("--minify");

/** Extension host bundle: Node platform, vscode kept external. */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  // "vscode" is provided by the host; "fsevents" is an optional native module
  // chokidar loads lazily on macOS — keep it external so no .node binary is
  // bundled. chokidar falls back to fs.watch when it isn't resolvable.
  external: ["vscode", "fsevents"],
  sourcemap: !minify,
  minify,
  logLevel: "info",
};

/** Webview bundle: browser platform, Chart.js bundled in (no CDN, CSP-safe). */
const webviewConfig = {
  entryPoints: ["src/webview/dashboard.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  sourcemap: !minify,
  minify,
  logLevel: "info",
};

if (watch) {
  const c1 = await esbuild.context(extensionConfig);
  const c2 = await esbuild.context(webviewConfig);
  await Promise.all([c1.watch(), c2.watch()]);
  console.log("esbuild watching...");
} else {
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
}
