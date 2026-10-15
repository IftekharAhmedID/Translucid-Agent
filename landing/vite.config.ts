import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://tailwindcss.com/docs/installation/using-vite
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  server: { proxy: { "/api": "http://localhost:8787" } },
  build: {
    rollupOptions: {
      output: { entryFileNames: "app.js", assetFileNames: asset => asset.names.some(name => name.endsWith(".css")) ? "style.css" : "[name][extname]" },
    },
  },
});
