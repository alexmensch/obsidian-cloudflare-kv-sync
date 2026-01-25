import fs from "fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const outdir = pkg.config.outdir;

await fs.mkdir(outdir, { recursive: true });

for (const file of ["manifest.json", "styles.css", "versions.json"]) {
  await fs.copyFile(file, `${outdir}/${file}`);
}
