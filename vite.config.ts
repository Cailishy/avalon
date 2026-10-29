import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    license: { fileName: "assets/third-party-licenses.txt" },
    rollupOptions: {
      input: { game: "index.html", access: "access.html" },
      output: { postBanner: "/*! Third-party licenses: /assets/third-party-licenses.txt */" },
    },
  },
});
