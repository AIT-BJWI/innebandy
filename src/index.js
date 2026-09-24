import { connect } from "cloudflare:sockets";

const STATUSES = ["yes", "maybe", "no"];
const TIME_ZONE = "Europe/Stockholm";
// Ett pass räknas som "aktuellt" fram till 3 timmar efter start.
const EVENT_GRACE_MS = 3 * 60 * 60 * 1000;
// Så långt fram skapas pass från återkommande serier som saknar slutdatum …
const SERIES_HORIZON_DAYS = 14;
// … och högst så långt fram även om slutdatumet ligger längre bort.
const SERIES_MAX_DAYS = 400;
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

// Skapar pass för alla serier fram till seriens slutdatum (utan slutdatum:
// SERIES_HORIZON_DAYS framåt). Befintliga (även inställda) pass lämnas orörda.
async function fillSeries(env) {
  const { results: series } = await env.DB.prepare("SELECT * FROM series").all();
  if (!series.length) return;
  const today = stockholmToday();
  const now = Date.now();

  // Pass som redan finns framåt, för att bara skriva det som saknas.
  const { results: existing } = await env.DB.prepare(
    "SELECT id, starts_at, series_id FROM events WHERE starts_at > ?"
  )
    .bind(new Date(now).toISOString())
    .all();
  const taken = new Set(existing.filter((e) => e.series_id).map((e) => `${e.series_id}|${e.starts_at}`));
  const manual = new Map(existing.filter((e) => !e.series_id).map((e) => [e.starts_at, e.id]));

  const stmts = [];
  const rows = [];
  for (const s of series) {
    const last = s.end_date
      ? Math.min(Date.parse(s.end_date + "T00:00:00Z"), today + SERIES_MAX_DAYS * DAY_MS)
      : today + SERIES_HORIZON_DAYS * DAY_MS;
    const first = s.start_date ? Math.max(Date.parse(s.start_date + "T00:00:00Z"), today) : today;
    // Första dagen med rätt veckodag, sedan en vecka i taget.
    const firstWeekday = ((new Date(first).getUTCDay() + 6) % 7) + 1;
    for (let day = first + ((s.weekday - firstWeekday + 7) % 7) * DAY_MS; day <= last; day += 7 * DAY_MS) {
      const start = stockholmToUtc(day, s.time);
      if (start <= now) continue;
      const startsAt = new Date(start).toISOString();
      if (taken.has(`${s.id}|${startsAt}`)) continue;
      if (manual.has(startsAt)) {
        // Ett manuellt pass på samma tid tas över av serien (med sina svar) i stället för att dubbleras.
        stmts.push(env.DB.prepare("UPDATE events SET series_id = ? WHERE id = ?").bind(s.id, manual.get(startsAt)));
        manual.delete(startsAt);
        continue;
      }
      rows.push([startsAt, s.location, s.note, s.min_players, s.id]);
    }
  }
  // D1 tillåter högst 100 parametrar per fråga: 20 pass à 5 värden.
  for (let i = 0; i < rows.length; i += 20) {
    const chunk = rows.slice(i, i + 20);
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO events (starts_at, location, note, min_players, series_id)
         VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}`
      ).bind(...chunk.flat())
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
}

// ---------- Mejl ----------

function gmailEnabled(env) {
  return Boolean(env.GMAIL_USER && env.GMAIL_APP_PASSWORD);
}

function mailEnabled(env) {
  return gmailEnabled(env) || Boolean(env.RESEND_API_KEY);
}

// Gmail används om det är inställt, annars Resend.
async function sendMails(env, messages) {
  if (!mailEnabled(env) || !messages.length) return;
  if (gmailEnabled(env)) return sendGmail(env, messages);

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

// ---------- Gmail via SMTP ----------

const SMTP_TIMEOUT_MS = 15000;

function base64Utf8(text) {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// Rubriker med å, ä, ö måste kodas (RFC 2047).
function encodeHeader(text) {
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${base64Utf8(text)}?=`;
}

function buildMail(from, fromName, m) {
  const body = (base64Utf8(m.text).match(/.{1,76}/g) || []).join("\r\n");
  return [
    `From: ${encodeHeader(fromName)} <${from}>`,
    `To: ${m.to.join(", ")}`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@${from.split("@")[1]}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body
  ].join("\r\n");
}

