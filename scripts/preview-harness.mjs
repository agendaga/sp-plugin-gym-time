/**
 * Builds a local preview harness: the real index.html shell plus a fake
 * in-memory PluginAPI and the bundled UI. Writes to /tmp/opencode so the
 * shipped plugin folder stays clean.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/ui.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outfile: '/tmp/opencode/fitness-harness-ui.js',
  sourcemap: false,
  logLevel: 'warning',
});

const stub = `<script>
window.__snacks = [];
window.PluginAPI = {
  Hooks: { PERSISTED_DATA_CHANGED: 'persistedDataChanged' },
  __mem: {},
  async listSyncedDataKeys() { return Object.keys(this.__mem).filter((k) => this.__mem[k] !== ''); },
  async loadSyncedData(k) { return this.__mem[k] ?? null; },
  async persistDataSynced(str, key) { this.__mem[key ?? 'legacy'] = str; },
  async getDayContext() { return { todayStr: new Date().toISOString().slice(0, 10), startOfNextDayDiffMs: 0 }; },
  showSnack(cfg) { window.__snacks.push(cfg); },
  async openDialog(cfg) { return cfg.buttons?.[cfg.buttons.length - 1]?.label; },
  registerHook() {},
  onReady(fn) { queueMicrotask(fn); },
};
</script>`;

const ui = readFileSync('/tmp/opencode/fitness-harness-ui.js', 'utf8').replaceAll('</script', '<\\/script');
const template = readFileSync('src/index.template.html', 'utf8');
const html = template.replace('<!--APP_SCRIPT-->', `${stub}\n<script>\n${ui}\n</script>`);
writeFileSync('/tmp/opencode/fitness-preview.html', html);
console.log('wrote /tmp/opencode/fitness-preview.html');
