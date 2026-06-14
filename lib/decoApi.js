'use strict';

/**
 * TP-Link Deco Router � Web UI Scraper
 *
 * Drives a headless Chromium browser to:
 *   1. Open http://<host>
 *   2. Enter the admin password and click LOG IN
 *   3. Click the "Clients" map tile
 *   4. Scrape the connected-clients table
 *
 * Works regardless of firmware version because it uses the same web UI
 * the user sees in their browser.
 *
 * Each client object returned by getClients():
 *   { name, mac, ip, conn_type, band, device_type, up_speed, down_speed }
 *   conn_type : "wired" | "wireless" | ""
 *   band      : "2.4G" | "5G" | "6G" | ""
 *   device_type: "iot_device" | "phone" | "pc" | "other" | ""
 *   up_speed  : number  (KB/s)
 *   down_speed: number  (KB/s)
 */

const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const { execSync } = require('child_process');

/**
 * Attempt to locate any installed Chrome/Chromium executable.
 * Returns the path string, or null if nothing is found.
 */
function findChromePath() {
    // 1. Explicit override via environment variable
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    // 2. Known static paths
    const candidates = [
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/snap/bin/chromium',
        '/usr/local/bin/chromium',
        '/usr/local/bin/chromium-browser',
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }

    // 3. PATH lookup
    try {
        const r = execSync(
            'which chromium-browser 2>/dev/null || which chromium 2>/dev/null || which google-chrome 2>/dev/null',
            { encoding: 'utf8', timeout: 3000 }
        ).trim();
        if (r) return r;
    } catch (_) { /* ignore */ }

    // 4. Broad filesystem search under /usr (last resort, slow but thorough)
    try {
        const r = execSync(
            'find /usr -maxdepth 5 -type f \( -name "chromium" -o -name "chromium-browser" -o -name "google-chrome" \) 2>/dev/null | head -1',
            { encoding: 'utf8', timeout: 8000 }
        ).trim();
        if (r) return r;
    } catch (_) { /* ignore */ }

    return null;
}

/**
 * Try to install Chromium using apt-get.
 * Attempts plain apt-get first (works when adapter runs as root),
 * then sudo (works when sudo is available without password).
 * Does not throw – returns true on success, false otherwise.
 */
function tryInstallChromium(log) {
    if (process.platform !== 'linux') return false;
    if (!fs.existsSync('/usr/bin/apt-get')) return false;

    const packages = ['chromium-browser', 'chromium'];
    const prefixes = ['', 'sudo '];

    for (const prefix of prefixes) {
        for (const pkg of packages) {
            try {
                log.info(`[deco] Trying: ${prefix}apt-get install -y ${pkg} ...`);
                execSync(`${prefix}apt-get install -y --no-install-recommends ${pkg}`, {
                    stdio: 'pipe',
                    timeout: 120000,
                });
                log.info(`[deco] Successfully installed ${pkg}.`);
                return true;
            } catch (_) { /* try next combination */ }
        }
    }
    return false;
}

class DecoAPI {
    /**
     * @param {string} host     - Router IP address  e.g. "192.168.68.1"
     * @param {string} password - Router admin password
     * @param {object} log      - Logger ({debug, info, warn, error})
     */
    constructor(host, password, log) {
        this.host     = host;
        this.password = password;
        this.log      = log || console;

        this._browser = null;
        this._page    = null;
    }

    // -- Public API -------------------------------------------------------------

    /** Launch browser and log in to the router. */
    async login() {
        await this._ensureBrowser();
        await this._doLogin();
    }

    /**
     * Return array of connected client objects.
     * Re-logs in automatically when the session has expired.
     */
    async getClients() {
        await this._ensureBrowser();
        await this._navigateToClients();
        return await this._scrapeClients();
    }

    /** Close the browser and clean up. */
    async close() {
        if (this._browser) {
            try { await this._browser.close(); } catch (_) { /* ignore */ }
            this._browser = null;
            this._page    = null;
        }
    }

    // -- Private helpers --------------------------------------------------------

