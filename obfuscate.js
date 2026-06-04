const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const OBFUSCATION_TARGETS = [
    'main.js',
    'server.js',
    'agent-engine.js',
    'agent-worker.js',
    'plugin-manager.js',
    'crashAnalyzer.js',
    'sse-server.js',
    'js/app.js',
    'js/api.js',
    'js/ai-chat.js',
    'js/file-browser.js',
    'js/crashAnalyzerUI.js',
    'js/modpack-import.js',
    'js/wallpaper-engine.js',
    'js/mod-chinese-names.js',
    'js/hljs-setup.js',
    'plugins/modrinth/index.js'
];

const OBFUSCATION_OPTIONS = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.5,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.2,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    log: false,
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 0.5,
    stringArrayEncoding: ['rc4'],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 1,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 2,
    stringArrayWrappersType: 'function',
    stringArrayThreshold: 0.75,
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
    target: 'node'
};

const BACKUP_DIR = path.join(__dirname, '.source-backup');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function backupFile(filePath) {
    const backupPath = path.join(BACKUP_DIR, path.relative(__dirname, filePath));
    ensureDir(path.dirname(backupPath));
    fs.copyFileSync(filePath, backupPath);
}

function obfuscateFile(filePath) {
    const sourceCode = fs.readFileSync(filePath, 'utf-8');
    const result = JavaScriptObfuscator.obfuscate(sourceCode, OBFUSCATION_OPTIONS);
    return result.getObfuscatedCode();
}

function main() {
    const args = process.argv.slice(2);
    const isDryRun = args.includes('--dry-run');
    const isRestore = args.includes('--restore');

    if (isRestore) {
        if (!fs.existsSync(BACKUP_DIR)) {
            console.error('No backup found. Cannot restore.');
            process.exit(1);
        }
        for (const file of OBFUSCATION_TARGETS) {
            const backupPath = path.join(BACKUP_DIR, file);
            const targetPath = path.join(__dirname, file);
            if (fs.existsSync(backupPath)) {
                fs.copyFileSync(backupPath, targetPath);
                console.log(`Restored: ${file}`);
            }
        }
        console.log('Restore complete.');
        return;
    }

    console.log('VersePC Code Obfuscator');
    console.log('========================');
    console.log(`Files to obfuscate: ${OBFUSCATION_TARGETS.length}`);
    console.log(`Mode: ${isDryRun ? 'DRY RUN' : 'LIVE'}\n`);

    ensureDir(BACKUP_DIR);

    let success = 0;
    let failed = 0;

    for (const file of OBFUSCATION_TARGETS) {
        const filePath = path.join(__dirname, file);
        if (!fs.existsSync(filePath)) {
            console.log(`  SKIP  ${file} (not found)`);
            continue;
        }

        try {
            const originalSize = fs.statSync(filePath).size;
            backupFile(filePath);
            const obfuscated = obfuscateFile(filePath);

            if (!isDryRun) {
                fs.writeFileSync(filePath, obfuscated, 'utf-8');
            }

            const newSize = Buffer.byteLength(obfuscated, 'utf-8');
            const ratio = ((newSize / originalSize) * 100).toFixed(0);
            console.log(`  ${isDryRun ? 'WOULD' : 'DONE'}  ${file} (${originalSize} -> ${newSize} bytes, ${ratio}%)`);
            success++;
        } catch (err) {
            console.error(`  FAIL  ${file}: ${err.message}`);
            failed++;
        }
    }

    console.log(`\nDone: ${success} obfuscated, ${failed} failed`);
    if (!isDryRun) {
        console.log(`Originals backed up to: ${BACKUP_DIR}`);
        console.log('Run "node obfuscate.js --restore" to restore originals.');
    }
}

main();
