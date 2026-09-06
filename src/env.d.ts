// Vite resolves a bare CSS import at build time. Declared here rather than
// pulling in vite/client, whose ImportMeta types conflict with bun's.
declare module "*.css";

interface ImportMeta {
  readonly env: {
    readonly DEV: boolean;
    readonly PROD: boolean;
  };
}
