// Identify hot minified frames: print columns + surrounding source text.
import fs from 'node:fs';
const p = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const src = fs.readFileSync(process.argv[3], 'utf8').split('\n');

const selfUs = new Map();
let i = 0;
for (const s of p.samples) selfUs.set(s, (selfUs.get(s) || 0) + (p.timeDeltas[i++] || 0));

const byId = new Map(p.nodes.map((n) => [n.id, n]));
const hot = [...selfUs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

for (const [id, us] of hot) {
    const f = byId.get(id).callFrame;
    if (!/alpine/.test(f.url)) { console.log(`${Math.round(us / 1000)}ms  ${f.functionName || '(anon)'} [not alpine]`); continue; }
    const line = src[f.lineNumber] || '';
    const snippet = line.slice(Math.max(0, f.columnNumber - 40), f.columnNumber + 260).replace(/\s+/g, ' ');
    console.log(`${Math.round(us / 1000)}ms  ${f.functionName || '(anon)'} L${f.lineNumber}:C${f.columnNumber}`);
    console.log(`   ...${snippet}...`);
    console.log('');
}
