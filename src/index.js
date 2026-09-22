const STATUSES = ["yes", "maybe", "no"];
const TIME_ZONE = "Europe/Stockholm";
// Ett pass räknas som "aktuellt" fram till 3 timmar efter start.
const EVENT_GRACE_MS = 3 * 60 * 60 * 1000;
// Så långt fram skapas pass från återkommande serier.
const SERIES_HORIZON_DAYS = 14;
// Påminnelse skickas när det är mindre än så här lång tid kvar till passet …
const REMIND_BEFORE_MS = 24 * 60 * 60 * 1000;
// … men inte om passet börjar om mindre än så här.
const REMIND_MIN_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

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

// Som cleanText men behåller radbrytningar (för kommentarer).
function cleanMultiline(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function cleanEmail(value) {
  const email = cleanText(value, 120).toLowerCase();
  if (!email) return "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
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
    timeZone: TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(iso));
}

// ---------- Tidszon ----------

// Klockslag i Stockholm för ett UTC-ögonblick, uttryckt som om det vore UTC.
function stockholmWallClock(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value])
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

// Datum (UTC-midnatt för kalenderdagen) + "HH:MM" i Stockholm → UTC-ögonblick.
// Hanterar sommar- och vintertid.
function stockholmToUtc(dayMs, time) {
  const [hh, mm] = time.split(":").map(Number);
  const wall = dayMs + (hh * 60 + mm) * 60 * 1000;
  let utc = wall - (stockholmWallClock(wall) - wall);
  utc = wall - (stockholmWallClock(utc) - utc);
  return utc;
}

// UTC-midnatt för dagens kalenderdatum i Stockholm.
function stockholmToday() {
  const wall = stockholmWallClock(Date.now());
  return wall - (wall % DAY_MS);
}

// ---------- Pass ----------

async function nextEvent(env) {
  const since = new Date(Date.now() - EVENT_GRACE_MS).toISOString();
  return env.DB.prepare(
    `SELECT id, starts_at, location, note, min_players, notified_at FROM events
      WHERE starts_at >= ? AND cancelled = 0 ORDER BY starts_at LIMIT 1`
  )
    .bind(since)
    .first();
}

// Alla spelare med sitt svar (eller null) för ett pass.
async function roster(env, eventId) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.email, p.token, r.status, r.updated_at
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