    async _ensureBrowser() {
        if (this._browser) return;

        // Try to find an existing Chromium installation
        let executablePath = findChromePath();

        // Not found → attempt automatic install, then search again
        if (!executablePath) {
            this.log.info('Chromium not found – attempting automatic installation...');
            const installed = tryInstallChromium(this.log);
            if (installed) {
                executablePath = findChromePath();
            }
        }

        if (!executablePath) {
            throw new Error(
                'No Chrome/Chromium found on this system and automatic install failed.\n' +
                'Run manually:  sudo apt-get install -y chromium-browser\n' +
                'Or set the PUPPETEER_EXECUTABLE_PATH environment variable.'
            );
        }

        this.log.debug(`Launching headless browser: ${executablePath}`);
        this._browser = await puppeteer.launch({
            headless: true,
            executablePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
        });
        this._page = await this._browser.newPage();
        // 1920�1080 forces the router SPA to render the desktop/large table layout
        await this._page.setViewport({ width: 1920, height: 1080 });
        this._page.setDefaultTimeout(30000);
        this._page.setDefaultNavigationTimeout(45000);
        this._page.on('console', () => {});
        this._page.on('pageerror', () => {});
    }

    /** Direct URL to the SPA (skips the meta-refresh on the root page). */
    _spaUrl() {
        return `http://${this.host}/webpages/index.html`;
    }

    async _doLogin() {
        this.log.debug(`Opening ${this._spaUrl()} ...`);

        // Navigate directly to the SPA – avoids the meta-refresh redirect on /
        // which would destroy the execution context mid-wait.
        await this._page.goto(this._spaUrl(), { waitUntil: 'networkidle2', timeout: 45000 });

        // Wait for either the password field (login screen) or the map (already in)
        await this._page.waitForSelector('input.password-text, #map-clients', { timeout: 30000 });

        if ((await this._page.$('input.password-text')) === null) {
            this.log.debug('Session already active.');
            return;
        }

        await this._loginOnCurrentPage();
    }

    /**
     * Perform the actual login steps on the current page (no navigation).
     * Assumes input.password-text is already visible.
     */
    async _loginOnCurrentPage() {
        this.log.debug('Entering password...');
        await this._page.click('input.password-text', { clickCount: 3 });
        await this._page.type('input.password-text', this.password, { delay: 40 });

        // Find and click the login button — resilient to title/text/locale differences.
        const result = await this._page.evaluate(() => {
            const all = Array.from(document.querySelectorAll('a.button-button, button.button-button'));
            const btn = all.find(el => /log[\s\-]*in/i.test(el.title || el.textContent || ''));
            if (btn) { btn.click(); return 'matched'; }
            if (all.length) { all[0].click(); return 'fallback'; }
            return 'not-found';
        });
        this.log.debug(`Login button: ${result}`);
        if (result === 'not-found') throw new Error('Cannot find LOG IN button on login page');

        try {
            await this._page.waitForSelector('#map-clients', { timeout: 30000 });
        } catch (_) {
            const errText = await this._page.evaluate(() => {
                const el = document.querySelector('.button-error-tips');
                return el ? el.textContent.trim() : '';
            }).catch(() => '');
            if (errText) throw new Error(`Router login failed: "${errText}"`);
            throw new Error('Login timed out – router did not show the main map after login.');
        }

        this.log.debug('Login successful.');
    }

    async _navigateToClients() {
        // Navigate directly to the SPA (skip the meta-refresh on /)
        this.log.debug('Loading router SPA...');
        await this._page.goto(this._spaUrl(), { waitUntil: 'networkidle2', timeout: 45000 });

        await this._page.waitForSelector('input.password-text, #map-clients', { timeout: 30000 });

        if ((await this._page.$('input.password-text')) !== null) {
            // Already on the login page – perform login WITHOUT navigating again
            this.log.debug('Session expired – logging in on current page...');
            await this._loginOnCurrentPage();
        }

        // Click the Clients tile on the network map
        this.log.debug('Clicking Clients tile...');
        await this._page.click('#map-clients');

        // Wait for the client table body to appear (may be empty when 0 devices are connected)
        await this._page.waitForSelector('tbody.grid-content-data', { timeout: 30000 });

        // Wait until at least one row has MAC data (avoids scraping before SPA populates rows)
        await this._page.waitForFunction(
            () => Array.from(document.querySelectorAll('tbody.grid-content-data tr'))
                       .some(r => r.querySelector('.mac')),
            { timeout: 8000, polling: 400 }
        ).catch(() => { /* proceed even if no MACs yet visible */ });
    }

