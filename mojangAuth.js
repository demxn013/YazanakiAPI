// mojangAuth.js
// Verifies a player's Minecraft (MSA) access token by asking Mojang who it
// belongs to. This is how per-user writes from the launcher are authenticated:
// the shared X-API-Secret only proves "a Yazanaki client", whereas this proves
// "THIS specific Minecraft account" — so a user can't spend points or equip on
// someone else's account just because the app secret is extractable.
//
// Uses the global fetch (Node 18+).

const PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

/**
 * @param {string} accessToken  Minecraft access token from the MSA login flow.
 * @returns {Promise<{uuid:string,name:string}|null>}  the verified profile, or
 *          null if the token is missing/invalid/expired.
 */
async function verifyMinecraftToken(accessToken) {
    if (!accessToken || typeof accessToken !== 'string') return null;
    try {
        const res = await fetch(PROFILE_URL, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) return null;            // 401 => bad/expired token
        const body = await res.json();
        if (!body || !body.id || !body.name) return null;
        return { uuid: body.id, name: body.name };
    } catch (err) {
        console.warn('[mojangAuth] token verify failed:', err.message);
        return null;
    }
}

module.exports = { verifyMinecraftToken };
