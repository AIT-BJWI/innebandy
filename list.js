import { currentWeekKey } from "../_week.js";

export async function onRequestGet({ env }) {
  const key = currentWeekKey();
  const raw = await env.SIGNUPS.get(key);
  const players = raw ? JSON.parse(raw) : [];
  return Response.json({ week: key, players });
}