    async _scrapeClients() {
        this.log.debug('Scraping client table...');

        const clients = await this._page.evaluate(() => {
            /** Convert a speed text+unit pair to KB/s (number). */
            function toKBs(textEl, unitEl) {
                const val  = parseFloat(textEl ? textEl.textContent : '0') || 0;
                const unit = (unitEl ? unitEl.textContent : 'KB/s').trim();
                if (unit.startsWith('GB')) return Math.round(val * 1024 * 1024);
                if (unit.startsWith('MB')) return Math.round(val * 1024);
                return Math.round(val); // KB/s
            }

            /** Get trimmed text from the first matching selector, or ''. */
            function txt(el, sel) {
                const found = el.querySelector(sel);
                return found ? found.textContent.trim() : '';
            }

            const rows = document.querySelectorAll('tbody.grid-content-data tr');

            return Array.from(rows).map(row => {
                // ── Strategy 1: desktop td (s-hide, td index 4) ──────────────
                // td[name="deviceName"] with class s-hide has .device-info-container
                // containing .name, .mac, .ip
                let name = '', mac = '', ip = '';

                // Try all td[name="deviceName"] elements (handles any class order)
                const nameTds = Array.from(row.querySelectorAll('td[name="deviceName"]'));
                for (const td of nameTds) {
                    const info = td.querySelector('.device-info-container');
                    if (info) {
                        const m = txt(info, '.mac');
                        if (m) {
                            name = txt(info, '.name') || txt(td, '.td-content');
                            mac  = m;
                            ip   = txt(info, '.ip');
                            break;
                        }
                    }
                }

                // ── Strategy 2: deviceType td has mac+ip regardless of breakpoint
                if (!mac) {
                    const typeTds = Array.from(row.querySelectorAll('td[name="deviceType"]'));
                    for (const td of typeTds) {
                        const info = td.querySelector('.device-info-container');
                        if (info) {
                            const m = txt(info, '.mac');
                            if (m) {
                                mac = m;
                                ip  = txt(info, '.ip');
                                // Get name from the plain-text deviceName td (td index 1)
                                if (!name) {
                                    const nt = row.querySelector('td[name="deviceName"] .td-content');
                                    if (nt) name = nt.textContent.trim();
                                }
                                break;
                            }
                        }
                    }
                }

                if (!mac) return null; // skip rows without a MAC address

                // ── Device type ───────────────────────────────────────────────
                let device_type = '';
                const typeIcon = row.querySelector('.device-type-container .icon');
                if (typeIcon) {
                    const cls = Array.from(typeIcon.classList).find(
                        c => c.startsWith('icon-') && c !== 'icon'
                    );
                    if (cls) device_type = cls.replace('icon-', '');
                }

                // ── Speed ─────────────────────────────────────────────────────
                const upSpeed   = toKBs(
                    row.querySelector('.speed-upload-container .text'),
                    row.querySelector('.speed-upload-container .unit')
                );
                const downSpeed = toKBs(
                    row.querySelector('.speed-download-container .text'),
                    row.querySelector('.speed-download-container .unit')
                );

                // ── Connection type & band ────────────────────────────────────
                const connRaw = txt(row, 'td[name="connectionType"] .td-content');

                let conn_type = '', band = '';
                if (connRaw === 'Wired') {
                    conn_type = 'wired';
                } else if (connRaw.startsWith('Wireless')) {
                    conn_type = 'wireless';
                    const m = connRaw.match(/\(([^)]+)\)/);
                    if (m) band = m[1];
                }

                return { name, mac, ip, conn_type, band, device_type, up_speed: upSpeed, down_speed: downSpeed };
            }).filter(Boolean);
        });

        this.log.info(`Scraped ${clients.length} client(s) from router`);
        return clients;
    }
}

module.exports = DecoAPI;
