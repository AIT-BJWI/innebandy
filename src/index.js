const STATUSES = ["yes", "maybe", "no"];
// Ett pass räknas som "aktuellt" fram till 3 timmar efter start.
const EVENT_GRACE_MS = 3 * 60 * 60 * 1000;

// ---------- Hjälpfunktioner ----------

function json(data, status = 200) {
  return Response.json(data, { status });
}

function error(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

function isAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return Boolean(env.ADMIN_TOKEN && token && safeEqual(token, env.ADMIN_TOKEN));
}

async function playerFromRequest(request, env) {
  const token = request.headers.get("X-Player-Token");
  if (!token) return null;
  return env.DB.prepare("SELECT id, name FROM players WHERE token = ?").bind(token).first();
}

function formatStart(iso) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(iso));
}

async function nextEvent(env) {
  const since = new Date(Date.now() - EVENT_GRACE_MS).toISOString();
  return env.DB.prepare(
    "SELECT id, starts_at, location, note, min_players, notified_at FROM events WHERE starts_at >= ? ORDER BY starts_at LIMIT 1"
  )
    .bind(since)
    .first();
}

// Alla spelare med sitt svar (eller null) för ett pass.
async function roster(env, eventId) {
  const { results } = await env.DB.prepare(
    `SELECT p.name, r.status, r.updated_at
       FROM players p
       LEFT JOIN responses r ON r.player_id = p.id AND r.event_id = ?
      ORDER BY r.updated_at IS NULL, r.updated_at, p.name`
  )
    .bind(eventId)
    .all();
  return results;
}

async function yesCount(env, eventId) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM responses WHERE event_id = ? AND status = 'yes'"
  )
    .bind(eventId)
    .first();
  return row.n;
}

// Mejlar en gång per pass, när tillräckligt många har svarat ja.
async function notifyIfEnough(env, event) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAILS) return;
  if ((await yesCount(env, event.id)) < event.min_players) return;

  // Markera först, så att två samtidiga anrop inte båda skickar mejl.
  const claim = await env.DB.prepare(
    "UPDATE events SET notified_at = ? WHERE id = ? AND notified_at IS NULL"
  )
    .bind(new Date().toISOString(), event.id)
    .run();
  if (claim.meta.changes === 0) return;

  const players = (await roster(env, event.id)).filter((p) => p.status === "yes");
  const when = formatStart(event.starts_at);
  const body = [
    `Innebandy ${when}${event.location ? " i " + event.location : ""} blir av!`,
    "",
    `${players.length} har svarat ja:`,
    ...players.map((p) => "- " + p.name)
  ].join("\n");

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL || "innebandy@resend.dev",
      to: env.NOTIFY_EMAILS.split(",").map((s) => s.trim()),
      subject: `✅ Innebandy blir av – ${when} (${players.length} ja)`,
      text: body
    })
  });
}

// ---------- Publika API:er ----------

async function getEvent(request, env) {
  const event = await nextEvent(env);
  const me = await playerFromRequest(request, env);
  if (!event) {
    return json({ event: null, players: [], me: me ? { name: me.name, status: null } : null });
  }
  const players = await roster(env, event.id);
  const mine = me ? players.find((p) => p.name === me.name) : null;
  const { notified_at, ...publicEvent } = event;
  return json({
    event: publicEvent,
    players,
    me: me ? { name: me.name, status: mine ? mine.status : null } : null
  });
}

async function putResponse(request, env, ctx) {
  const me = await playerFromRequest(request, env);
  if (!me) return error("Ogiltig eller saknad personlig länk.", 401);

  const { event_id, status } = await readJson(request);
  if (!STATUSES.includes(status)) return error("Ogiltigt svar.");

  const event = await env.DB.prepare(
    "SELECT id, starts_at, location, min_players FROM events WHERE id = ?"
  )
    .bind(Number(event_id))
    .first();
  if (!event) return error("Passet finns inte.", 404);

  await env.DB.prepare(
    `INSERT INTO responses (event_id, player_id, status, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (event_id, player_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`
  )
    .bind(event.id, me.id, status, new Date().toISOString())
    .run();

  if (status === "yes") ctx.waitUntil(notifyIfEnough(env, event));
  return json({ ok: true });
}

