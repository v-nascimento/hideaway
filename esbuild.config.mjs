import esbuild from "esbuild";
import { builtinModules } from "node:module";

// Usage:
//   node esbuild.config.mjs              -> watch src/ (dev)
//   node esbuild.config.mjs production   -> one-off minified build of src/
//   node esbuild.config.mjs --proto      -> watch prototype/ (throwaway)
const prod = process.argv[2] === "production";
const proto = process.argv.includes("--proto");

const context = await esbuild.context({
	entryPoints: [proto ? "prototype/main.ts" : "src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@electron/remote",
		"@codemirror/*",
		"@lezer/*",
		...builtinModules,
	],
	format: "cjs",
	target: "es2021",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	outfile: "main.js",
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
