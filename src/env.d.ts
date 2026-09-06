// Vite resolves a bare CSS import at build time. Declaring it here rather than
// pulling in vite/client, whose ImportMeta types conflict with bun's.
declare module "*.css";
