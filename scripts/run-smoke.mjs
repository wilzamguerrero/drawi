/**
 * Corredor de las pruebas de humo.
 *
 * Las suites estan en TypeScript y usan los mismos alias e imports que la
 * aplicacion, asi que se empaquetan con la propia API de Vite antes de
 * ejecutarlas: de ese modo se prueba exactamente el mismo grafo de modulos que
 * se publica, y no una copia compilada aparte que pueda quedarse atras.
 *
 * El DOM simulado se carga con --import para que exista antes de que se evalue
 * cualquier modulo de la aplicacion.
 */

import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "node_modules", ".drawi-smoke");

const SUITES = [
  { name: "motor", entry: "scripts/smoke-engine.ts", file: "engine.mjs", shim: false },
  { name: "interfaz", entry: "scripts/smoke-ui.ts", file: "ui.mjs", shim: true },
];

const only = process.argv[2];
const suites = only ? SUITES.filter((s) => s.name === only || s.entry.includes(only)) : SUITES;
if (suites.length === 0) {
  console.error(`No hay ninguna suite que case con "${only}". Disponibles: ${SUITES.map((s) => s.name).join(", ")}`);
  process.exit(2);
}

fs.rmSync(outDir, { recursive: true, force: true });

for (const suite of suites) {
  await build({
    root,
    configFile: false,
    logLevel: "error",
    build: {
      ssr: suite.entry,
      outDir,
      emptyOutDir: false,
      rollupOptions: { output: { entryFileNames: suite.file } },
      minify: false,
      target: "node20",
    },
  });
}

const run = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", cwd: root });
    child.on("exit", (code) => resolve(code ?? 1));
  });

let bad = 0;
for (const suite of suites) {
  console.log(`\n─── ${suite.name} ${"─".repeat(Math.max(0, 60 - suite.name.length))}\n`);
  const args = suite.shim
    // En Windows --import exige una URL file://, no una ruta con letra de unidad.
    ? ["--import", pathToFileURL(path.join(root, "scripts", "dom-shim.mjs")).href, path.join(outDir, suite.file)]
    : [path.join(outDir, suite.file)];
  if (await run(args)) bad++;
}

console.log("");
if (bad) {
  console.error(`${bad} suite(s) con fallos.`);
  process.exit(1);
}
console.log(`${suites.length} suite(s) en verde.`);
