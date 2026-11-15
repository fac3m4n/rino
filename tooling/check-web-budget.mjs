/** Check compressed production JavaScript, including static imports, per entry. */
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const dist = new URL("../apps/web/dist/", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL(".vite/manifest.json", dist), "utf8"),
);
function graph(key, found = new Set()) {
  if (found.has(key)) return found;
  const chunk = manifest[key];
  if (!chunk) throw new Error(`Missing build manifest entry: ${key}`);
  found.add(key);
  for (const dependency of chunk.imports ?? []) graph(dependency, found);
  return found;
}
async function compressed(keys) {
  const files = new Set([...keys].map((key) => manifest[key].file));
  let bytes = 0;
  for (const file of files) {
    if (file.endsWith(".js"))
      bytes += gzipSync(await readFile(new URL(file, dist))).byteLength;
  }
  return bytes / 1024;
}
let failed = false;
const report = [];
for (const [entry, budget] of [
  ["index.html", 30],
  ["app.html", 200],
]) {
  if (!manifest[entry]?.isEntry) throw new Error(`Missing page: ${entry}`);
  const initial = graph(entry);
  const kb = await compressed(initial);
  report.push({ page: entry, group: "initial", kb: +kb.toFixed(2), budget });
  if (kb > budget) failed = true;
  const visited = new Set(initial);
  const queue = [...initial];
  for (const key of queue) {
    for (const lazy of manifest[key].dynamicImports ?? []) {
      if (visited.has(lazy)) continue;
      const chunks = graph(lazy);
      const additional = new Set([...chunks].filter((k) => !initial.has(k)));
      const kb = await compressed(additional);
      report.push({ page: entry, group: lazy, kb: +kb.toFixed(2), budget: 80 });
      if (kb > 80) failed = true;
      for (const chunk of chunks) {
        if (!visited.has(chunk)) {
          visited.add(chunk);
          queue.push(chunk);
        }
      }
    }
  }
}
console.table(report);
if (failed) throw new Error("Production JavaScript exceeds the route budget.");
