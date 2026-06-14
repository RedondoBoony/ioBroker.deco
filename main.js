'use strict';

/*
 * ioBroker Deco Adapter
 * Logs in to a TP-Link Deco router, retrieves connected clients and writes
 * them as structured ioBroker states under  deco.<instance>.clients.<mac>.*
 */

const utils   = require('@iobroker/adapter-core');
const DecoAPI = require('./lib/decoApi');

class DecoAdapter extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'deco',
        });

        this._api         = null;
        this._updateTimer = null;
        this._knownIps    = new Set();  // IP-keys we have created objects for
        this._macToIp     = new Map();  // mac → current ipKey (for IP-change detection)
        this._zeroCount   = 0;          // consecutive zero-client poll counter

        this.on('ready',  this._onReady.bind(this));
        this.on('unload', this._onUnload.bind(this));
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    async _onReady() {
        await this.setStateAsync('info.connection', { val: false, ack: true });

        const { ip, password, interval, keepDisconnected } = this.config;

        if (!ip || !password) {
            this.log.error('Please set router IP and password in the adapter settings.');
            return;
        }

        const pollMs = Math.max(2, Number(interval) || 5) * 1000;

        this._api = new DecoAPI(ip, password, this.log);

        // Ensure info states exist (not created automatically on upgrades)
        await this.setObjectNotExistsAsync('info.connected_clients', {
            type: 'state',
            common: { name: 'Number of connected clients', type: 'number', role: 'value', read: true, write: false, def: 0 },
            native: {},
        });

        this.log.info(`Connectingf to Deco router at ${ip}, poll interval ${pollMs / 1000}s`);

        // Initial poll, then start repeating timer
        await this._poll(keepDisconnected !== false);
        this._updateTimer = setInterval(
            () => this._poll(keepDisconnected !== false),
            pollMs
        );
    }

    _onUnload(callback) {
        if (this._updateTimer) {
            clearInterval(this._updateTimer);
            this._updateTimer = null;
        }
        // Close the headless browser cleanly
        const cleanup = async () => {
            if (this._api) await this._api.close().catch(() => {});
            await this.setStateAsync('info.connection', { val: false, ack: true }).catch(() => {});
        };
        cleanup().finally(callback);
    }

    // ── Polling ────────────────────────────────────────────────────────────────

    async _poll(keepDisconnected) {
        try {
            const clients = await this._api.getClients();

   
            if (clients.length === 0) {
                this._zeroCount++;
                if (this._zeroCount >= 3) {
                    this.log.warn(`0 clients for ${this._zeroCount} consecutive polls – reconnecting browser...`);
                    if (this._api) await this._api.close().catch(() => {});
                    await this.setStateAsync('info.connection', { val: false, ack: true });
                    this._zeroCount = 0;
                } else {
                    this.log.warn(`0 clients detected (attempt ${this._zeroCount}/3) – will retry before reconnecting`);
                }
                return;
            }
            this._zeroCount = 0;

         // Always write the client count immediately – same value as the scrape log
            await this.setStateAsync('info.connected_clients', { val: clients.length, ack: true });

            await this.setStateAsync('info.connection', { val: true, ack: true });

            const activeIps = new Set();
            let totalDown = 0, totalUp = 0;
            for (const client of clients) {
                if (!client.ip) continue;
                const ipKey = this._normaliseIp(client.ip);
                const mac   = client.mac || '';

                // Detect IP change for this MAC → delete old state tree
                if (mac && this._macToIp.has(mac) && this._macToIp.get(mac) !== ipKey) {
                    await this._deleteClient(this._macToIp.get(mac));
                }

                activeIps.add(ipKey);
                if (mac) this._macToIp.set(mac, ipKey);
                await this._upsertClient(ipKey, client, true);

                totalDown += typeof client.down_speed === 'number' ? client.down_speed : 0;
                totalUp   += typeof client.up_speed   === 'number' ? client.up_speed   : 0;
            }

            await this.setStateChangedAsync('info.total_download_speed', { val: totalDown, ack: true });
            await this.setStateChangedAsync('info.total_upload_speed',   { val: totalUp,   ack: true });

            // Handle clients no longer active
            for (const ipKey of [...this._knownIps]) {
                if (!activeIps.has(ipKey)) {
                    if (keepDisconnected) {
                        await this._setClientConnected(ipKey, false);
                    } else {
                        await this._deleteClient(ipKey);
                    }
                }
            }
        } catch (err) {
            this.log.error(`Poll error: ${err.message}`);
            if (this._api) await this._api.close().catch(() => {});
            await this.setStateAsync('info.connection', { val: false, ack: true });
        }
    }

    // ── State management ───────────────────────────────────────────────────────

    /**
     * Create (if needed) all objects for a client and write current values.
     */
    async _upsertClient(ipKey, data, connected) {
        const id = `clients.${ipKey}`;

        // Ensure device channel exists
        if (!this._knownIps.has(ipKey)) {
            await this.setObjectNotExistsAsync(id, {
                type:   'device',
                common: { name: data.name || data.ip || ipKey },
                native: {},
            });
            await this._createClientStates(id);
            this._knownIps.add(ipKey);
        }

        // Update name in case it changed
        await this.extendObjectAsync(id, {
            common: { name: data.name || data.ip || ipKey },
        });

        // Write states
        const s = (suffix, val) =>
            this.setStateChangedAsync(`${id}.${suffix}`, { val: val !== undefined ? val : null, ack: true });

        await s('mac',            data.mac         || '');
        await s('ip',             data.ip          || '');
        await s('name',           data.name        || '');
        await s('connected',      connected);
        await s('connection_type',data.conn_type   || '');
        await s('band',           data.band        || '');
        await s('device_type',    data.device_type || '');
        await s('download_speed', typeof data.down_speed === 'number' ? data.down_speed : null);
        await s('upload_speed',   typeof data.up_speed   === 'number' ? data.up_speed   : null);
    }

    async _setClientConnected(ipKey, connected) {
        await this.setStateChangedAsync(`clients.${ipKey}.connected`, { val: connected, ack: true });
    }

    async _deleteClient(ipKey) {
        const id = `clients.${ipKey}`;
        this.log.info(`Removing client ${ipKey} (IP changed or keepDisconnected=false)`);
        try {
            const objects = await this.getObjectListAsync({
                startkey: `${this.namespace}.${id}.`,
                endkey:   `${this.namespace}.${id}.香`,
            });
            for (const row of (objects && objects.rows ? objects.rows : [])) {
                await this.delObjectAsync(row.id.replace(`${this.namespace}.`, '')).catch(() => {});
            }
            await this.delObjectAsync(id).catch(() => {});
        } catch (_) { /* ignore */ }
        this._knownIps.delete(ipKey);
        for (const [mac, ik] of this._macToIp) {
            if (ik === ipKey) { this._macToIp.delete(mac); break; }
        }
    }

    /**
     * Create all state objects under a client device (only if they don't exist yet).
     */
    async _createClientStates(deviceId) {
        const states = [
            {
                id: 'mac',
                common: { name: 'MAC address', type: 'string', role: 'info.mac', read: true, write: false },
            },
            {
                id: 'ip',
                common: { name: 'IP address', type: 'string', role: 'info.ip', read: true, write: false },
            },
            {
                id: 'name',
                common: { name: 'Device name', type: 'string', role: 'info.name', read: true, write: false },
            },
            {
                id: 'connected',
                common: { name: 'Connected', type: 'boolean', role: 'indicator.connected', read: true, write: false, def: false },
            },
            {
                id: 'connection_type',
                common: { name: 'Connection type (wireless / wired)', type: 'string', role: 'state', read: true, write: false },
            },
            {
                id: 'band',
                common: { name: 'WiFi band (2.4G / 5G / 6G)', type: 'string', role: 'state', read: true, write: false },
            },
            {
                id: 'device_type',
                common: { name: 'Device type (iot_device / phone / pc / other)', type: 'string', role: 'state', read: true, write: false },
            },
            {
                id: 'download_speed',
                common: { name: 'Current download speed', type: 'number', role: 'value.speed', unit: 'KB/s', read: true, write: false },
            },
            {
                id: 'upload_speed',
                common: { name: 'Current upload speed', type: 'number', role: 'value.speed', unit: 'KB/s', read: true, write: false },
            },
        ];

        for (const state of states) {
            await this.setObjectNotExistsAsync(`${deviceId}.${state.id}`, {
                type:   'state',
                common: state.common,
                native: {},
            });
        }
    }

    // ── Utility ────────────────────────────────────────────────────────────────

    /** Convert IP address to safe object-key: 192.168.1.1 → 192_168_1_1 */
    _normaliseIp(ip) {
        return (ip || '').replace(/\./g, '_');
    }
}

// ── Entry point ────────────────────────────────────────────────────────────────

if (require.main !== module) {
    // Loaded by the js-controller
    module.exports = (options) => new DecoAdapter(options);
} else {
    // Started directly (e.g. node main.js)
    new DecoAdapter();
}
