const express = require('express');
const cors    = require('cors');
require('dotenv').config();

const db  = require('./db');
const { verifyMinecraftToken } = require('./mojangAuth');
const app = express();

app.use(cors());
app.use(express.json());

// ── KenzAI internal endpoint (the single writer of points/cosmetics) ─────────
// The launcher never writes the DB directly; we forward verified purchases to
// KenzAI, which performs them with the same logic the Discord /shop uses.
const KENZAI_INTERNAL_URL       = process.env.KENZAI_INTERNAL_URL || 'http://127.0.0.1:4825';
const COSMETICS_INTERNAL_SECRET = process.env.COSMETICS_INTERNAL_SECRET || '';

// ── Auth middleware ─────────────────────────────────────────────────────────
// Every request must include X-API-Secret header matching .env value.
// This stops random people from querying your member data.
app.use((req, res, next) => {
    const secret = req.headers['x-api-secret'];
    if (!process.env.API_SECRET || secret !== process.env.API_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

// Flat pts_* columns → a tidy { category: amount } object.
function pointsByCategory(r) {
    return {
        activity:     r.pts_activity     || 0,
        development:  r.pts_development  || 0,
        contribution: r.pts_contribution || 0,
        skill:        r.pts_skill        || 0,
        leadership:   r.pts_leadership   || 0,
        special:      r.pts_special      || 0,
    };
}

function toEquippedItem(row) {
    return {
        item_id:   row.item_id,
        kind:      row.kind,
        type:      row.type,
        name:      row.name,
        asset_key: row.asset_key || null,
        emoji:     row.emoji || null,
    };
}

// Map of discord_id → [equipped items]. Resilient: if the cosmetics tables
// don't exist yet (migration 002 not applied), returns an empty map so the
// existing member fields keep working.
async function equippedByDiscordId() {
    try {
        const [rows] = await db.execute(`
            SELECT mc.discord_id, si.item_id, si.kind, si.type, si.name, si.asset_key, si.emoji
              FROM member_cosmetics mc
              JOIN shop_items si ON si.item_id = mc.item_id
             WHERE mc.equipped = 1
               AND (mc.expires_at IS NULL OR mc.expires_at > NOW())
        `);
        const map = new Map();
        for (const r of rows) {
            if (!map.has(r.discord_id)) map.set(r.discord_id, []);
            map.get(r.discord_id).push(toEquippedItem(r));
        }
        return map;
    } catch (err) {
        console.warn('[cosmetics] equipped lookup skipped:', err.message);
        return new Map();
    }
}

// All non-expired items (owned + equipped flag) for a single member.
async function inventoryForDiscordId(discordId) {
    if (!discordId) return { equipped: [], owned: [] };
    try {
        const [rows] = await db.execute(`
            SELECT si.item_id, si.kind, si.type, si.name, si.asset_key, si.emoji, mc.equipped
              FROM member_cosmetics mc
              JOIN shop_items si ON si.item_id = mc.item_id
             WHERE mc.discord_id = ?
               AND (mc.expires_at IS NULL OR mc.expires_at > NOW())
             ORDER BY si.kind, si.type, si.name
        `, [discordId]);
        const owned = rows.map(toEquippedItem);
        const equipped = rows.filter(r => r.equipped).map(toEquippedItem);
        return { equipped, owned };
    } catch (err) {
        console.warn('[cosmetics] inventory lookup skipped:', err.message);
        return { equipped: [], owned: [] };
    }
}

// ── GET /members ────────────────────────────────────────────────────────────
// Returns all active empire members the mod needs to identify players, now
// including their points + equipped badges/cosmetics (visible to everyone).
app.get('/members', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT
                m.discord_id,
                m.minecraft_user,
                m.empire_id,
                m.yazanaki_rank,
                m.status,
                m.joined_clan,
                m.points,
                m.pts_activity, m.pts_development, m.pts_contribution,
                m.pts_skill, m.pts_leadership, m.pts_special,
                COALESCE(c.abbr, ei.clan_abbr, '') AS clan_abbr,
                COALESCE(c.name, m.joined_clan, '') AS clan_name
            FROM members m
            LEFT JOIN empire_ids ei ON ei.empire_id = m.empire_id AND ei.active = 1
            LEFT JOIN clans c       ON c.guild_id   = m.clan_guild_id
            WHERE m.status IN ('Military', 'Council', 'Royalty', 'Citizen')
              AND m.minecraft_user != ''
        `);

        const equippedMap = await equippedByDiscordId();

        const members = rows.map(r => ({
            minecraft_user:    r.minecraft_user,
            empire_id:         r.empire_id      || null,
            rank:              r.yazanaki_rank  || 'Member',
            status:            r.status,
            clan_abbr:         r.clan_abbr      || 'UNKNOWN',
            clan_name:         r.clan_name      || 'Unknown Clan',
            points:            r.points || 0,
            points_by_category: pointsByCategory(r),
            equipped:          equippedMap.get(r.discord_id) || [],
        }));

        res.json(members);
    } catch (err) {
        console.error('[/members]', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

// ── GET /member/:username ───────────────────────────────────────────────────
// Single player by Minecraft username — points + full inventory (owned + equipped).
app.get('/member/:username', async (req, res) => {
    try {
        const username = req.params.username;

        const [rows] = await db.execute(`
            SELECT
                m.discord_id,
                m.minecraft_user,
                m.empire_id,
                m.yazanaki_rank,
                m.status,
                m.joined_clan,
                m.points,
                m.pts_activity, m.pts_development, m.pts_contribution,
                m.pts_skill, m.pts_leadership, m.pts_special,
                COALESCE(c.abbr, ei.clan_abbr, '') AS clan_abbr,
                COALESCE(c.name, m.joined_clan, '')  AS clan_name
            FROM members m
            LEFT JOIN empire_ids ei ON ei.empire_id = m.empire_id AND ei.active = 1
            LEFT JOIN clans c       ON c.guild_id   = m.clan_guild_id
            WHERE LOWER(m.minecraft_user) = LOWER(?)
              AND m.status IN ('Military', 'Council', 'Royalty', 'Citizen')
            LIMIT 1
        `, [username]);

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Member not found' });
        }

        const r = rows[0];
        const { equipped, owned } = await inventoryForDiscordId(r.discord_id);

        res.json({
            minecraft_user:     r.minecraft_user,
            empire_id:          r.empire_id      || null,
            rank:               r.yazanaki_rank  || 'Member',
            status:             r.status,
            clan_abbr:          r.clan_abbr      || 'UNKNOWN',
            clan_name:          r.clan_name      || 'Unknown Clan',
            points:             r.points || 0,
            points_by_category: pointsByCategory(r),
            equipped,
            owned,
        });
    } catch (err) {
        console.error('[/member/:username]', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

// ── GET /catalog ────────────────────────────────────────────────────────────
// All enabled badges & cosmetics — for a future web shop/profile. Returns an
// empty array if the cosmetics tables don't exist yet.
app.get('/catalog', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT item_id, kind, type, name, description, cost,
                   duration_days, purchasable, asset_key, emoji
              FROM shop_items
             WHERE enabled = 1
             ORDER BY kind, type, cost, name
        `);
        res.json(rows.map(r => ({
            item_id:       r.item_id,
            kind:          r.kind,
            type:          r.type,
            name:          r.name,
            description:   r.description || '',
            cost:          r.cost || 0,
            duration_days: r.duration_days == null ? null : Number(r.duration_days),
            purchasable:   !!r.purchasable,
            asset_key:     r.asset_key || null,
            emoji:         r.emoji || null,
        })));
    } catch (err) {
        console.warn('[/catalog] unavailable:', err.message);
        res.json([]);
    }
});

