// Builds network.html into one self-contained page (inline JS and CSS) that can be opened anywhere,
// e.g. published as a claude.ai artifact to try on a phone.
// Usage: node scripts/bundle-network.mjs [outFile]
import { build } from 'vite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outFile = process.argv[2] ?? 'dist-network/get-example-com.html';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'net-'));
await build({
  logLevel: 'warn',
  build: { outDir: tmp, emptyOutDir: true, modulePreload: false, assetsInlineLimit: 1e9, rollupOptions: { input: 'network.html' } },
});

const html = fs.readFileSync(path.join(tmp, 'network.html'), 'utf8');
const read = (href) => fs.readFileSync(path.join(tmp, href.replace(/^\.?\//, '')), 'utf8');
const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => read(m[1])).join('\n');
const js = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)].map((m) => read(m[1])).join('\n');
const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? 'Get example.com';

// No doctype/html/head/body: the artifact host wraps the page in its own skeleton.
const page = `<title>${title}</title>
<style>
${css}
</style>
<div id="app"></div>
<script type="module">
${js.replace(/<\/script/gi, '<\\/script')}
</script>
`;
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, page);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${outFile}: ${(page.length / 1024).toFixed(0)} KB`);
