/**
 * Fold the built app into one self-contained HTML file.
 *
 * The published page has no server of its own and cannot load anything from a
 * third-party host, so the stylesheet and the whole JavaScript bundle — Three.js
 * and the Z-machine included — are inlined. The result is a single file that
 * runs from a `file://` URL, an artifact host, or anywhere else that will serve
 * one page.
 *
 * What is deliberately *not* inlined is the story file. It is Infocom's, and
 * publishing a page is distribution; the player supplies their own copy at the
 * title screen and it never leaves their browser.
 *
 * The output omits the doctype and the html/head/body wrapper, because the
 * artifact host supplies those. Run `vite build` first.
 *
 *   node scripts/build-artifact.mjs [outfile]
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'dist');
const outFile = process.argv[2] ?? join(root, 'dist', 'zork-standalone.html');

const assets = readdirSync(join(dist, 'assets'));
const jsName = assets.find((f) => f.endsWith('.js'));
const cssName = assets.find((f) => f.endsWith('.css'));
if (!jsName || !cssName) {
  throw new Error('No built assets found. Run `vite build` first.');
}

const js = readFileSync(join(dist, 'assets', jsName), 'utf8');
const css = readFileSync(join(dist, 'assets', cssName), 'utf8');

// Take the markup from the source document rather than the built one, so the
// asset <link> and <script> tags do not have to be stripped back out.
const source = readFileSync(join(root, 'index.html'), 'utf8');
const bodyMatch = /<body>([\s\S]*?)<\/body>/.exec(source);
if (!bodyMatch) throw new Error('Could not find a <body> in index.html.');

const body = bodyMatch[1]
  // The stylesheet and the module script are inlined below instead.
  .replace(/<link rel="stylesheet"[^>]*>/g, '')
  .replace(/<script type="module"[^>]*><\/script>/g, '')
  .trim();

/**
 * `</script>` anywhere inside the bundle would close the tag early.
 *
 * Splitting the sequence is the standard escape and is safe because the
 * JavaScript string `"<\/script>"` is identical to `"</script>"`.
 */
const safeJs = js.replace(/<\/script>/gi, '<\\/script>');

const page = `<title>Zork I: The Great Underground Empire</title>
<style>
${css}
</style>

${body}

<script type="module">
${safeJs}
</script>
`;

writeFileSync(outFile, page, 'utf8');

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`wrote ${outFile}`);
console.log(`  markup ${kb(body.length)} · styles ${kb(css.length)} · script ${kb(safeJs.length)}`);
console.log(`  total  ${kb(page.length)}`);