// Skapar pass för alla serier inom SERIES_HORIZON_DAYS. Befintliga (även inställda)
// pass lämnas orörda tack vare det unika indexet på (series_id, starts_at).
async function fillSeries(env) {
  const { results: series } = await env.DB.prepare("SELECT * FROM series").all();
  if (!series.length) return;
  const today = stockholmToday();
  const now = Date.now();
  const inserts = [];
  for (let i = 0; i <= SERIES_HORIZON_DAYS; i++) {
    const day = today + i * DAY_MS;
    const weekday = ((new Date(day).getUTCDay() + 6) % 7) + 1;
    for (const s of series) {
      if (s.weekday !== weekday) continue;
      const start = stockholmToUtc(day, s.time);
      if (start <= now) continue;
      const startsAt = new Date(start).toISOString();
      inserts.push(
        // Ett manuellt pass på samma tid tas över av serien (med sina svar) i stället för att dubbleras.
        env.DB.prepare(
          `UPDATE events SET series_id = ?
            WHERE id = (SELECT id FROM events WHERE starts_at = ? AND series_id IS NULL ORDER BY id LIMIT 1)
              AND NOT EXISTS (SELECT 1 FROM events WHERE series_id = ? AND starts_at = ?)`
        ).bind(s.id, startsAt, s.id, startsAt),
        env.DB.prepare(
          `INSERT OR IGNORE INTO events (starts_at, location, note, min_players, series_id)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(startsAt, s.location, s.note, s.min_players, s.id)
      );
    }
  }
  if (inserts.length) await env.DB.batch(inserts);
}

// ---------- Mejl ----------

function mailEnabled(env) {
  return Boolean(env.RESEND_API_KEY);
}

async function sendMails(env, messages) {
  if (!mailEnabled(env) || !messages.length) return;
  const from = env.FROM_EMAIL || "Innebandy <onboarding@resend.dev>";
  // Resends batch-API tar upp till 100 mejl per anrop.
  for (let i = 0; i < messages.length; i += 100) {
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(messages.slice(i, i + 100).map((m) => ({ from, ...m })))
    });
    if (!res.ok) console.error("Resend", res.status, await res.text());
  }
}

function personalLink(env, token) {
  const base = (env.SITE_URL || "").replace(/\/$/, "");
  return `${base}/?p=${encodeURIComponent(token)}`;
}

// Mejlar en gång per pass, när tillräckligt många har svarat ja.
async function notifyIfEnough(env, event) {
  if (!mailEnabled(env) || !env.NOTIFY_EMAILS) return;
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
  const text = [
    `Innebandy ${when}${event.location ? " i " + event.location : ""} blir av!`,
    "",
    `${players.length} har svarat ja:`,
    ...players.map((p) => "- " + p.name)
  ].join("\n");

  await sendMails(env, [
    {
      to: env.NOTIFY_EMAILS.split(",").map((s) => s.trim()),
      subject: `✅ Innebandy blir av – ${when} (${players.length} ja)`,
      text
    }
  ]);
}

const STATUS_TEXT = { yes: "Kommer", maybe: "Kanske", no: "Kan inte" };

// Påminnelse dagen innan till alla med e-post som inte redan har tackat nej.
async function sendReminders(env) {
  if (!mailEnabled(env)) return;
  const now = Date.now();
  const { results: events } = await env.DB.prepare(
    `SELECT id, starts_at, location, note, min_players FROM events
      WHERE cancelled = 0 AND reminded_at IS NULL AND starts_at > ? AND starts_at <= ?`
  )
    .bind(new Date(now + REMIND_MIN_MS).toISOString(), new Date(now + REMIND_BEFORE_MS).toISOString())
    .all();

  for (const event of events) {
    const claim = await env.DB.prepare(
      "UPDATE events SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL"
    )
      .bind(new Date().toISOString(), event.id)
      .run();
    if (claim.meta.changes === 0) continue;

    const players = await roster(env, event.id);
    const yes = players.filter((p) => p.status === "yes").length;
    const when = formatStart(event.starts_at);
    const where = event.location ? ` på ${event.location}` : "";
    const messages = players
      .filter((p) => p.email && p.status !== "no")
      .map((p) => ({
        to: [p.email],
        subject: `Påminnelse: innebandy ${when} – ${yes} kommer`,
        text: [
          `Hej ${p.name}!`,
          "",
          `Innebandy ${when}${where}.`,
          `${yes} har svarat ja, minst ${event.min_players} behövs.`,
          ...(event.note ? ["", event.note] : []),
          "",
          p.status ? `Ditt svar: ${STATUS_TEXT[p.status]}.` : "Du har inte svarat än.",
          `Svara eller ändra här: ${personalLink(env, p.token)}`
        ].join("\n")
      }));
    await sendMails(env, messages);
  }
}

// ---------- Publika API:er ----------

async function comments(env, eventId, me, admin) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.body, c.created_at, c.player_id, p.name
       FROM comments c JOIN players p ON p.id = c.player_id
      WHERE c.event_id = ? ORDER BY c.created_at`
  )
    .bind(eventId)
    .all();
  return results.map(({ player_id, ...c }) => ({
    ...c,
    can_delete: admin || Boolean(me && me.id === player_id)
  }));
}

async function getEvent(request, env) {
  const event = await nextEvent(env);
  const me = await playerFromRequest(request, env);
  if (!event) {
    return json({ event: null, players: [], comments: [], me: me ? { name: me.name, status: null } : null });
  }
  const players = (await roster(env, event.id)).map(({ name, status, updated_at }) => ({
    name,
    status,
    updated_at
  }));
  const mine = me ? players.find((p) => p.name === me.name) : null;
  const { notified_at, ...publicEvent } = event;
  return json({
    event: publicEvent,
    players,
    comments: await comments(env, event.id, me, isAdmin(request, env)),
    me: me ? { name: me.name, status: mine ? mine.status : null } : null
  });
}

async function putResponse(request, env, ctx) {
  const me = await playerFromRequest(request, env);
  if (!me) return error("Ogiltig eller saknad personlig länk.", 401);

  const { event_id, status } = await readJson(request);
  if (!STATUSES.includes(status)) return error("Ogiltigt svar.");

  const event = await env.DB.prepare(
    "SELECT id, starts_at, location, min_players FROM events WHERE id = ? AND cancelled = 0"
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

async function postComment(request, env) {
  const me = await playerFromRequest(request, env);
  if (!me) return error("Ogiltig eller saknad personlig länk.", 401);

  const body = await readJson(request);
  const text = cleanMultiline(body.body, 500);
  if (!text) return error("Skriv något först.");

  const event = await env.DB.prepare("SELECT id FROM events WHERE id = ? AND cancelled = 0")
    .bind(Number(body.event_id))
    .first();
  if (!event) return error("Passet finns inte.", 404);

  await env.DB.prepare("INSERT INTO comments (event_id, player_id, body) VALUES (?, ?, ?)")
    .bind(event.id, me.id, text)
    .run();
  return json({ ok: true }, 201);
}

async function deleteComment(request, env, id) {
  const comment = await env.DB.prepare("SELECT player_id FROM comments WHERE id = ?").bind(id).first();
  if (!comment) return error("Kommentaren finns inte.", 404);
  const me = await playerFromRequest(request, env);
  if (!isAdmin(request, env) && !(me && me.id === comment.player_id)) {
    return error("Du kan bara ta bort dina egna kommentarer.", 403);
  }
  await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ---------- Admin-API:er ----------

async function adminPlayers(request, env, id) {
  if (request.method === "GET" && id === null) {
    const { results } = await env.DB.prepare(
      "SELECT id, name, email, token FROM players ORDER BY name"
    ).all();
    return json({ players: results });
  }

  if (request.method === "POST" && id === null) {
    const body = await readJson(request);
    const name = cleanText(body.name, 40);
    if (!name) return error("Namn saknas.");
    const email = cleanEmail(body.email);
    if (email === null) return error("Ogiltig e-postadress.");
    try {
      const player = await env.DB.prepare(
        "INSERT INTO players (name, email, token) VALUES (?, ?, ?) RETURNING id, name, email, token"
      )
        .bind(name, email, newToken())
        .first();
      return json({ ok: true, player }, 201);
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) return error("Det finns redan en spelare med det namnet.", 409);
      throw e;
    }
  }

  if (request.method === "PATCH" && id !== null) {
    const email = cleanEmail((await readJson(request)).email);
    if (email === null) return error("Ogiltig e-postadress.");
    const player = await env.DB.prepare(
      "UPDATE players SET email = ? WHERE id = ? RETURNING id, name, email, token"
    )
      .bind(email, id)
      .first();
    return player ? json({ ok: true, player }) : error("Spelaren finns inte.", 404);
  }

  if (request.method === "POST" && id !== null) {
    // Ny länk, t.ex. om den gamla har spridits till fel person.
    const player = await env.DB.prepare(
      "UPDATE players SET token = ? WHERE id = ? RETURNING id, name, email, token"
    )
      .bind(newToken(), id)
      .first();
    return player ? json({ ok: true, player }) : error("Spelaren finns inte.", 404);
  }

  if (request.method === "DELETE" && id !== null) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM comments WHERE player_id = ?").bind(id),
      env.DB.prepare("DELETE FROM responses WHERE player_id = ?").bind(id),
      env.DB.prepare("DELETE FROM players WHERE id = ?").bind(id)
    ]);
    return json({ ok: true });
  }

  return error("Okänd åtgärd.", 405);
}

async function adminEvents(request, env, id) {
  if (request.method === "GET" && id === null) {
    await fillSeries(env);
    const since = new Date(Date.now() - EVENT_GRACE_MS).toISOString();
    const { results } = await env.DB.prepare(
      `SELECT e.id, e.starts_at, e.location, e.note, e.min_players, e.series_id, e.cancelled,
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

  // Ställ in eller återställ ett pass.
  if (request.method === "PATCH" && id !== null) {
    const { cancelled } = await readJson(request);
    await env.DB.prepare("UPDATE events SET cancelled = ? WHERE id = ?").bind(cancelled ? 1 : 0, id).run();
    return json({ ok: true });
  }

  if (request.method === "DELETE" && id !== null) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM comments WHERE event_id = ?").bind(id),
      env.DB.prepare("DELETE FROM responses WHERE event_id = ?").bind(id),
      env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id)
    ]);
    return json({ ok: true });
  }

  return error("Okänd åtgärd.", 405);
}

async function adminSeries(request, env, id) {
  if (request.method === "GET" && id === null) {
    const { results } = await env.DB.prepare(
      "SELECT id, weekday, time, location, note, min_players FROM series ORDER BY weekday, time"
    ).all();
    return json({ series: results });
  }

  if (request.method === "POST" && id === null) {
    const body = await readJson(request);
    const weekday = Number(body.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return error("Välj veckodag.");
    const time = typeof body.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.time) ? body.time : null;
    if (!time) return error("Ogiltig tid.");
    const min = Number.isInteger(Number(body.min_players)) ? Number(body.min_players) : 6;
    if (min < 1 || min > 100) return error("Minsta antal måste vara 1–100.");
    const series = await env.DB.prepare(
      `INSERT INTO series (weekday, time, location, note, min_players) VALUES (?, ?, ?, ?, ?)
       RETURNING id, weekday, time, location, note, min_players`
    )
      .bind(weekday, time, cleanText(body.location, 80), cleanText(body.note, 300), min)
      .first();
    await fillSeries(env);
    return json({ ok: true, series }, 201);
  }

  // Tar bort serien och dess kommande pass. Passerade pass ligger kvar.
  if (request.method === "DELETE" && id !== null) {
    const now = new Date().toISOString();
    const future = "SELECT id FROM events WHERE series_id = ? AND starts_at > ?";
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM comments WHERE event_id IN (${future})`).bind(id, now),
      env.DB.prepare(`DELETE FROM responses WHERE event_id IN (${future})`).bind(id, now),
      env.DB.prepare("DELETE FROM events WHERE series_id = ? AND starts_at > ?").bind(id, now),
      env.DB.prepare("UPDATE events SET series_id = NULL WHERE series_id = ?").bind(id),
      env.DB.prepare("DELETE FROM series WHERE id = ?").bind(id)
    ]);
    return json({ ok: true });
  }

  return error("Okänd åtgärd.", 405);
}

// ---------- Schemalagt (varje timme) ----------

async function hourly(env) {
  await fillSeries(env);
  await sendReminders(env);
}

// ---------- Routning ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/event" && request.method === "GET") return await getEvent(request, env);
      if (path === "/api/response" && request.method === "PUT") return await putResponse(request, env, ctx);
      if (path === "/api/comments" && request.method === "POST") return await postComment(request, env);
      const comment = path.match(/^\/api\/comments\/(\d+)$/);
      if (comment && request.method === "DELETE") return await deleteComment(request, env, Number(comment[1]));

      const admin = path.match(/^\/api\/admin\/(players|events|series)(?:\/(\d+))?$/);
      if (admin) {
        if (!isAdmin(request, env)) return error("Fel admin-lösenord.", 401);
        const id = admin[2] ? Number(admin[2]) : null;
        if (admin[1] === "players") return await adminPlayers(request, env, id);
        if (admin[1] === "events") return await adminEvents(request, env, id);
        return await adminSeries(request, env, id);
      }

      if (path.startsWith("/api/")) return error("Hittades inte.", 404);
    } catch (e) {
      console.error(e);
      return error("Serverfel. Försök igen.", 500);
    }

    // Allt annat: servera statiska filer från public/
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(hourly(env));
  }
};

