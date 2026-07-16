// Summarize a V8 CPU profile: top functions by self time.
import fs from 'node:fs';
const p = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

const totalUs = p.timeDeltas.reduce((a, b) => a + b, 0);
const selfUs = new Map(); // nodeId → us
const byId = new Map(p.nodes.map((n) => [n.id, n]));

let i = 0;
for (const sample of p.samples) {
    selfUs.set(sample, (selfUs.get(sample) || 0) + (p.timeDeltas[i++] || 0));
}

const agg = new Map(); // label → us
for (const [id, us] of selfUs) {
    const n = byId.get(id);
    if (!n) continue;
    const f = n.callFrame;
    const url = (f.url || '').split('/').slice(-1)[0];
    const label = `${f.functionName || '(anon)'} @ ${url}:${f.lineNumber}`;
    agg.set(label, (agg.get(label) || 0) + us);
}

const top = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log(`total sampled: ${Math.round(totalUs / 1000)}ms`);
for (const [label, us] of top) {
    console.log(`${String(Math.round(us / 1000)).padStart(6)}ms  ${label}`);
}
