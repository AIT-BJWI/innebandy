function currentWeekKey() {
  const now = new Date();
  const target = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
  );
  return `signups:${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function notify(env, week, players) {
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/list" && request.method === "GET") {
      const key = currentWeekKey();
      const raw = await env.SIGNUPS.get(key);
      const players = raw ? JSON.parse(raw) : [];
      return Response.json({ week: key, players });
    }

    if (url.pathname === "/api/signup" && request.method === "POST") {
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

    if (url.pathname === "/api/signup" && request.method === "DELETE") {
      const { name } = await request.json();
      const key = currentWeekKey();
      const raw = await env.SIGNUPS.get(key);
      let players = raw ? JSON.parse(raw) : [];
      players = players.filter((p) => p !== name);
      await env.SIGNUPS.put(key, JSON.stringify(players));
      return Response.json({ ok: true, players });
    }

    // Allt annat: servera statiska filer från public/
    return env.ASSETS.fetch(request);
  }
};
