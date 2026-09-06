// Vite resolves a bare CSS import at build time. Declared here rather than
// pulling in vite/client, whose ImportMeta types conflict with bun's.
//
// import.meta.env itself needs no declaration: @types/bun already provides it.
// Vite substitutes DEV and PROD at build time; under `bun test` nothing does, so
// they read as undefined, which is the behaviour the guards want anyway.
declare module "*.css";
