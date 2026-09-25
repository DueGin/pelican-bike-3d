// 构建：npm i three@0.186.0 esbuild，然后 node build.mjs --min，生成单文件离线 HTML
import * as esbuild from 'esbuild';
import fs from 'fs';
const SRC = process.env.SRC || new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const OUT = process.env.OUT || SRC + '/../pelican-on-a-bike.html';
const r = await esbuild.build({
  entryPoints: [SRC + '/main.js'], bundle: true, format: 'iife', minify: process.argv.includes('--min'), target: 'es2020',
  write: false, legalComments: 'none', logLevel: 'warning',
});
let js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const tpl = fs.readFileSync(SRC + '/template.html', 'utf8');
const html = tpl.split('/*__BUNDLE__*/').join(js);
fs.writeFileSync(OUT, html);
console.log('ok', (html.length / 1024).toFixed(0) + ' KB');
