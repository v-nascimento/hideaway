// Copies the built plugin into the test vault's plugin folder.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const target = "A:/TestVault/.obsidian/plugins/quake-console";

mkdirSync(target, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
	if (!existsSync(file)) throw new Error(`Missing ${file}; build first.`);
	copyFileSync(file, join(target, file));
	console.log(`copied ${file} -> ${target}`);
}
