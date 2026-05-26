const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname);

function run(cmd, cwd) {
    console.log(`> ${cmd}`);
    execSync(cmd, { cwd: cwd || rootDir, stdio: 'inherit' });
}

function step(name) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  ${name}`);
    console.log(`${'='.repeat(50)}\n`);
}

async function buildInstaller() {
    step('Step 1: Cleaning dist-installer/');
    const distDir = path.join(rootDir, 'dist-installer');
    if (fs.existsSync(distDir)) {
        fs.rmSync(distDir, { recursive: true, force: true });
        console.log('Cleaned dist-installer/');
    }

    step('Step 2: Building VersePC NSIS installer');
    run('npm run build', rootDir);

    step('Build Complete!');
    const installerPath = path.join(distDir, 'VersePC-Setup-1.0.0.exe');
    if (fs.existsSync(installerPath)) {
        const stat = fs.statSync(installerPath);
        console.log(`Installer: ${installerPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
    } else {
        console.log('Installer not found at expected path, checking for .exe files...');
        const files = fs.readdirSync(distDir).filter(f => f.endsWith('.exe'));
        for (const f of files) {
            const fp = path.join(distDir, f);
            const stat = fs.statSync(fp);
            console.log(`Found: ${fp} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
        }
    }
}

buildInstaller().catch(err => {
    console.error('Build failed:', err);
    process.exit(1);
});