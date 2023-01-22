import fs from 'node:fs';
import path from 'node:path';
import { mkdirp, posixify } from '../../../utils/filesystem.js';
import { find_deps, is_http_method, resolve_symlinks } from './utils.js';
import { s } from '../../../utils/misc.js';

/**
 * @param {string} out
 * @param {import('types').ValidatedKitConfig} kit
 * @param {import('types').ManifestData} manifest_data
 * @param {import('vite').Manifest} server_manifest
 * @param {import('vite').Manifest | null} client_manifest
 * @param {import('rollup').OutputAsset[] | null} css
 */
export function build_server_nodes(out, kit, manifest_data, server_manifest, client_manifest, css) {
	mkdirp(`${out}/server/nodes`);
	mkdirp(`${out}/server/stylesheets`);

	const stylesheet_lookup = new Map();

	if (css) {
		css.forEach((asset) => {
			if (asset.source.length < kit.inlineStyleThreshold) {
				const index = stylesheet_lookup.size;
				const file = `${out}/server/stylesheets/${index}.js`;

				fs.writeFileSync(file, `// ${asset.fileName}\nexport default ${s(asset.source)};`);
				stylesheet_lookup.set(asset.fileName, index);
			}
		});
	}

	manifest_data.nodes.forEach((node, i) => {
		/** @type {string[]} */
		const imports = [];

		// String representation of
		/** @type {import('types').SSRNode} */
		/** @type {string[]} */
		const exports = [`export const index = ${i};`];

		/** @type {string[]} */
		const imported = [];

		/** @type {string[]} */
		const stylesheets = [];

		/** @type {string[]} */
		const fonts = [];

		if (node.component && client_manifest) {
			const entry = find_deps(client_manifest, node.component, true);

			imported.push(...entry.imports);
			stylesheets.push(...entry.stylesheets);
			fonts.push(...entry.fonts);

			exports.push(
				`export const component = async () => (await import('../${
					resolve_symlinks(server_manifest, node.component).chunk.file
				}')).default;`,
				`export const file = '${entry.file}';` // TODO what is this?
			);
		}

		if (node.universal) {
			if (client_manifest) {
				const entry = find_deps(client_manifest, node.universal, true);

				imported.push(...entry.imports);
				stylesheets.push(...entry.stylesheets);
				fonts.push(...entry.fonts);
			}

			imports.push(`import * as universal from '../${server_manifest[node.universal].file}';`);
			exports.push(`export { universal };`);
		}

		if (node.server) {
			imports.push(`import * as server from '../${server_manifest[node.server].file}';`);
			exports.push(`export { server };`);
		}

		exports.push(
			`export const imports = ${s(imported)};`,
			`export const stylesheets = ${s(stylesheets)};`,
			`export const fonts = ${s(fonts)};`
		);

		/** @type {string[]} */
		const styles = [];

		stylesheets.forEach((file) => {
			if (stylesheet_lookup.has(file)) {
				const index = stylesheet_lookup.get(file);
				const name = `stylesheet_${index}`;
				imports.push(`import ${name} from '../stylesheets/${index}.js';`);
				styles.push(`\t${s(file)}: ${name}`);
			}
		});

		if (styles.length > 0) {
			exports.push(`export const inline_styles = () => ({\n${styles.join(',\n')}\n});`);
		}

		fs.writeFileSync(
			`${out}/server/nodes/${i}.js`,
			`${imports.join('\n')}\n\n${exports.join('\n')}\n`
		);
	});
}

/**
 * @param {import('rollup').OutputChunk[]} output
 * @param {import('types').ManifestData} manifest_data
 */
export function get_methods(output, manifest_data) {
	/** @type {Record<string, string[]>} */
	const lookup = {};
	output.forEach((chunk) => {
		if (!chunk.facadeModuleId) return;
		const id = posixify(path.relative('.', chunk.facadeModuleId));
		lookup[id] = chunk.exports;
	});

	/** @type {Record<string, import('types').HttpMethod[]>} */
	const methods = {};
	manifest_data.routes.forEach((route) => {
		if (route.endpoint) {
			if (lookup[route.endpoint.file]) {
				methods[route.endpoint.file] = lookup[route.endpoint.file].filter(is_http_method);
			}
		}

		if (route.leaf?.server) {
			if (lookup[route.leaf.server]) {
				methods[route.leaf.server] = lookup[route.leaf.server].filter(is_http_method);
			}
		}
	});

	return methods;
}
