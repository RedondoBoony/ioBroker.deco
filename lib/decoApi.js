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

const puppeteer = require('puppeteer');

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

        this.log.debug('Launching headless browser...');
        this._browser = await puppeteer.launch({
            headless: true,
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
        this._page.setDefaultTimeout(20000);
        this._page.setDefaultNavigationTimeout(30000);
        this._page.on('console', () => {});
        this._page.on('pageerror', () => {});
    }

    async _doLogin() {
        this.log.debug(`Opening http://${this.host} ...`);
        await this._page.goto(`http://${this.host}`, { waitUntil: 'domcontentloaded' });

        // Wait for either the password field (login screen) or the map (already in)
        await this._page.waitForSelector('input.password-text, #map-clients', { timeout: 20000 });

        if ((await this._page.$('input.password-text')) === null) {
            this.log.debug('Session already active.');
            return;
        }

        this.log.debug('Entering password...');
        await this._page.click('input.password-text', { clickCount: 3 });
        await this._page.type('input.password-text', this.password, { delay: 30 });

        // Click LOG IN (the <a> button with title="LOG IN")
        await this._page.click('a.button-button[title="LOG IN"]');

        try {
            await this._page.waitForSelector('#map-clients', { timeout: 20000 });
        } catch (_) {
            // Try to surface the error message the router showed
            const errText = await this._page.evaluate(() => {
                const el = document.querySelector('.button-error-tips');
                return el ? el.textContent.trim() : '';
            });
            if (errText) throw new Error(`Router login failed: "${errText}"`);
            throw new Error('Login timed out � router did not show the main map after login.');
        }

        this.log.debug('Login successful.');
    }

    async _navigateToClients() {
        // Navigate to the home page every poll cycle so we detect session expiry
        this.log.debug('Loading router home page...');
        await this._page.goto(`http://${this.host}`, { waitUntil: 'domcontentloaded' });

        await this._page.waitForSelector('input.password-text, #map-clients', { timeout: 20000 });

        if ((await this._page.$('input.password-text')) !== null) {
            this.log.debug('Session expired � re-logging in...');
            await this._doLogin();
        }

        // Click the Clients tile on the network map
        this.log.debug('Clicking Clients tile...');
        await this._page.click('#map-clients');

        // Wait for at least one client row
        await this._page.waitForSelector('tbody.grid-content-data tr', { timeout: 20000 });

        // Give the SPA a moment to finish rendering all rows
        await this._page.evaluate(() => new Promise(resolve => setTimeout(resolve, 800)));
    }

    async _scrapeClients() {
        this.log.debug('Scraping client table...');

        return await this._page.evaluate(() => {
            /** Convert a speed text+unit pair to KB/s (number). */
            function toKBs(textEl, unitEl) {
                const val  = parseFloat(textEl ? textEl.textContent : '0') || 0;
                const unit = (unitEl ? unitEl.textContent : 'KB/s').trim();
                if (unit.startsWith('GB')) return Math.round(val * 1024 * 1024);
                if (unit.startsWith('MB')) return Math.round(val * 1024);
                return Math.round(val); // KB/s
            }

            const rows = document.querySelectorAll('tbody.grid-content-data tr');

            return Array.from(rows).map(row => {
                // -- Name / MAC / IP -------------------------------------------
                // Desktop layout: td[name="deviceName"].s-hide ? .device-info-container
                let name = '', mac = '', ip = '';

                const desktopInfo = row.querySelector(
                    'td[name="deviceName"].s-hide .device-info-container'
                );
                if (desktopInfo) {
                    name = (desktopInfo.querySelector('.name') || { textContent: '' }).textContent.trim();
                    mac  = (desktopInfo.querySelector('.mac')  || { textContent: '' }).textContent.trim();
                    ip   = (desktopInfo.querySelector('.ip')   || { textContent: '' }).textContent.trim();
                } else {
                    // Mobile layout fallback
                    const mName = row.querySelector('td[name="deviceName"].m-hide .td-content');
                    if (mName) name = mName.textContent.trim();
                    const mInfo = row.querySelector('td[name="deviceType"].m-hide .device-info-container');
                    if (mInfo) {
                        mac = (mInfo.querySelector('.mac') || { textContent: '' }).textContent.trim();
                        ip  = (mInfo.querySelector('.ip')  || { textContent: '' }).textContent.trim();
                    }
                }

                if (!mac) return null; // skip rows without a MAC address

                // -- Device type -----------------------------------------------
                // icon class: icon-iot_device / icon-phone / icon-pc / icon-other
                let device_type = '';
                const typeIcon = row.querySelector(
                    'td[name="deviceType"].s-hide .device-type-container .icon'
                );
                if (typeIcon) {
                    const cls = Array.from(typeIcon.classList).find(
                        c => c.startsWith('icon-') && c !== 'icon'
                    );
                    if (cls) device_type = cls.replace('icon-', '');
                }

                // -- Speed -----------------------------------------------------
                const upSpeed   = toKBs(
                    row.querySelector('.speed-upload-container .text'),
                    row.querySelector('.speed-upload-container .unit')
                );
                const downSpeed = toKBs(
                    row.querySelector('.speed-download-container .text'),
                    row.querySelector('.speed-download-container .unit')
                );

                // -- Connection type & band ------------------------------------
                const connRaw = (
                    row.querySelector('td[name="connectionType"] .td-content') ||
                    { textContent: '' }
                ).textContent.trim();

                let conn_type = '', band = '';
                if (connRaw === 'Wired') {
                    conn_type = 'wired';
                } else if (connRaw.startsWith('Wireless')) {
                    conn_type = 'wireless';
                    const m = connRaw.match(/\(([^)]+)\)/);
                    if (m) band = m[1]; // "2.4G", "5G", "6G"
                }

                return { name, mac, ip, conn_type, band, device_type, up_speed: upSpeed, down_speed: downSpeed };
            }).filter(Boolean);
        });
    }
}

module.exports = DecoAPI;
