// Builds index.html into one self-contained page (inline JS and CSS) that can be opened anywhere,
// e.g. published as a claude.ai artifact to try on a phone.
// Usage: node scripts/bundle.mjs [outFile] [--whole]
import { build } from 'vite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outFile = process.argv[2] ?? 'dist-bundle/connection-lab.html';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'net-'));
await build({
  logLevel: 'warn',
  build: { outDir: tmp, emptyOutDir: true, modulePreload: false, assetsInlineLimit: 1e9, rollupOptions: { input: 'index.html' } },
});

const html = fs.readFileSync(path.join(tmp, 'index.html'), 'utf8');
const read = (href) => fs.readFileSync(path.join(tmp, href.replace(/^\.?\//, '')), 'utf8');
const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => read(m[1])).join('\n');
const js = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)].map((m) => read(m[1])).join('\n');
const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? 'Connection Lab';

const viewport = /<meta name="viewport"[^>]*>/.exec(html)?.[0] ?? '<meta name="viewport" content="width=device-width, initial-scale=1.0" />';

// No doctype/html/head/body: the artifact host wraps the page in its own skeleton.
// The viewport stays: without it a phone lays the page out 980 px wide and shrinks it.
const page = `<title>${title}</title>
${viewport}
<style>
${css}
</style>
<div id="app"></div>
<script type="module">
${js.replace(/<\/script/gi, '<\\/script')}
</script>
`;
// A real web host adds nothing: `--whole` keeps the document as it is, with the styles and script written into it.
const whole = html
  .replace(/<link rel="stylesheet"[^>]*>\s*/g, '')
  .replace(/(<link rel="icon"[^>]*href=")([^"]+)/, (_, start, href) => `${start}data:image/png;base64,${fs.readFileSync(path.join(tmp, href.replace(/^\.?\//, ''))).toString('base64')}`)
  .replace(/<script type="module"[^>]*><\/script>\s*/g, '')
  .replace('</head>', () => `<style>
${css}
</style>
</head>`)
  .replace('</body>', () => `<script type="module">
${js.replace(/<\/script/gi, '<\\/script')}
</script>
</body>`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, process.argv.includes('--whole') ? whole : page);
// The real site also serves the photo the photo card fetches, so that it can be captured from there.
if (process.argv.includes('--whole')) fs.copyFileSync('site/cat.jpg', path.join(path.dirname(outFile), 'cat.jpg'));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${outFile}: ${(page.length / 1024).toFixed(0)} KB`);
