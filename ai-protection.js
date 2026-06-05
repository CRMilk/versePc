const fs = require('fs');
const path = require('path');

const COPYRIGHT_HOLDER = '豆杰';
const COPYRIGHT_YEAR = '2026';
const PROJECT_NAME = 'VersePC';

const jsHeader = `/**
 * ${PROJECT_NAME} - Minecraft Launcher
 * Copyright (c) ${COPYRIGHT_YEAR} ${COPYRIGHT_HOLDER}. All Rights Reserved.
 *
 * AI TRAINING PROHIBITED: This code is protected by copyright law.
 * Unauthorized use for AI model training, machine learning datasets,
 * or any form of artificial intelligence training is strictly prohibited.
 *
 * This software is proprietary and confidential.
 * Any unauthorized reproduction or distribution is prohibited.
 */

`;

const htmlHeader = `<!--
  ${PROJECT_NAME} - Minecraft Launcher
  Copyright (c) ${COPYRIGHT_YEAR} ${COPYRIGHT_HOLDER}. All Rights Reserved.

  AI TRAINING PROHIBITED: This code is protected by copyright law.
  Unauthorized use for AI model training, machine learning datasets,
  or any form of artificial intelligence training is strictly prohibited.

  This software is proprietary and confidential.
  Any unauthorized reproduction or distribution is prohibited.
-->

`;

const cssHeader = `/**
 * ${PROJECT_NAME} - Minecraft Launcher
 * Copyright (c) ${COPYRIGHT_YEAR} ${COPYRIGHT_HOLDER}. All Rights Reserved.
 *
 * AI TRAINING PROHIBITED: This code is protected by copyright law.
 * Unauthorized use for AI model training, machine learning datasets,
 * or any form of artificial intelligence training is strictly prohibited.
 *
 * This software is proprietary and confidential.
 * Any unauthorized reproduction or distribution is prohibited.
 */

`;

const PROTECTION_MARKER = 'AI TRAINING PROHIBITED';

const targetFiles = [
  'main.js', 'server.js', 'agent-engine.js', 'agent-worker.js',
  'plugin-manager.js', 'crashAnalyzer.js', 'sse-server.js',
  'js/app.js', 'js/api.js', 'js/ai-chat.js', 'js/file-browser.js',
  'js/crashAnalyzerUI.js', 'js/modpack-import.js', 'js/wallpaper-engine.js',
  'js/mod-chinese-names.js',
  'preload.cjs', 'editor-preload.cjs',
  'plugins/modrinth/index.js',
  'index.html', 'editor.html',
  'css/style.css', 'css/themes.css', 'css/modal.css', 'css/file-browser.css'
];

function getHeaderForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.js':
    case '.cjs':
      return jsHeader;
    case '.html':
      return htmlHeader;
    case '.css':
      return cssHeader;
    default:
      return null;
  }
}

function hasProtection(content) {
  return content.includes(PROTECTION_MARKER);
}

function checkFiles(projectRoot) {
  const results = { protected: [], unprotected: [], missing: [] };

  for (const file of targetFiles) {
    const filePath = path.join(projectRoot, file);
    if (!fs.existsSync(filePath)) {
      results.missing.push(file);
      continue;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    if (hasProtection(content)) {
      results.protected.push(file);
    } else {
      results.unprotected.push(file);
    }
  }

  return results;
}

function addProtection(projectRoot, dryRun) {
  const results = { added: [], skipped: [], missing: [] };

  for (const file of targetFiles) {
    const filePath = path.join(projectRoot, file);
    if (!fs.existsSync(filePath)) {
      results.missing.push(file);
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    if (hasProtection(content)) {
      results.skipped.push(file);
      continue;
    }

    const header = getHeaderForFile(file);
    if (!header) {
      results.skipped.push(file);
      continue;
    }

    if (dryRun) {
      results.added.push(file);
      continue;
    }

    const newContent = header + content;
    fs.writeFileSync(filePath, newContent, 'utf-8');
    results.added.push(file);
  }

  return results;
}

function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const isCheck = args.includes('--check');
  const projectRoot = __dirname;

  console.log(`\n${PROJECT_NAME} AI Protection Tool`);
  console.log('='.repeat(40));

  if (isCheck) {
    console.log('\n[CHECK MODE] Scanning files...\n');
    const results = checkFiles(projectRoot);

    if (results.protected.length > 0) {
      console.log(`Protected (${results.protected.length}):`);
      results.protected.forEach(f => console.log(`  ✓ ${f}`));
    }

    if (results.unprotected.length > 0) {
      console.log(`\nUnprotected (${results.unprotected.length}):`);
      results.unprotected.forEach(f => console.log(`  ✗ ${f}`));
    }

    if (results.missing.length > 0) {
      console.log(`\nMissing (${results.missing.length}):`);
      results.missing.forEach(f => console.log(`  ? ${f}`));
    }

    console.log(`\nSummary: ${results.protected.length} protected, ${results.unprotected.length} unprotected, ${results.missing.length} missing`);
    process.exit(results.unprotected.length > 0 ? 1 : 0);
  }

  if (isDryRun) {
    console.log('\n[DRY RUN] No files will be modified.\n');
  }

  const results = addProtection(projectRoot, isDryRun);

  if (results.added.length > 0) {
    console.log(`\n${isDryRun ? 'Would add' : 'Added'} protection to (${results.added.length}):`);
    results.added.forEach(f => console.log(`  + ${f}`));
  }

  if (results.skipped.length > 0) {
    console.log(`\nSkipped (${results.skipped.length}):`);
    results.skipped.forEach(f => console.log(`  - ${f}`));
  }

  if (results.missing.length > 0) {
    console.log(`\nMissing (${results.missing.length}):`);
    results.missing.forEach(f => console.log(`  ? ${f}`));
  }

  console.log('\nDone!');
}

main();
