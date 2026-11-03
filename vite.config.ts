import { defineConfig } from "vite";

// Every supported browser reads woff2, so Fontsource's woff fallbacks would only bloat dist.
const dropWoffFallbacks = {
  postcssPlugin: "drop-woff-fallbacks",
  Declaration: {
    src(decl: { value: string }) {
      decl.value = decl.value.replace(/,\s*url\([^)]*\.woff\)\s*format\(["']woff["']\)/g, "");
    },
  },
};

export default defineConfig({
  css: { postcss: { plugins: [dropWoffFallbacks] } },
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // CSP has no font-src data:, so font slices must stay as same-origin files.
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
    license: { fileName: "assets/third-party-licenses.txt" },
    rollupOptions: {
      input: { game: "index.html", access: "access.html" },
      output: { postBanner: "/*! Third-party licenses: /assets/third-party-licenses.txt */" },
    },
  },
});
