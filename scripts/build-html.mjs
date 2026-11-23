/**
 * Bundles src/ui.ts into a single inline script and injects it into the HTML
 * shell, producing the shipped index.html (everything inlined; the iframe is
 * served only this file).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/ui.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outfile: 'dist/ui.js',
  sourcemap: false,
  logLevel: 'info',
});

// `<\/script` inside a string is a no-op for JS but keeps the inline script
// from closing its own tag.
const js = readFileSync('dist/ui.js', 'utf8').replaceAll('</script', '<\\/script');
const template = readFileSync('src/index.template.html', 'utf8');
if (!template.includes('<!--APP_SCRIPT-->')) {
  throw new Error('index.template.html is missing the <!--APP_SCRIPT--> placeholder');
}
writeFileSync('index.html', template.replace('<!--APP_SCRIPT-->', `<script>\n${js}\n</script>`));
console.log('wrote index.html');
