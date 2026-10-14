import { build, context } from 'esbuild';
const options = {
  entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian'],
  format: 'cjs', target: 'es2020', platform: 'browser', outfile: 'main.js',
  banner: { js: '/* Memos Sync — MIT license. Generated from src/main.ts. */' },
  sourcemap: false, minify: false, logLevel: 'info'
};
if (process.argv.includes('--watch')) await (await context(options)).watch();
else await build(options);
