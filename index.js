const express = require('express');
const cors    = require('cors');
require('dotenv').config();

const db  = require('./db');
const app = express();

app.use(cors());
app.use(express.json());

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

// ── GET /members ────────────────────────────────────────────────────────────
// Returns all active empire members the mod needs to identify players.
// Joins members → empire_ids → clans to resolve clan abbreviation + name.
app.get('/members', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT
                m.minecraft_user,
                m.empire_id,
                m.yazanaki_rank,
                m.status,
                m.joined_clan,
                COALESCE(c.abbr, ei.clan_abbr, '') AS clan_abbr,
                COALESCE(c.name, m.joined_clan, '') AS clan_name
            FROM members m
            LEFT JOIN empire_ids ei ON ei.empire_id = m.empire_id AND ei.active = 1
            LEFT JOIN clans c       ON c.guild_id   = m.clan_guild_id
            WHERE m.status IN ('Military', 'Council', 'Royalty', 'Citizen')
              AND m.minecraft_user != ''
        `);

        // Return as a clean array the mod can consume
        const members = rows.map(r => ({
            minecraft_user: r.minecraft_user,
            empire_id:      r.empire_id      || null,
            rank:           r.yazanaki_rank  || 'Member',
            status:         r.status,
            clan_abbr:      r.clan_abbr      || 'UNKNOWN',
            clan_name:      r.clan_name      || 'Unknown Clan',
        }));

        res.json(members);
    } catch (err) {
        console.error('[/members]', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

// ── GET /member/:username ───────────────────────────────────────────────────
// Look up a single player by their Minecraft username.
// The mod can call this on-demand for players not in the cached list.
app.get('/member/:username', async (req, res) => {
    try {
        const username = req.params.username;

        const [rows] = await db.execute(`
            SELECT
                m.minecraft_user,
                m.empire_id,
                m.yazanaki_rank,
                m.status,
                m.joined_clan,
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
        res.json({
            minecraft_user: r.minecraft_user,
            empire_id:      r.empire_id      || null,
            rank:           r.yazanaki_rank  || 'Member',
            status:         r.status,
            clan_abbr:      r.clan_abbr      || 'UNKNOWN',
            clan_name:      r.clan_name      || 'Unknown Clan',
        });
    } catch (err) {
        console.error('[/member/:username]', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

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
