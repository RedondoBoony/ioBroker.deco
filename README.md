# ioBroker Deco Adapter

ioBroker adapter for **TP-Link Deco** mesh routers.  
It logs in to the router, fetches all connected clients and writes them as
ioBroker states, refreshed on a configurable interval.

---

## Features

- Supports the **plain MD5** authentication protocol (M4, M5, M9, X20, X50 …)
- Supports the **RSA + AES-128-CBC** encrypted protocol (XE75, X60 Gen 3, BE85 …)  
  – protocol is auto-detected on the first login attempt
- Creates one `device` channel per client MAC address under `deco.<instance>.clients.<mac>`
- Optionally keeps disconnected clients visible with `connected = false`

---

## Installation

Install the adapter through the ioBroker Admin interface, or manually:

```bash
cd /opt/iobroker
npm install iobroker.deco
iobroker add deco
```

---

## Adapter Settings

| Setting | Description | Default |
|---|---|---|
| **Router IP address** | IP of your primary Deco unit | `192.168.1.1` |
| **Router admin password** | The password used in the Deco app / web UI | – |
| **Poll interval (s)** | How often clients are refreshed | `30` |
| **Keep disconnected clients** | Whether to keep old entries with `connected=false` | `true` |

---

## State structure

```
deco.<instance>
├── info.connection          boolean  – true when last poll succeeded
└── clients
    └── <aa_bb_cc_dd_ee_ff>  device   – one entry per MAC address
        ├── mac              string   – original MAC address
        ├── ip               string   – current IP address
        ├── name             string   – device name (from Deco app)
        ├── connected        boolean  – currently connected?
        ├── connection_type  string   – "wireless" | "wired"
        ├── band             string   – "2.4G" | "5G" | "6G"
        ├── rssi             number   – signal strength in dBm (wireless only)
        ├── download_speed   number   – current RX in kbit/s
        └── upload_speed     number   – current TX in kbit/s
```

---

## Compatibility

Tested with firmware versions running on:

- Deco M5, M9 Plus
- Deco X50, X60, X55
- Deco XE75 (encrypted protocol)

Other Deco models should work as well. If you encounter login failures,
ensure your router firmware is up to date and that you are using the
**admin** account password (the one set in the Deco mobile app).

---

## License

MIT
