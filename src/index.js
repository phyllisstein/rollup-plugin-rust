import * as $path from "node:path";
import * as $toml from "@iarna/toml";
import { createFilter } from "@rollup/pluginutils";
import { glob, rm, read, readString, debug, getEnv, isObject, eachObject } from "./utils.js";
import * as $wasmPack from "./wasm-pack.js";
import * as $cargo from "./cargo.js";
import * as $typescript from "./typescript.js";


const PREFIX = "./.__rollup-plugin-rust__";
const INLINE_ID = "\0__rollup-plugin-rust-inlineWasm__";


function stripPath(path) {
    return path.replace(/\?[^\?]*$/, "");
}


class State {
    constructor(options) {
        // Whether the plugin is running in Vite or not
        this.vite = false;

        // Whether we're in watch mode or not
        this.watch = false;

        // Whether to optimize in release mode
        this.release = true;

        // Whether the options have been processed or not
        this.processed = false;

        this.fileIds = new Set();

        this.options = options;

        this.defaults = {
            watchPatterns: ["src/**"],

            inlineWasm: false,

            verbose: false,

            nodejs: false,

            optimize: {
                release: null,

                rustc: true,
            },

            extraArgs: {
                cargo: [],

                wasmPack: [],

                // TODO figure out better optimization options ?
                wasmOpt: ["-O"],
            },

            experimental: {
                synchronous: false,

                typescriptDeclarationDir: null,
            },
        };

        this.cache = {
            nightly: {},
            targetDir: {},
            build: {},
        };
    }


    reset() {
        this.fileIds.clear();

        this.cache.nightly = {};
        this.cache.targetDir = {};
        this.cache.build = {};
    }


    processOptions(cx) {
        function copyDefaults(defaults) {
            const options = {};

            eachObject(defaults, (key, value) => {
                if (isObject(value)) {
                    options[key] = copyDefaults(value);

                } else {
                    options[key] = value;
                }
            });

            return options;
        }

        if (!this.processed) {
            this.processed = true;

            const oldOptions = this.options;

            // Make a copy of the default settings
            this.options = copyDefaults(this.defaults);

            // Overwrite the default settings with the user-provided settings
            this.setOptions(cx, [], oldOptions, this.options, this.defaults, this.deprecations);
        }
    }

    setOptions(cx, path, oldOptions, options, defaults, deprecations) {
        if (oldOptions != null) {
            if (isObject(oldOptions)) {
                eachObject(oldOptions, (key, value) => {
                    const newPath = path.concat([key]);

                    // If the option is deprecated, call the function
                    if (deprecations != null && key in deprecations) {
                        const deprecation = deprecations[key];

                        if (isObject(deprecation)) {
                            this.setOptions(cx, newPath, value, options?.[key], defaults?.[key], deprecation);

                        } else {
                            deprecation(cx, value);
                        }

                    // If the option has a default, apply it
                    } else if (defaults != null && key in defaults) {
                        const def = defaults[key];

                        if (isObject(def)) {
                            this.setOptions(cx, newPath, value, options?.[key], def, deprecations?.[key]);

                        } else if (value != null) {
                            if (isObject(options)) {
                                options[key] = value;

                            } else {
                                throw new Error("Invalid options state, please report this");
                            }
                        }

                    // The option doesn't exist
                    } else {
                        throw new Error(`The \`${newPath.join(".")}\` option does not exist`);
                    }
                });

            } else if (path.length > 0) {
                throw new Error(`The \`${path.join(".")}\` option must be an object`);

            } else {
                throw new Error(`Options must be an object`);
            }
        }
    }


    async watchFiles(cx, dir) {
        if (this.watch) {
            const matches = await Promise.all(this.options.watchPatterns.map((pattern) => glob(pattern, dir)));

            // TODO deduplicate matches ?
            matches.forEach(function (files) {
                files.forEach(function (file) {
                    cx.addWatchFile(file);
                });
            });
        }
    }


