import fs from 'fs-extra';
import { execSync } from 'child_process';
import path from 'path';

const root = path.resolve();
const srcRoot = path.join(root, 'src');
const tsconfigPath = path.join(srcRoot, 'tsconfig.json');
const esbuildConfig = path.join(root, 'esbuild.config.mjs');

const srcBuildDist = path.join(srcRoot, 'dist');
const srcTsbuildInfo = path.join(srcBuildDist, 'src', 'tsconfig.tsbuildinfo');
const finalOut = path.join(root, 'dist');
const tempMove = path.join(root, '__temp_dist');

function log(msg) {
  console.log(`[build] ${msg}`);
}

if (!fs.existsSync(srcRoot)) {
  log("Skipping build: 'src/' directory not found (GitHub tarball install?)");
  process.exit(0);
}

try {
  // 1. Clean root dist
  log('Removing root dist...');
  fs.removeSync(finalOut);

  // 2. Run esbuild
  log('Running esbuild...');
  execSync(`node ${esbuildConfig}`, { stdio: 'inherit' });

  // 3. Run tsc from src
  log('Running tsc...');
  execSync(`tsc --emitDeclarationOnly -p ${tsconfigPath}`, { stdio: 'inherit' });

  // 4. Remove tsbuildinfo if it exists
  if (fs.existsSync(srcTsbuildInfo)) {
    log('Removing tsbuildinfo...');
    fs.removeSync(srcTsbuildInfo);
  }

  // 5. Move generated declarations
  const srcDeclarations = path.join(srcBuildDist, 'src');
  if (!fs.existsSync(srcDeclarations)) {
    throw new Error(`Expected declarations folder not found at ${srcDeclarations}`);
  }

  log('Moving declaration files...');
  fs.moveSync(srcDeclarations, tempMove, { overwrite: true });

  // 6. Final move and cleanup
  fs.removeSync(srcBuildDist); // was `src/dist/`
  fs.ensureDirSync(finalOut);
  fs.moveSync(tempMove, finalOut, { overwrite: true });

  log('✅ Build complete');
} catch (err) {
  console.error(`[build] ❌ Build failed: ${err.message}`);
  process.exit(1);
}
