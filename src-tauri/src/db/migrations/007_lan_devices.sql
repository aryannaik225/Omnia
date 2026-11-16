-- Migration v7: phones / TVs paired with the LAN companion server.
-- Only a SHA-256 hash of each device's token is stored; the token itself lives on the device.
-- Not tied to an Omnia profile: a paired device is trusted like the desktop itself and picks
-- its profile on "Who's watching?".
CREATE TABLE IF NOT EXISTS lan_devices (
    device_id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    paired_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME
);
