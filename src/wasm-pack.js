import * as $path from "node:path";
import { spawn, debug, getEnv } from "./utils.js";

// Runs wasm-pack build for the given directory
export async function run({ dir, outDir, release, extraArgs = [], verbose }) {
    const isWindows = (process.platform === "win32");
    const bin = getEnv("WASM_PACK_BIN", isWindows ? "wasm-pack.exe" : "wasm-pack");

    let args = [
        "build",
        "--out-dir", outDir,
        "--out-name", "index",
    ];
    if (release) args.push("--release");
    args = args.concat(extraArgs);

    if (verbose) {
        debug(`Running wasm-pack ${args.join(" ")}`);
    }

    await spawn(bin, args, { cwd: dir, stdio: "inherit", shell: isWindows });
}
