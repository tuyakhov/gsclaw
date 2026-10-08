// Vercel Function entrypoint. `pnpm build` (Vercel's build command) produces dist/ first; Vercel
// then bundles this file and everything it imports. vercel.json rewrites all paths here.
export { default } from '../dist/adapters/vercel.js';
