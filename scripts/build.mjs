import fs from 'fs-extra';
import { execSync } from 'child_process';
import path from 'path';

const root = path.resolve();
const srcRoot = path.join(root, 'src');
const tsconfigPath = path.join(srcRoot, 'tsconfig.json');
const esbuildConfig = path.join(root, 'esbuild.config.mjs');

const srcBuildDist = path.join(srcRoot, 'dist');
const srcDeclarations = path.join(srcBuildDist, 'src');
const srcTsbuildInfo = path.join(srcBuildDist, 'src', 'tsconfig.tsbuildinfo');
const finalOut = path.join(root, 'dist');
const tempMove = path.join(root, '__temp_dist');

const ignoreTypeErrorsFlag = process.argv.includes('--ignoreTypeErrors');

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
  execSync(`node ${esbuildConfig}`, {
    stdio: 'inherit',
    cwd: path.resolve(root), 
  });

  // 3. Run tsc from src
  log('Running tsc...');
  // This is required to ensure smooth operation when using pnpm in monorepo setups 
  // with local package overrides. Pnpm runs prepare scripts in parallel,
  // and Excalidraw's prepare script usually takes longer to complete,
  // than y-excalidraw's prepare script, leading to missing module errors.
  // Therefore, we catch the error here and log it when --ignoreTypeErrorsFlag is provided.
  try {
    execSync(`tsc --emitDeclarationOnly -p ${tsconfigPath}`, { stdio: 'inherit' });
  } catch (err) {
    if (!ignoreTypeErrorsFlag) {
      throw new Error('TypeScript compilation failed. Use --ignoreTypeErrors to skip type checks.');
    }
    log('TypeScript compilation failed, but continuing due to --ignoreTypeErrors flag.');
  }

  // 4. Remove tsbuildinfo if it exists
  if (fs.existsSync(srcTsbuildInfo)) {
    log('Removing tsbuildinfo...');
    fs.removeSync(srcTsbuildInfo);
  }

  // 5. Move generated declarations
  if (!fs.existsSync(srcDeclarations)) {
    throw new Error(`Expected declarations folder not found at ${srcDeclarations}`);
  }

  log('Moving declaration files...');
  // 6. Final move and cleanup
  fs.ensureDirSync(finalOut);
  fs.copySync(srcDeclarations, finalOut, { overwrite: false, errorOnExist: false });

  // 7. Cleanup temp directory
  fs.removeSync(srcBuildDist); // was `src/dist/`

  log('✅ Build complete');
} catch (err) {
  console.error(`[build] ❌ Build failed: ${err.message}`);
  process.exit(0);
}