// En minimal SMTP-klient över TLS (port 465). Gmail kräver att avsändaren
// är kontot som loggar in, och lösenordet är ett applösenord.
async function sendGmail(env, messages) {
  const user = env.GMAIL_USER.trim();
  const password = env.GMAIL_APP_PASSWORD.replace(/\s/g, "");
  const socket = connect(
    { hostname: env.SMTP_HOST || "smtp.gmail.com", port: Number(env.SMTP_PORT) || 465 },
    { secureTransport: env.SMTP_TLS === "off" ? "off" : "on" }
  );
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Läser ett helt svar (sista raden har formen "250 ...") och kontrollerar koden.
  async function reply(expected) {
    const deadline = Date.now() + SMTP_TIMEOUT_MS;
    for (;;) {
      const lines = buffer.split("\r\n");
      const end = lines.findIndex((line) => /^\d{3}( |$)/.test(line));
      if (end !== -1) {
        buffer = lines.slice(end + 1).join("\r\n");
        const code = Number(lines[end].slice(0, 3));
        if (code !== expected) throw new Error(`SMTP ${lines.slice(0, end + 1).join(" | ")}`);
        return;
      }
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("SMTP-timeout")), deadline - Date.now());
      });
      const { value, done } = await Promise.race([reader.read(), timeout]).finally(() =>
        clearTimeout(timer)
      );
      if (done) throw new Error("SMTP-anslutningen stängdes");
      buffer += decoder.decode(value, { stream: true });
    }
  }

  async function command(line, expected) {
    await writer.write(new TextEncoder().encode(line + "\r\n"));
    await reply(expected);
  }

  try {
    await reply(220);
    await command("EHLO innebandy", 250);
    await command(`AUTH PLAIN ${base64Utf8(`\0${user}\0${password}`)}`, 235);

    for (const m of messages) {
      try {
        await command(`MAIL FROM:<${user}>`, 250);
        for (const to of m.to) await command(`RCPT TO:<${to}>`, 250);
        await command("DATA", 354);
        await command(buildMail(user, "Innebandy", m) + "\r\n.", 250);
      } catch (err) {
        // En felaktig adress ska inte stoppa resten av mejlen.
        console.error("Gmail", m.to.join(", "), err.message);
        await command("RSET", 250);
      }
    }
    await command("QUIT", 221).catch(() => {});
  } catch (err) {
    console.error("Gmail", err.message);
  } finally {
    await socket.close().catch(() => {});
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

// "YYYY-MM-DD" eller tom sträng. Returnerar null om datumet är ogiltigt.
function cleanDate(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value) ? value : null;
}

// Gemensam kontroll av seriens fält vid skapande och ändring.
function seriesFields(body) {
  const min = Number.isInteger(Number(body.min_players)) ? Number(body.min_players) : 6;
  if (min < 1 || min > 100) return { err: "Minsta antal måste vara 1–100." };
  const start = cleanDate(body.start_date);
  const end = cleanDate(body.end_date);
  if (start === null) return { err: "Ogiltigt startdatum." };
  if (end === null) return { err: "Ogiltigt slutdatum." };
  if (start && end && end < start) return { err: "Slutdatum måste vara efter startdatum." };
  return {
    location: cleanText(body.location, 80),
    note: cleanText(body.note, 300),
    min_players: min,
    start_date: start,
    end_date: end
  };
}

const SERIES_COLUMNS = "id, weekday, time, location, note, min_players, start_date, end_date";

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
      `SELECT ${SERIES_COLUMNS} FROM series ORDER BY weekday, time`
    ).all();
    return json({ series: results });
  }

  if (request.method === "POST" && id === null) {
    const body = await readJson(request);
    const weekday = Number(body.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return error("Välj veckodag.");
    const time = typeof body.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.time) ? body.time : null;
    if (!time) return error("Ogiltig tid.");
    const f = seriesFields(body);
    if (f.err) return error(f.err);
    const series = await env.DB.prepare(
      `INSERT INTO series (weekday, time, location, note, min_players, start_date, end_date)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${SERIES_COLUMNS}`
    )
      .bind(weekday, time, f.location, f.note, f.min_players, f.start_date, f.end_date)
      .first();
    await fillSeries(env);
    return json({ ok: true, series }, 201);
  }

  // Ändrar plats, info, minsta antal och datum. Kommande pass uppdateras, och pass
  // som hamnar utanför det nya datumintervallet tas bort. Veckodag och tid ändras inte.
  if (request.method === "PATCH" && id !== null) {
    const f = seriesFields(await readJson(request));
    if (f.err) return error(f.err);
    const series = await env.DB.prepare(
      `UPDATE series SET location = ?, note = ?, min_players = ?, start_date = ?, end_date = ?
        WHERE id = ? RETURNING ${SERIES_COLUMNS}`
    )
      .bind(f.location, f.note, f.min_players, f.start_date, f.end_date, id)
      .first();
    if (!series) return error("Serien finns inte.", 404);

    const now = new Date().toISOString();
    // Kommande pass i serien vars datum (i svensk tid) ligger utanför intervallet.
    const { results } = await env.DB.prepare(
      "SELECT id, starts_at FROM events WHERE series_id = ? AND starts_at > ?"
    )
      .bind(id, now)
      .all();
    const outside = results
      .filter((e) => {
        const date = new Date(stockholmWallClock(Date.parse(e.starts_at))).toISOString().slice(0, 10);
        return (f.start_date && date < f.start_date) || (f.end_date && date > f.end_date);
      })
      .map((e) => e.id);
    const stmts = [
      env.DB.prepare(
        "UPDATE events SET location = ?, note = ?, min_players = ? WHERE series_id = ? AND starts_at > ?"
      ).bind(f.location, f.note, f.min_players, id, now)
    ];
    for (const eventId of outside) {
      stmts.push(
        env.DB.prepare("DELETE FROM comments WHERE event_id = ?").bind(eventId),
        env.DB.prepare("DELETE FROM responses WHERE event_id = ?").bind(eventId),
        env.DB.prepare("DELETE FROM events WHERE id = ?").bind(eventId)
      );
    }
    await env.DB.batch(stmts);
    await fillSeries(env);
    return json({ ok: true, series });
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

