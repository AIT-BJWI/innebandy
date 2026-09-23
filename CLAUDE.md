# CLAUDE.md

Reklamfri anmälningssida för innebandy (som bokat.se). Varje spelare har en
personlig länk och svarar Ja/Kanske/Nej på nästa pass. Allt körs på en
Cloudflare Worker med D1-databas. Inget ramverk och inget byggsteg: ren
JavaScript, HTML och CSS.

- Live: https://innebandy.wiklund-bjorn.workers.dev (admin på `/admin`)
- Repo: https://github.com/AIT-BJWI/innebandy
- Allt användaren ser är på **svenska**, liksom kodkommentarer och commit-meddelanden.

## Filer

```
src/index.js        Worker: API, admin-API, cron (fetch + scheduled)
public/index.html   Anmälningssidan (spelare)
public/admin.html   Adminsidan (pass, serier, spelare, länkar)
migrations/*.sql    D1-schema, numrerade (0001_, 0002_, …)
wrangler.jsonc      Worker-konfig: assets, D1, previews, cron, vars
```

Sidorna är fristående filer med inbäddad `<style>` och `<script>`. Färger är
CSS-variabler på `:root` med mörkt läge via `prefers-color-scheme`. Behåll
samma tokens och utseende på båda sidorna.

## Kommandon

**Node:** den här datorns Homebrew ligger i `/usr/local` och är Intel-versionen,
och dess `node` (x86_64) fungerar inte med projektets arm64-paket (workerd).
Använd alltid Node i `~/.local/node` och `gh` i `~/.local/bin`:

```bash
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
```

| Vad | Kommando |
|---|---|
| Lokal server (migrerar lokal DB först) | `npm run dev` → http://localhost:8787 |
| Testa cron lokalt | `npx wrangler dev --test-scheduled`, sedan `curl localhost:8787/__scheduled` |
| Migrera produktion | `npm run migrate` |
| Migrera förhandsdatabasen | `npx wrangler d1 execute innebandy-preview --remote --file migrations/<fil>.sql -y` |
| SQL mot produktion | `npx wrangler d1 execute innebandy --remote --command "…"` |

Lokalt admin-lösenord står i `.dev.vars` (`ADMIN_TOKEN=lokal-test`). Filen är gitignorerad.

## Arkitektur

**Behörighet**
- *Spelare* identifieras av headern `X-Player-Token`. Token kommer från länken
  `/?p=<token>` och sparas i `localStorage` (`innebandy-token`).
- *Admin* skickar `Authorization: Bearer <ADMIN_TOKEN>` och jämförs med
  `timingSafeEqual`. Adminsidan sparar lösenordet i `localStorage`
  (`innebandy-admin`). Startsidan skickar det också, så att admin kan ta bort
  kommentarer.
- Publika svar får aldrig innehålla `token`, `email` eller `player_id`.

**API**
- `GET /api/event`: nästa pass (inte inställt, fram till 3 h efter start),
  spelarlista med svar, kommentarer och `me`.
- `PUT /api/response`, `POST /api/comments`, `DELETE /api/comments/:id`
- `/api/admin/{players|events|series}[/:id]` med GET/POST/PATCH/DELETE.
  För players gör `POST /:id` en ny länk och `PATCH /:id` sparar e-post.

**Databas** (`migrations/`)
- `players` (name UNIQUE NOCASE, token, email)
- `events` (starts_at i UTC-ISO, min_players, series_id, cancelled, notified_at, reminded_at)
- `responses` (PK event_id + player_id; upsert, så samtidiga svar krockar inte)
- `series` (weekday 1 = måndag, time "HH:MM" i Stockholmstid)
- `comments`

**Återkommande pass**
- `fillSeries()` skapar pass `SERIES_HORIZON_DAYS` (14) dagar framåt. Den körs
  av cron varje timme, när en serie skapas och vid `GET /api/admin/events`.
- Det unika indexet `(series_id, starts_at)` gör att `INSERT OR IGNORE` aldrig
  dubblerar pass.
- Seriepass **ställs in** (`cancelled = 1`) i stället för att tas bort, annars
  återskapas de.
- Ett manuellt pass på samma tid tas över av serien.

**Tider**
- Lagras alltid i UTC.
- Omvandling från Stockholmstid görs med `stockholmToUtc()`, som hanterar
  sommar- och vintertid.
- Visning sker med `Intl.DateTimeFormat` och `timeZone: "Europe/Stockholm"`.

**Mejl** via Resends batch-API
- Kräver hemligheten `RESEND_API_KEY`. Utan den hoppas all mejlkod över.
- Påminnelse skickas en gång per pass (`reminded_at`, markeras innan sändning)
  till spelare med e-post som inte svarat nej.
- "Blir av"-mejlet går till `NOTIFY_EMAILS` en gång (`notified_at`).
- Länkarna byggs från `SITE_URL` i `wrangler.jsonc`.
- **Status:** Resend är inte konfigurerat än, varken nyckel eller verifierad domän.

## Arbetsflöde

1. Jobba på en **egen branch** och öppna en PR mot `main` (`gh pr create`).
   Pusha aldrig direkt till `main`.
2. Workers Builds bygger en förhandsversion per branch med `npx wrangler preview`:
   `https://<branch>-innebandy.wiklund-bjorn.workers.dev`. Den använder
   databasen `innebandy-preview` (via `previews`-blocket), inte produktionen.
3. **Användaren godkänner varje merge.** Fråga innan du mergar.
4. Merge till `main` deployar automatiskt till produktion. Verifiera efteråt
   med `gh api repos/AIT-BJWI/innebandy/commits/main/check-runs` och ett par
   `curl` mot live-sajten.

**Nya migreringar**
- Lägg till en ny numrerad fil. Ändra aldrig en migrering som redan är körd.
- Håll dem bakåtkompatibla: nya tabeller och kolumner med default, så att
  gammal kod fortsätter att fungera.
- Kör mot `innebandy-preview` innan PR:en pushas, så att förhandsbygget fungerar.
- Kör mot produktionen (`npm run migrate`) **innan** merge, med användarens godkännande.
- `wrangler d1 migrations apply` hittar inte förhandsdatabasen. Använd `d1 execute --file`.

## Testa

- Testa API:t med skript mot `wrangler dev` (Python med `urllib` fungerar bra).
- Kontrollera UI:t i webbläsaren i mobilbredd (390 px), i både ljust och mörkt
  läge. Spelarna använder främst iPhone.
- Verktygets Enter-tryck skickar inte formulär. Använd `form.requestSubmit()`.
- `confirm()` godkänns inte automatiskt i webbläsarverktyget.
- Den lokala D1-databasen hör ihop med `database_id`. Rensa med
  `rm -rf .wrangler/state` och kör sedan `wrangler d1 migrations apply innebandy --local`.
- zsh delar inte upp `$var` på mellanslag. Undvik `set -- $pair` i skalskript.

## Att tänka på

- **Tidszoner:** Workern kör i UTC. Formatera eller räkna aldrig datum utan `TIME_ZONE`.
- **Admin-lösenordet** är kort (7 tecken). Föreslå gärna ett längre:
  `npx wrangler secret put ADMIN_TOKEN`.
- **Den gamla KV-kopplingen** `SIGNUPS` används inte längre och kan tas bort i Cloudflare.
- **Idéer framåt:** sluttid och maxantal per pass, mejlkonfiguration (Resend
  med egen domän), egen domän för sajten.