    async getNightly(dir) {
        let nightly = this.cache.nightly[dir];

        if (nightly == null) {
            nightly = this.cache.nightly[dir] = $cargo.getNightly(dir);
        }

        return await nightly;
    }


    async getTargetDir(dir) {
        let targetDir = this.cache.targetDir[dir];

        if (targetDir == null) {
            targetDir = this.cache.targetDir[dir] = $cargo.getTargetDir(dir);
        }

        return await targetDir;
    }


    async loadWasm(outDir) {
        const wasmPath = $path.join(outDir, "index_bg.wasm");

        if (this.options.verbose) {
            debug(`Looking for wasm at ${wasmPath}`);
        }

        return await read(wasmPath);
    }


    async compileTypescriptCustom(name, isCustom) {
        if (isCustom && this.options.experimental.typescriptDeclarationDir != null) {
            await $typescript.writeCustom(
                name,
                this.options.experimental.typescriptDeclarationDir,
                this.options.inlineWasm,
                this.options.experimental.synchronous,
            );
        }
    }


    compileJsNormal(build, isCustom) {
        let wasmPath = `import.meta.ROLLUP_FILE_URL_${build.fileId}`;

        let prelude;

        if (this.options.nodejs) {
            prelude = `function loadFile(url) {
                return new Promise((resolve, reject) => {
                    require("node:fs").readFile(url, (err, data) => {
                        if (err) {
                            reject(err);

                        } else {
                            resolve(data);
                        }
                    });
                });
            }

            const module = loadFile(${wasmPath});`;

        } else {
            prelude = `const module = ${wasmPath};`;
        }


        let mainCode;
        let sideEffects;

        if (this.options.experimental.synchronous) {
            throw new Error("synchronous option can only be used with inlineWasm: true");

        } else {
            if (isCustom) {
                sideEffects = false;

                mainCode = `export { module };

                export async function init(options) {
                    await exports.default({
                        module_or_path: await options.module,
                        memory: options.memory,
                    });
                    return exports;
                }`;

            } else {
                sideEffects = true;

                mainCode = `
                    export * from ${build.importPath};
                `;
            }
        }

        return {
            code: `
                import * as exports from ${build.importPath};

                ${prelude}
                ${mainCode}
            `,
            map: { mappings: '' },
            moduleSideEffects: sideEffects,
            meta: {
                "rollup-plugin-rust": { root: false, realPath: build.realPath }
            },
        };
    }


    compileJs(build, isCustom) {
        return this.compileJsNormal(build, isCustom);
    }


    async getInfo(dir, id) {
        const [targetDir, source] = await Promise.all([
            this.getTargetDir(dir),
            readString(id),
        ]);

        const toml = $toml.parse(source);

        // TODO make this faster somehow
        // TODO does it need to do more transformations on the name ?
        const name = toml.package.name.replace(/\-/g, "_");

        const wasmPath = $path.resolve($path.join(
            targetDir,
            "wasm32-unknown-unknown",
            (this.release ? "release" : "debug"),
            name + ".wasm"
        ));

        const outDir = $path.resolve($path.join(targetDir, "rollup-plugin-rust", name));

        if (this.options.verbose) {
            debug(`Using target directory ${targetDir}`);
            debug(`Using rustc output ${wasmPath}`);
            debug(`Using output directory ${outDir}`);
        }

        await rm(outDir);

        return { name, wasmPath, outDir };
    }


    async buildWasm(cx, dir, name, outDir) {
        // Run wasm-pack instead of wasm-bindgen
        await $wasmPack.run({
            dir,
            outDir,
            release: this.release,
            extraArgs: this.options.extraArgs.wasmPack || [],
            verbose: this.options.verbose,
        });

        // wasm-pack outputs index_bg.wasm and index.js in outDir
        const realPath = $path.join(outDir, "index.js");
        const importPath = `"${outDir}/index.js"`;
        if (this.options.verbose) {
            debug(`Using import path ${importPath}`);
            debug(`Using real path ${realPath}`);
            debug(`Using name ${name}`);
            debug(`Using outDir ${outDir}`);
        }
        return { name, outDir, importPath, realPath };
    }

