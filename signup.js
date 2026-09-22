import { currentWeekKey } from "../_week.js";

async function notify(env, week, players) {
  // Skickas bara om RESEND_API_KEY och NOTIFY_EMAILS är satta som miljövariabler.
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAILS) return;

  const min = Number(env.MIN_PLAYERS || 6);
  const enough = players.length >= min;
  const subject = enough
    ? `✅ Innebandy blir av! (${players.length} anmälda)`
    : `Innebandy: ${players.length}/${min} anmälda hittills`;

  const body = `${players.length} anmälda den här veckan (${week}):\n\n${players
    .map((p) => "- " + p)
    .join("\n")}\n\n${enough ? "Vi är tillräckligt många!" : `Behöver ${min - players.length} till.`}`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL || "innebandy@resend.dev",
      to: env.NOTIFY_EMAILS.split(",").map((s) => s.trim()),
      subject,
      text: body
    })
  });
}

export async function onRequestPost({ request, env }) {
  const { name } = await request.json();
  if (!name || typeof name !== "string") {
    return Response.json({ ok: false, error: "Namn saknas." }, { status: 400 });
  }

  const key = currentWeekKey();
  const raw = await env.SIGNUPS.get(key);
  const players = raw ? JSON.parse(raw) : [];

  if (players.includes(name)) {
    return Response.json({ ok: false, error: "Du är redan anmäld." }, { status: 409 });
  }

  players.push(name);
  await env.SIGNUPS.put(key, JSON.stringify(players));
  await notify(env, key, players);

  return Response.json({ ok: true, players });
}

export async function onRequestDelete({ request, env }) {
  const { name } = await request.json();
  const key = currentWeekKey();
  const raw = await env.SIGNUPS.get(key);
  let players = raw ? JSON.parse(raw) : [];
  players = players.filter((p) => p !== name);
  await env.SIGNUPS.put(key, JSON.stringify(players));
  return Response.json({ ok: true, players });
}
