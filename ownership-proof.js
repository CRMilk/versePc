const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = __dirname;

const SOURCE_FILES = [
    'main.js',
    'server.js',
    'agent-engine.js',
    'agent-worker.js',
    'plugin-manager.js',
    'crashAnalyzer.js',
    'sse-server.js',
    'preload.cjs',
    'editor-preload.cjs',
    'js/app.js',
    'js/api.js',
    'js/ai-chat.js',
    'js/file-browser.js',
    'js/crashAnalyzerUI.js',
    'js/modpack-import.js',
    'js/wallpaper-engine.js',
    'js/mod-chinese-names.js',
    'js/hljs-setup.js',
    'plugins/modrinth/index.js',
    'index.html',
    'editor.html',
    'package.json'
];

const IGNORE_DIRS = [
    'node_modules',
    '.git',
    'dist',
    '.source-backup',
    'ffmpeg',
    'assets'
];

function sha256(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function hashFile(filePath) {
    const content = fs.readFileSync(filePath);
    return {
        sha256: sha256(content),
        size: content.length,
        modified: fs.statSync(filePath).mtime.toISOString()
    };
}

function collectAllSourceFiles() {
    const files = [];
    function walk(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relPath = path.relative(PROJECT_ROOT, fullPath).replace(/\\/g, '/');
            if (entry.isDirectory()) {
                if (!IGNORE_DIRS.includes(entry.name) && !entry.name.startsWith('.')) {
                    walk(fullPath);
                }
            } else if (/\.(js|cjs|ts|json|html|css|kt)$/.test(entry.name)) {
                files.push(relPath);
            }
        }
    }
    walk(PROJECT_ROOT);
    return files;
}

function generateManifest(author, secretKey) {
    const timestamp = new Date().toISOString();
    const files = {};

    for (const file of SOURCE_FILES) {
        const filePath = path.join(PROJECT_ROOT, file);
        if (fs.existsSync(filePath)) {
            files[file] = hashFile(filePath);
        }
    }

    const allHashes = Object.values(files).map(f => f.sha256).sort();
    const merkleRoot = sha256(allHashes.join('\n'));

    const manifest = {
        project: {
            name: 'VersePC',
            description: 'VersePC - Minecraft Launcher',
            author: author || 'Unknown',
            version: require('./package.json').version || '1.0.0',
            license: 'All Rights Reserved'
        },
        timestamp: timestamp,
        generatedBy: 'VersePC Ownership Proof Generator v1.0',
        fingerprint: {
            algorithm: 'SHA-256',
            merkleRoot: merkleRoot,
            fileCount: Object.keys(files).length
        },
        files: files,
        verification: {
            instructions: 'To verify ownership, re-hash the source files and compare with this manifest.',
            command: 'node ownership-proof.js --verify ownership-manifest.json'
        }
    };

    if (secretKey) {
        const manifestStr = JSON.stringify({
            fingerprint: manifest.fingerprint,
            project: manifest.project,
            timestamp: manifest.timestamp
        });
        manifest.signature = {
            algorithm: 'HMAC-SHA256',
            value: crypto.createHmac('sha256', secretKey).update(manifestStr).digest('hex'),
            note: 'Signed with provided secret key. Keep the key safe.'
        };
    }

    return manifest;
}

function verifyManifest(manifestPath) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    console.log(`\nVerifying: ${manifest.project.name} by ${manifest.project.author}`);
    console.log(`Original timestamp: ${manifest.timestamp}`);
    console.log(`Original merkle root: ${manifest.fingerprint.merkleRoot}\n`);

    let verified = 0;
    let modified = 0;
    let missing = 0;

    for (const [file, info] of Object.entries(manifest.files)) {
        const filePath = path.join(PROJECT_ROOT, file);
        if (!fs.existsSync(filePath)) {
            console.log(`  MISSING  ${file}`);
            missing++;
            continue;
        }
        const currentHash = hashFile(filePath).sha256;
        if (currentHash === info.sha256) {
            console.log(`  OK       ${file}`);
            verified++;
        } else {
            console.log(`  CHANGED  ${file}`);
            modified++;
        }
    }

    console.log(`\nResult: ${verified} verified, ${modified} modified, ${missing} missing`);

    const currentFiles = {};
    for (const file of Object.keys(manifest.files)) {
        const filePath = path.join(PROJECT_ROOT, file);
        if (fs.existsSync(filePath)) {
            currentFiles[file] = hashFile(filePath);
        }
    }
    const currentHashes = Object.values(currentFiles).map(f => f.sha256).sort();
    const currentRoot = sha256(currentHashes.join('\n'));
    const rootMatch = currentRoot === manifest.fingerprint.merkleRoot;
    console.log(`Merkle root: ${rootMatch ? 'MATCH' : 'MISMATCH'}`);

    return { verified, modified, missing, rootMatch };
}

function main() {
    const args = process.argv.slice(2);

    if (args.includes('--verify')) {
        const idx = args.indexOf('--verify');
        const manifestPath = args[idx + 1] || 'ownership-manifest.json';
        if (!fs.existsSync(manifestPath)) {
            console.error(`Manifest not found: ${manifestPath}`);
            process.exit(1);
        }
        verifyManifest(manifestPath);
        return;
    }

    let author = null;
    let secretKey = null;

    const authorIdx = args.indexOf('--author');
    if (authorIdx !== -1) author = args[authorIdx + 1];

    const keyIdx = args.indexOf('--key');
    if (keyIdx !== -1) secretKey = args[keyIdx + 1];

    if (!author) {
        console.error('Usage: node ownership-proof.js --author "Your Name" [--key "your-secret-key"]');
        console.error('       node ownership-proof.js --verify ownership-manifest.json');
        process.exit(1);
    }

    console.log('VersePC Ownership Proof Generator');
    console.log('==================================');
    console.log(`Author: ${author}`);
    console.log(`Signed: ${secretKey ? 'YES (HMAC-SHA256)' : 'NO (unsigned)'}\n`);

    const manifest = generateManifest(author, secretKey);

    const outputPath = 'ownership-manifest.json';
    fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2), 'utf-8');

    console.log(`Fingerprint (Merkle Root): ${manifest.fingerprint.merkleRoot}`);
    console.log(`Files hashed: ${manifest.fingerprint.fileCount}`);
    console.log(`Timestamp: ${manifest.timestamp}`);
    console.log(`\nManifest saved to: ${outputPath}`);

    if (manifest.signature) {
        console.log(`HMAC Signature: ${manifest.signature.value}`);
    }

    console.log('\n--- IMPORTANT ---');
    console.log('1. Keep this manifest file safe - it proves you had the code at this time.');
    console.log('2. For stronger proof, upload the merkle root hash to a timestamping service:');
    console.log(`   Merkle Root: ${manifest.fingerprint.merkleRoot}`);
    console.log('3. Free timestamping services:');
    console.log('   - https://www.originstamp.com/ (free tier)');
    console.log('   - https://www.blockchainnotar.io/');
    console.log('   - Or simply commit to a GitHub repo with a clear date.');
    console.log('4. If you used --key, keep your secret key PRIVATE and NEVER share it.');
}

main();
