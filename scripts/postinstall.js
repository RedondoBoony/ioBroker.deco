'use strict';

/**
 * postinstall.js – auto-installs Chromium after npm install.
 * Tries multiple package names (chromium-browser, chromium) and
 * both plain apt-get (root) and sudo apt-get (sudoer).
 * Never causes the npm install to fail.
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');

if (process.platform !== 'linux') process.exit(0);

const knownPaths = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
];

const alreadyInstalled =
    knownPaths.some(p => fs.existsSync(p)) ||
    (() => {
        try {
            const r = execSync(
                'which chromium-browser 2>/dev/null || which chromium 2>/dev/null',
                { encoding: 'utf8', timeout: 3000 }
            ).trim();
            return r.length > 0;
        } catch (_) { return false; }
    })();

if (alreadyInstalled) {
    console.log('[deco] chromium already installed – skipping.');
    process.exit(0);
}

if (!fs.existsSync('/usr/bin/apt-get')) {
    console.warn('[deco] apt-get not found. Please install Chromium manually.');
    process.exit(0);
}

const packages = ['chromium-browser', 'chromium'];
const prefixes = ['', 'sudo '];

let success = false;
outer: for (const prefix of prefixes) {
    for (const pkg of packages) {
        console.log(`[deco] Trying: ${prefix}apt-get install -y ${pkg} ...`);
        try {
            spawnSync('sh', ['-c', `${prefix}apt-get update -qq && ${prefix}apt-get install -y --no-install-recommends ${pkg}`], {
                stdio: 'inherit',
                timeout: 120000,
            });
            // Verify it actually got installed
            const found = knownPaths.some(p => fs.existsSync(p));
            if (found) {
                console.log(`[deco] ${pkg} installed successfully.`);
                success = true;
                break outer;
            }
        } catch (_) { /* try next */ }
    }
}

if (!success) {
    console.warn('[deco] Auto-install of Chromium failed. The adapter will retry at runtime.');
    console.warn('[deco] To fix manually: sudo apt-get install -y chromium-browser');
}
