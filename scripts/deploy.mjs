// Copies the built plugin into a test vault's plugin folder, set in .env as HIDEAWAY_DEPLOY_DIR.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, normalize, sep } from "node:path";

const target = process.env.HIDEAWAY_DEPLOY_DIR;
if (!target) throw new Error("Set HIDEAWAY_DEPLOY_DIR in .env to the test vault's .obsidian/plugins/hideaway folder.");
// Only ever write into a folder for this plugin, never elsewhere in a vault.
if (!normalize(target).endsWith(`${sep}plugins${sep}hideaway`)) throw new Error(`Refusing to deploy to ${target}: not a plugins/hideaway folder.`);

mkdirSync(target, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
	if (!existsSync(file)) throw new Error(`Missing ${file}; build first.`);
	copyFileSync(file, join(target, file));
	console.log(`copied ${file} -> ${target}`);
}
