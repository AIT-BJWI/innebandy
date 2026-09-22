# Innebandy-anmälan – gratis, reklamfri, på Cloudflare Workers

En enkel, reklamfri variant av bokat.se. Varje spelare får en personlig länk
och svarar **Ja / Kanske / Nej** på nästa pass. Allt körs gratis på
Cloudflare Workers med en D1-databas.

## Filer
```
wrangler.jsonc          ← konfiguration: Worker, statiska filer, D1-databas
src/index.js            ← all serverlogik (API för pass, svar och admin)
migrations/             ← databasschema (körs med wrangler d1 migrations)
public/index.html       ← sidan spelarna ser
public/admin.html       ← adminsida (/admin): lägg till pass och spelare, kopiera länkar
```

## Så funkar det
- **Admin** går till `/admin`, loggar in med `ADMIN_TOKEN`, lägger till
  spelare och pass.
- Varje spelare får en **personlig länk** (`/?p=…`) som admin kopierar och
  skickar, t.ex. i gruppchatten privat. Länken sparas i webbläsaren, så
  spelaren behöver bara öppna den en gång.
- Startsidan visar alltid **nästa pass** (fram till 3 timmar efter start).
  Alla kan se listan, men bara den som har en länk kan svara, och bara för sig
  själv.
- Om mejl är inställt skickas **ett** mejl när tillräckligt många har svarat
  ja.

## Första gången: skapa databasen
Kräver Node.js (`brew install node`).

```bash
npm install
npx wrangler login
npx wrangler d1 create innebandy
```

Kopiera `database_id` som skrivs ut och klistra in det i `wrangler.jsonc`.
Skapa sedan tabellerna i den riktiga databasen:

```bash
npm run migrate
```

Sätt admin-lösenordet som en hemlighet (välj något långt och slumpmässigt):

```bash
npx wrangler secret put ADMIN_TOKEN
```

## Deploy
**Med GitHub-kopplingen (Workers Builds):** pusha till `main` som vanligt.
Sätt gärna *Deploy command* under **Settings → Build** till
`npm run deploy`, så körs nya databasmigreringar automatiskt före varje deploy.

**Manuellt:** `npm run deploy`

## Lokal utveckling
```bash
cp .dev.vars.example .dev.vars   # sätt ett ADMIN_TOKEN för lokalt bruk
npm run dev
```
Öppna http://localhost:8787/admin. Den lokala databasen ligger i
`.wrangler/` och påverkar inte den riktiga.

## Valfritt: mejl när passet blir av
Lägg till under **Settings → Variables and Secrets** i Cloudflare:
- `RESEND_API_KEY` = er Resend-nyckel (gratis konto på resend.com), som *secret*
- `NOTIFY_EMAILS` = t.ex. `anna@mail.se,bjorn@mail.se`
- `FROM_EMAIL` = avsändaradress

Minsta antal spelare sätts nu per pass på adminsidan, så `MIN_PLAYERS`
behövs inte längre.

## Från den gamla versionen
Den gamla versionen sparade anmälningar i KV (`SIGNUPS`). De används inte
längre och flyttas inte över. KV-namespacet kan tas bort i Cloudflare när
den nya versionen fungerar.