// ── Cosmetic WRITES (launcher) ───────────────────────────────────────────────
// Purchase / equip from the launcher. Auth is two-layered: the global
// X-API-Secret (transport) PLUS the player's Minecraft access token (identity).
// We verify the token with Mojang, confirm it matches the :username being acted
// on, map that Minecraft account to its empire member, then forward to KenzAI
// (the single writer) which performs the spend/grant and returns the new state.
//
// NOTE: identity maps by minecraft_user (no UUID column yet), so a player who
// renamed their MC account and whose empire profile is stale won't resolve.

async function resolveDiscordId(username) {
    const [rows] = await db.execute(
        'SELECT discord_id FROM members WHERE LOWER(minecraft_user) = LOWER(?) LIMIT 1',
        [username]
    );
    return rows.length ? rows[0].discord_id : null;
}

async function forwardToKenzai(path, payload) {
    if (!COSMETICS_INTERNAL_SECRET) {
        return { status: 503, body: { ok: false, error: 'writes_disabled' } };
    }
    const resp = await fetch(KENZAI_INTERNAL_URL + path, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Internal-Secret': COSMETICS_INTERNAL_SECRET,
        },
        body: JSON.stringify(payload),
    });
    let body = null;
    try { body = await resp.json(); } catch { /* leave null */ }
    return { status: resp.status, body };
}

function cosmeticWriteHandler(internalPath) {
    return async (req, res) => {
        const username = req.params.username;
        const { itemId, accessToken } = req.body || {};
        if (!itemId || !accessToken) {
            return res.status(400).json({ ok: false, error: 'missing_fields', message: 'itemId and accessToken are required.' });
        }

        // 1. Prove the caller actually owns this Minecraft account.
        const profile = await verifyMinecraftToken(accessToken);
        if (!profile) {
            return res.status(401).json({ ok: false, error: 'invalid_token' });
        }
        // 2. That account must be the one named in the path.
        if (profile.name.toLowerCase() !== String(username).toLowerCase()) {
            return res.status(403).json({ ok: false, error: 'identity_mismatch' });
        }
        // 3. Map the verified Minecraft identity to an empire member.
        const discordId = await resolveDiscordId(profile.name);
        if (!discordId) {
            return res.status(404).json({ ok: false, error: 'member_not_found' });
        }
        // 4. Let KenzAI perform the write and relay its result verbatim.
        try {
            const { status, body } = await forwardToKenzai(internalPath, { discordId, itemId });
            return res.status(status).json(body ?? { ok: false, error: 'no_response' });
        } catch (err) {
            console.error('[cosmetic write]', err.message);
            return res.status(502).json({ ok: false, error: 'kenzai_unreachable' });
        }
    };
}

app.post('/member/:username/purchase', cosmeticWriteHandler('/internal/purchase'));
app.post('/member/:username/equip',    cosmeticWriteHandler('/internal/equip'));
app.post('/member/:username/unequip',  cosmeticWriteHandler('/internal/unequip'));

// ── GET /health ─────────────────────────────────────────────────────────────
// Simple health check — the mod pings this on startup to verify connectivity.
app.get('/health', async (req, res) => {
    try {
        await db.execute('SELECT 1');
        res.json({ status: 'ok' });
    } catch (err) {
        res.status(500).json({ status: 'db_error', error: err.message });
    }
});

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.API_PORT) || 3000;
app.listen(PORT, () => {
    console.log(`[Yazanaki API] Listening on port ${PORT}`);
});