    async build(cx, dir, id) {
        try {
            if (this.options.verbose) {
                debug(`Compiling ${id}`);
            }
            const [{ name, wasmPath, outDir }] = await Promise.all([
                this.getInfo(dir, id),
            ]);
            return await this.buildWasm(cx, dir, name, outDir);
        } catch (e) {
            if (this.options.verbose) {
                throw e;
            } else {
                const e = new Error("Rust compilation failed");
                e.stack = null;
                throw e;
            }
        }
    }


    async load(cx, oldId) {
        const id = stripPath(oldId);

        let promise = this.cache.build[id];

        if (promise == null) {
            const dir = $path.dirname(id);

            console.log(cx, dir, id);

            promise = this.cache.build[id] = Promise.all([
                this.build(cx, dir, id),
                this.watchFiles(cx, dir),
            ]);
        }

        const [build] = await promise;

        const isCustom = oldId.endsWith("?custom");

        const [result] = await Promise.all([
            this.compileJs(build, isCustom),
            this.compileTypescriptCustom(build.name, isCustom),
        ]);

        return result;
    }
}


export default function rust(options = {}) {
    const filter = createFilter(options.include, options.exclude);
    const state = new State(options);
    return {
        name: "rust",
        configResolved(config) {
            state.vite = true;
            if (config.command !== "build") {
                state.options.inlineWasm = true;
            }
        },
        buildStart(rollup) {
            state.reset();
            state.processOptions(this);
            state.watch = this.meta.watchMode || rollup.watch;
            state.release = (state.options.optimize.release == null
                ? !state.watch
                : state.options.optimize.release);
        },
        resolveId: {
            order: "pre",
            handler(id, importer, info) {
                if (id === INLINE_ID) {
                    return {
                        id: stripPath(importer) + "?inline",
                        meta: { "rollup-plugin-rust": { root: true } }
                    };
                } else {
                    const name = $path.basename(id);
                    const normal = (name === "Cargo.toml");
                    const custom = (name === "Cargo.toml?custom");
                    if ((normal || custom) && filter(id)) {
                        const path = (importer ? $path.resolve($path.dirname(importer), id) : $path.resolve(id));
                        return {
                            id: path,
                            moduleSideEffects: !custom,
                            meta: { "rollup-plugin-rust": { root: true } }
                        };
                    } else if (importer && id[0] === ".") {
                        const info = this.getModuleInfo(importer);
                        if (info && info.meta) {
                            const meta = info.meta["rollup-plugin-rust"];
                            if (meta && !meta.root) {
                                const path = $path.join($path.dirname(importer), id);
                                const realPath = $path.join($path.dirname(meta.realPath), id);
                                return {
                                    id: path,
                                    meta: {
                                        "rollup-plugin-rust": {
                                            root: false,
                                            realPath,
                                        }
                                    }
                                };
                            }
                        }
                    }
                }
                return null;
            },
        },
        load(id, loadState) {
            const info = this.getModuleInfo(id);
            if (info && info.meta) {
                const meta = info.meta["rollup-plugin-rust"];
                if (meta) {
                    if (meta.root) {
                        if (state.vite && loadState && loadState.ssr) {
                            return {
                                code: `export {};`,
                                map: { mappings: '' },
                                moduleSideEffects: false,
                            };
                        } else {
                            return state.load(this, id);
                        }
                    } else {
                        if (options.verbose) {
                            debug(`Loading file ${meta.realPath}`);
                        }
                        return readString(meta.realPath);
                    }
                }
            }
            return null;
        },
        resolveFileUrl(info) {
            if (state.fileIds.has(info.referenceId)) {
                return `new URL(${JSON.stringify(info.fileName)}, import.meta.url)`;
            } else {
                return null;
            }
        },
    };
}
