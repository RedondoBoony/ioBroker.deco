'use strict';

const puppeteer = require('puppeteer-core');
const fs = require('fs');

const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.PUPPETEER_EXECUTABLE_PATH,
].filter(Boolean);

const executablePath = chromePaths.find(p => { try { return fs.existsSync(p); } catch(_){ return false; } });
if (!executablePath) { console.error('No Chrome found on this machine'); process.exit(1); }
console.log('Using Chrome:', executablePath);

const PASSWORD = 'rU392766!';
const HOST     = '192.168.1.1';

(async () => {
    const browser = await puppeteer.launch({
        headless: true,
        executablePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(45000);

    // ── Step 1: Load SPA ──────────────────────────────────────────────────────
    console.log('\n[1] Navigating to SPA...');
    await page.goto(`http://${HOST}/webpages/index.html`, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.screenshot({ path: 'debug_step1_loaded.png', fullPage: true });

    const afterLoad = await page.evaluate(() => ({
        title: document.title,
        hasPasswordInput: !!document.querySelector('input.password-text'),
        hasMapClients:    !!document.querySelector('#map-clients'),
        hasGrid:          !!document.querySelector('tbody.grid-content-data'),
    }));
    console.log('    After load:', afterLoad);

    // ── Step 2: Login if needed ───────────────────────────────────────────────
    await page.waitForSelector('input.password-text, #map-clients', { timeout: 30000 });

    if (await page.$('input.password-text')) {
        console.log('\n[2] Entering password...');
        await page.click('input.password-text', { clickCount: 3 });
        await page.type('input.password-text', PASSWORD, { delay: 40 });
        await page.screenshot({ path: 'debug_step2_password.png', fullPage: true });

        console.log('    Clicking LOG IN...');
        await page.click('a.button-button[title="LOG IN"]');
        await page.waitForSelector('#map-clients', { timeout: 30000 });
        await page.screenshot({ path: 'debug_step3_loggedin.png', fullPage: true });
        console.log('    Logged in!');
    } else {
        console.log('[2] Already logged in');
    }

    // ── Step 3: What does the map look like? ──────────────────────────────────
    console.log('\n[3] Checking map state...');
    const mapInfo = await page.evaluate(() => {
        const mc = document.querySelector('#map-clients');
        return {
            found:   !!mc,
            html:    mc ? mc.outerHTML.substring(0, 600) : 'NOT FOUND',
            visible: mc ? (mc.offsetParent !== null) : false,
        };
    });
    console.log('    #map-clients:', mapInfo.found, '| visible:', mapInfo.visible);
    console.log('    HTML:', mapInfo.html.substring(0, 300));

    // ── Step 4: Click clients tile ────────────────────────────────────────────
    console.log('\n[4] Clicking #map-clients tile...');
    await page.click('#map-clients');

    // Wait up to 5 seconds for anything to change
    await page.evaluate(() => new Promise(r => setTimeout(r, 3000)));
    await page.screenshot({ path: 'debug_step4_afterclick.png', fullPage: true });

    const afterClick = await page.evaluate(() => {
        const rows = document.querySelectorAll('tbody.grid-content-data tr');
        // Find any MAC address pattern in the page
        const macs = [...document.body.innerHTML.matchAll(/[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}/g)]
            .map(m => m[0]).slice(0, 5);

        // Find what panels are currently visible
        const visiblePanels = Array.from(document.querySelectorAll('[id],[class]'))
            .filter(el => el.offsetParent !== null && (el.id.toLowerCase().includes('client') || Array.from(el.classList).some(c => c.toLowerCase().includes('client'))))
            .map(el => `${el.tagName}#${el.id}.${Array.from(el.classList).join('.')}`)
            .slice(0, 15);

        return {
            gridRows:     rows.length,
            hasGrid:      !!document.querySelector('tbody.grid-content-data'),
            macsFound:    macs,
            tables:       document.querySelectorAll('table').length,
            visiblePanels,
        };
    });
    console.log('    After click:', JSON.stringify(afterClick, null, 2));

    // ── Step 5: Try waiting for grid specifically ─────────────────────────────
    console.log('\n[5] Waiting explicitly for tbody.grid-content-data...');
    try {
        await page.waitForSelector('tbody.grid-content-data', { timeout: 15000 });
        const gridRows = await page.evaluate(() =>
            document.querySelectorAll('tbody.grid-content-data tr').length
        );
        console.log('    Grid appeared! Row count:', gridRows);

        // Dump the first row's HTML for selector debugging
        const firstRow = await page.evaluate(() => {
            const r = document.querySelector('tbody.grid-content-data tr');
            return r ? r.outerHTML.substring(0, 1200) : 'no row';
        });
        console.log('    First row HTML snippet:\n', firstRow);

        await page.screenshot({ path: 'debug_step5_grid.png', fullPage: true });
    } catch(e) {
        console.log('    Grid did NOT appear:', e.message);

        // Save full DOM for inspection
        const html = await page.evaluate(() => document.body.innerHTML);
        fs.writeFileSync('debug_dom_afterclick.html', html);
        console.log('    Full DOM saved to debug_dom_afterclick.html (' + html.length + ' chars)');
    }

    // ── Step 6: Test new robust scraper logic ────────────────────────────────
    console.log('\n[6] Testing new robust scraping logic...');
    const clients = await page.evaluate(() => {
        function toKBs(textEl, unitEl) {
            const val  = parseFloat(textEl ? textEl.textContent : '0') || 0;
            const unit = (unitEl ? unitEl.textContent : 'KB/s').trim();
            if (unit.startsWith('GB')) return Math.round(val * 1024 * 1024);
            if (unit.startsWith('MB')) return Math.round(val * 1024);
            return Math.round(val);
        }
        function txt(el, sel) {
            const found = el.querySelector(sel);
            return found ? found.textContent.trim() : '';
        }
        const rows = document.querySelectorAll('tbody.grid-content-data tr');
        return Array.from(rows).map(row => {
            let name = '', mac = '', ip = '';
            const nameTds = Array.from(row.querySelectorAll('td[name="deviceName"]'));
            for (const td of nameTds) {
                const info = td.querySelector('.device-info-container');
                if (info) {
                    const m = txt(info, '.mac');
                    if (m) { name = txt(info, '.name') || txt(td, '.td-content'); mac = m; ip = txt(info, '.ip'); break; }
                }
            }
            if (!mac) {
                const typeTds = Array.from(row.querySelectorAll('td[name="deviceType"]'));
                for (const td of typeTds) {
                    const info = td.querySelector('.device-info-container');
                    if (info) {
                        const m = txt(info, '.mac');
                        if (m) { mac = m; ip = txt(info, '.ip'); const nt = row.querySelector('td[name="deviceName"] .td-content'); if (nt) name = nt.textContent.trim(); break; }
                    }
                }
            }
            if (!mac) return null;
            let device_type = '';
            const typeIcon = row.querySelector('.device-type-container .icon');
            if (typeIcon) { const cls = Array.from(typeIcon.classList).find(c => c.startsWith('icon-') && c !== 'icon'); if (cls) device_type = cls.replace('icon-', ''); }
            const upSpeed = toKBs(row.querySelector('.speed-upload-container .text'), row.querySelector('.speed-upload-container .unit'));
            const downSpeed = toKBs(row.querySelector('.speed-download-container .text'), row.querySelector('.speed-download-container .unit'));
            const connRaw = txt(row, 'td[name="connectionType"] .td-content');
            let conn_type = '', band = '';
            if (connRaw === 'Wired') { conn_type = 'wired'; }
            else if (connRaw.startsWith('Wireless')) { conn_type = 'wireless'; const m = connRaw.match(/\(([^)]+)\)/); if (m) band = m[1]; }
            return { name, mac, ip, conn_type, band, device_type, up_speed: upSpeed, down_speed: downSpeed };
        }).filter(Boolean);
    });
    console.log(`    Scraped ${clients.length} clients`);
    console.log('    First 3:', JSON.stringify(clients.slice(0, 3), null, 2));

    await browser.close();
    console.log('\nDone. Check debug_step*.png screenshots.');
})().catch(e => {
    console.error('\nFATAL:', e.message);
    process.exit(1);
});
