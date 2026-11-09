#!/usr/bin/env node
// Wrap the ESM client source in DSH's browser module-loader envelope.
//
// DSH client plugins are not loaded as native ES modules: the renderer calls
// `window.__ModuleLoader__.load({ id, factory })` and expects the factory to
// return a CommonJS-style `module.exports`.  Keeping the source as ESM makes it
// readable and testable under Node; this script produces the bundle the DSH
// renderer actually consumes.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('..', import.meta.url)
const sourcePath = new URL('src/client.js', root)
const outputPath = new URL('lib/client.js', root)

let source = await readFile(sourcePath, 'utf8')
source = source
  .replace(/^export const inject/m, 'const inject')
  .replace(/^export function apply/m, 'function apply')

if (/^\s*export\s/m.test(source)) {
  throw new Error('src/client.js still contains an export statement the wrapper does not understand')
}

const indent = (text) => text.split('\n').map((line) => (line ? `\t${line}` : '')).join('\n')

const bundle = `window.__ModuleLoader__.load({
\tid: "dsh-sidebar-browser-control",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;

${indent(source)}

\t\texports.apply = apply;
\t\texports.inject = inject;
\t\treturn module.exports;
\t}
});
`

await writeFile(outputPath, bundle)
console.log(`wrote ${fileURLToPath(outputPath)} (${bundle.length} bytes)`)
