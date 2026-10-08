// Netlify Function entrypoint. `pnpm build` (netlify.toml) produces dist/ before Netlify bundles
// functions. Static files in the publish directory win (preferStatic); everything else lands here.
import { netlifyFetch } from '../../dist/adapters/netlify.js';

export default netlifyFetch;

export const config = {
  path: '/*',
  preferStatic: true,
};
