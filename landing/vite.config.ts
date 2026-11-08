import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { benchmarkPageMeta } from "./lib/benchmarks";

// https://tailwindcss.com/docs/installation/using-vite
export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: "benchmark-pages",
    apply: "build",
    async writeBundle(_options, bundle) {
      const index = bundle["index.html"];
      if (!index || index.type !== "asset") throw new Error("Missing landing HTML.");
      const html = typeof index.source === "string" ? index.source : new TextDecoder().decode(index.source);
      for (const [kind, meta] of Object.entries(benchmarkPageMeta)) {
        const directory = fileURLToPath(new URL(`./dist/benchmarks/${kind}/`, import.meta.url));
        const url = `https://tracedog.co/benchmarks/${kind}/`;
        const page = html.replace(/<title>[^<]*<\/title>/, `<title>${meta.title}</title>`)
          .replace(/(<meta name="description" content=")[^"]*/, `$1${meta.description}`)
          .replace(/(<meta property="og:title" content=")[^"]*/, `$1${meta.title}`)
          .replace(/(<meta property="og:description" content=")[^"]*/, `$1${meta.description}`)
          .replace(/(<meta property="og:url" content=")[^"]*/, `$1${url}`)
          .replace(/(<link rel="canonical" href=")[^"]*/, `$1${url}`)
          .replace(/<div id="root">[\s\S]*?<\/div>/, `<div id="root"><main><h1>${meta.title}</h1><p>${meta.description}</p><p>TraceDog evaluation results. Supporting run reports pending publication.</p><a href="/">TraceDog</a></main></div>`);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "index.html"), page);
      }
    },
  }],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  server: { proxy: { "/api": "http://localhost:8787" } },
  build: {
    rollupOptions: {
      output: { entryFileNames: "app.js", assetFileNames: asset => asset.names.some(name => name.endsWith(".css")) ? "style.css" : "[name][extname]" },
    },
  },
});
