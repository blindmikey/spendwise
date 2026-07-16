// Print the hottest call paths (total time per node) from a V8 CPU profile.
import fs from 'node:fs';
const p = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

const byId = new Map(p.nodes.map((n) => [n.id, n]));
const selfUs = new Map();
let i = 0;
for (const s of p.samples) selfUs.set(s, (selfUs.get(s) || 0) + (p.timeDeltas[i++] || 0));

// total time = self + descendants
const totalUs = new Map();
const children = new Map(p.nodes.map((n) => [n.id, n.children || []]));
const order = []; // post-order
(function walk (id) {
    for (const c of children.get(id) || []) walk(c);
    order.push(id);
})(p.nodes[0].id);
for (const id of order) {
    let t = selfUs.get(id) || 0;
    for (const c of children.get(id) || []) t += totalUs.get(c) || 0;
    totalUs.set(id, t);
}

const label = (n) => {
    const f = n.callFrame;
    const url = (f.url || '').split('/').slice(-1)[0];
    return `${f.functionName || '(anon)'} @ ${url}:${f.lineNumber}`;
};

// walk down the hottest path, printing branches > 5% of root
function print (id, depth) {
    const n = byId.get(id);
    const t = totalUs.get(id) || 0;
    if (t < 50000 || depth > 24) return; // < 50ms pruned
    console.log(`${'  '.repeat(depth)}${Math.round(t / 1000)}ms (self ${Math.round((selfUs.get(id) || 0) / 1000)}ms) ${label(n)}`);
    const kids = (children.get(id) || []).map((c) => [c, totalUs.get(c) || 0]).sort((a, b) => b[1] - a[1]);
    for (const [c] of kids) print(c, depth + 1);
}
print(p.nodes[0].id, 0);
