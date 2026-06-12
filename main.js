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

        this._api            = null;
        this._updateTimer    = null;
        this._knownMacs      = new Set(); // MACs we have created objects for

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

        const pollMs = Math.max(10, Number(interval) || 30) * 1000;

        this._api = new DecoAPI(ip, password, this.log);

        this.log.info(`Connecting to Deco router at ${ip}, poll interval ${pollMs / 1000}s`);

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
            // getClients() handles login / session-expiry internally
            const clients = await this._api.getClients();

            await this.setStateAsync('info.connection', { val: true, ack: true });
            this.log.debug(`Fetched ${clients.length} client(s) from router`);

            const activeMacs = new Set();
            for (const client of clients) {
                const mac = this._normaliseMac(client.mac);
                activeMacs.add(mac);
                await this._upsertClient(mac, client, true);
            }

            // Mark previously-seen clients as disconnected
            if (keepDisconnected) {
                for (const mac of this._knownMacs) {
                    if (!activeMacs.has(mac)) {
                        await this._setClientConnected(mac, false);
                    }
                }
            }
        } catch (err) {
            this.log.error(`Poll error: ${err.message}`);
            // Close browser so it's freshly launched on next cycle
            if (this._api) await this._api.close().catch(() => {});
            await this.setStateAsync('info.connection', { val: false, ack: true });
        }
    }

    // ── State management ───────────────────────────────────────────────────────

    /**
     * Create (if needed) all objects for a client and write current values.
     */
    async _upsertClient(mac, data, connected) {
        const id = `clients.${mac}`;

        // Ensure device channel exists
        if (!this._knownMacs.has(mac)) {
            await this.setObjectNotExistsAsync(id, {
                type:   'device',
                common: { name: data.name || data.hostname || mac },
                native: {},
            });
            await this._createClientStates(id);
            this._knownMacs.add(mac);
        }

        // Update name in case it changed
        await this.extendObjectAsync(id, {
            common: { name: data.name || data.hostname || mac },
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

    async _setClientConnected(mac, connected) {
        await this.setStateChangedAsync(`clients.${mac}.connected`, { val: connected, ack: true });
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

    /** Convert any MAC format to lowercase underscores: aa_bb_cc_dd_ee_ff */
    _normaliseMac(mac) {
        return (mac || '').replace(/[:\-]/g, '_').toLowerCase();
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
