import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173 },
  build: { target: "es2022" },
  // CI stamps the run number in; locally there is none, which reads as 0 —
  // and 0 means "do not offer updates", so a laptop native build never nags.
  define: {
    __APP_VERSION_CODE__: JSON.stringify(process.env.GITHUB_RUN_NUMBER ?? "0"),
  },
});
