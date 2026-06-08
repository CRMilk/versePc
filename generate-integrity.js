const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INTEGRITY_FILES = [
    'main.js',
    'server.js',
    'preload.cjs',
    'editor-preload.cjs',
    'agent-engine.js',
    'js/app.js',
    'js/ai-chat.js',
    'js/api.js'
];

const OUTPUT_FILE = 'integrity.json';

function computeHash(filePath) {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

function main() {
    const projectRoot = __dirname;
    const manifest = {};

    for (const file of INTEGRITY_FILES) {
        const filePath = path.join(projectRoot, file);
        if (!fs.existsSync(filePath)) {
            console.warn(`  WARN: ${file} not found, skipping`);
            continue;
        }
        manifest[file] = computeHash(filePath);
        console.log(`  OK: ${file} -> ${manifest[file].substring(0, 16)}...`);
    }

    const outputPath = path.join(projectRoot, OUTPUT_FILE);
    fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
    console.log(`\nIntegrity manifest written to ${OUTPUT_FILE} (${Object.keys(manifest).length} files)`);
}

main();