// ---------- Admin-API:er ----------

async function adminPlayers(request, env, id) {
  if (request.method === "GET" && id === null) {
    const { results } = await env.DB.prepare(
      "SELECT id, name, token FROM players ORDER BY name"
    ).all();
    return json({ players: results });
  }

  if (request.method === "POST" && id === null) {
    const name = cleanText((await readJson(request)).name, 40);
    if (!name) return error("Namn saknas.");
    try {
      const player = await env.DB.prepare(
        "INSERT INTO players (name, token) VALUES (?, ?) RETURNING id, name, token"
      )
        .bind(name, newToken())
        .first();
      return json({ ok: true, player }, 201);
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) return error("Det finns redan en spelare med det namnet.", 409);
      throw e;
    }
  }

  if (request.method === "POST" && id !== null) {
    // Ny länk, t.ex. om den gamla har spridits till fel person.
    const player = await env.DB.prepare(
      "UPDATE players SET token = ? WHERE id = ? RETURNING id, name, token"
    )
      .bind(newToken(), id)
      .first();
    return player ? json({ ok: true, player }) : error("Spelaren finns inte.", 404);
  }

  if (request.method === "DELETE" && id !== null) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM responses WHERE player_id = ?").bind(id),
      env.DB.prepare("DELETE FROM players WHERE id = ?").bind(id)
    ]);
    return json({ ok: true });
  }

  return error("Okänd åtgärd.", 405);
}

async function adminEvents(request, env, id) {
  if (request.method === "GET" && id === null) {
    const since = new Date(Date.now() - EVENT_GRACE_MS).toISOString();
    const { results } = await env.DB.prepare(
      `SELECT e.id, e.starts_at, e.location, e.note, e.min_players,
              (SELECT COUNT(*) FROM responses r WHERE r.event_id = e.id AND r.status = 'yes') AS yes
         FROM events e WHERE e.starts_at >= ? ORDER BY e.starts_at`
    )
      .bind(since)
      .all();
    return json({ events: results });
  }

  if (request.method === "POST" && id === null) {
    const body = await readJson(request);
    const start = new Date(body.starts_at);
    if (Number.isNaN(start.getTime())) return error("Ogiltig starttid.");
    const min = Number.isInteger(Number(body.min_players)) ? Number(body.min_players) : 6;
    if (min < 1 || min > 100) return error("Minsta antal måste vara 1–100.");
    const event = await env.DB.prepare(
      `INSERT INTO events (starts_at, location, note, min_players) VALUES (?, ?, ?, ?)
       RETURNING id, starts_at, location, note, min_players`
    )
      .bind(start.toISOString(), cleanText(body.location, 80), cleanText(body.note, 300), min)
      .first();
    return json({ ok: true, event }, 201);
  }

  if (request.method === "DELETE" && id !== null) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM responses WHERE event_id = ?").bind(id),
      env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id)
    ]);
    return json({ ok: true });
  }

  return error("Okänd åtgärd.", 405);
}

// ---------- Routning ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/event" && request.method === "GET") return await getEvent(request, env);
      if (path === "/api/response" && request.method === "PUT") return await putResponse(request, env, ctx);

      const admin = path.match(/^\/api\/admin\/(players|events)(?:\/(\d+))?$/);
      if (admin) {
        if (!isAdmin(request, env)) return error("Fel admin-lösenord.", 401);
        const id = admin[2] ? Number(admin[2]) : null;
        return admin[1] === "players"
          ? await adminPlayers(request, env, id)
          : await adminEvents(request, env, id);
      }

      if (path.startsWith("/api/")) return error("Hittades inte.", 404);
    } catch (e) {
      console.error(e);
      return error("Serverfel. Försök igen.", 500);
    }

    // Allt annat: servera statiska filer från public/
    return env.ASSETS.fetch(request);
  }
};
