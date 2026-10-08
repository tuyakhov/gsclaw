import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    'adapters/node-http': 'src/adapters/node-http.ts',
    'adapters/stdio': 'src/adapters/stdio.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: true,
  fixedExtension: false,
});
