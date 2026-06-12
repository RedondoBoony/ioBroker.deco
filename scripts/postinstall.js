'use strict';

/**
 * postinstall.js
 *
 * Automatically installs chromium-browser on Debian/Ubuntu/Raspberry Pi OS
 * if it is not already present.  This runs via the npm "postinstall" hook.
 *
 * Strategy:
 *   1. Non-Linux → skip silently (Windows dev machines, macOS CI, etc.)
 *   2. Chromium already on PATH → skip silently.
 *   3. apt-get available → run  apt-get install -y chromium-browser
 *      (ioBroker's npm install usually runs as root or via sudo wrapper)
 *   4. Anything fails → print a warning but DO NOT fail the install
 *      (a missing browser only causes a runtime error, not a broken install).
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');

// ── 1. Only relevant on Linux ─────────────────────────────────────────────────
if (process.platform !== 'linux') process.exit(0);

// ── 2. Already installed? ─────────────────────────────────────────────────────
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
    console.log('[deco] chromium-browser already installed – skipping.');
    process.exit(0);
}

// ── 3. apt-get available? ─────────────────────────────────────────────────────
const hasApt = fs.existsSync('/usr/bin/apt-get') || fs.existsSync('/usr/local/bin/apt-get');
if (!hasApt) {
    console.warn('[deco] apt-get not found. Please install Chromium manually.');
    process.exit(0);
}

// ── 4. Install ────────────────────────────────────────────────────────────────
console.log('[deco] Installing chromium-browser via apt-get...');
try {
    // Update package lists first (ignore errors – stale cache is fine)
    spawnSync('apt-get', ['update', '-qq'], { stdio: 'inherit' });

    const result = spawnSync(
        'apt-get',
        ['install', '-y', '--no-install-recommends', 'chromium-browser'],
        { stdio: 'inherit' }
    );

    if (result.status === 0) {
        console.log('[deco] chromium-browser installed successfully.');
    } else {
        // apt-get returned non-zero but don't abort npm install
        console.warn('[deco] chromium-browser installation returned exit code', result.status,
            '– you may need to run: sudo apt-get install -y chromium-browser');
    }
} catch (err) {
    // Completely swallow – missing browser is a runtime concern, not install
    console.warn('[deco] Could not auto-install chromium-browser:', err.message,
        '\n       Run manually: sudo apt-get install -y chromium-browser');
}
