#!/bin/sh

# Hook input arrives on stdin. Exit 1 blocks the tool; exit 0 allows it.
exec node -e '
const fs = require("node:fs");
const path = require("node:path");

async function main() {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (input?.version !== 1 || input.event !== "PreToolUse") {
        throw new Error("Expected a version 1 PreToolUse hook input.");
    }

    const filePath = input.tool?.args?.file_path;
    if (typeof filePath !== "string" || !filePath || typeof input.cwd !== "string") {
        throw new Error("The read_file hook requires file_path and cwd strings.");
    }

    const resolved = path.resolve(input.cwd, filePath);
    if (path.basename(resolved) === ".env") {
        throw new Error("Reading .env files is blocked by protect_env.sh.");
    }

    // Resolve links without opening the file or reading its contents.
    try {
        if (path.basename(fs.realpathSync(resolved)) === ".env") {
            throw new Error("Reading .env files is blocked by protect_env.sh.");
        }
    } catch (error) {
        // Let read_file report missing files as usual.
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
}

main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
'
