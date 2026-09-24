# Innebandy-anmälan

En enkel, variant av bokat.se. Varje spelare får en personlig länk
och svarar **Ja / Kanske / Nej** på nästa pass. Körs på
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
- **Återkommande pass** (t.ex. måndagar 19:30) läggs in på adminsidan. Passen
  skapas automatiskt två veckor framåt. Ett enskilt tillfälle kan ställas in
  (t.ex. en helgdag) utan att det skapas igen. Finns det redan ett manuellt pass
  på samma tid tar serien över det, med svaren.
- **Kommentarer**: alla med personlig länk kan kommentera passet och ta bort
  sina egna kommentarer. Den som är inloggad som admin i samma webbläsare kan
  ta bort alla.
- **Mejl före varje pass** till spelare med e-post (läggs in på adminsidan),
  med deras personliga länk. Kräver att mejl är inställt (se nedan).
  - 3 dagar före kl. 12: inbjudan till alla (för ett måndagspass alltså fredag kl. 12).
  - Samma dag kl. 9: påminnelse till dem som inte har svarat.
  - Samma dag kl. 13: vilka som kommer, kanske kommer, inte kan och inte har svarat, till alla.
- **Inställt pass**: när ett kommande pass ställs in får alla med e-post ett mejl.
- Om mejl är inställt skickas också **ett** mejl till `NOTIFY_EMAILS` när
  tillräckligt många har svarat ja.
- En schemalagd körning (Cron Trigger) går varje timme och fyller på
  återkommande pass och skickar de schemalagda mejlen.

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

Testa den schemalagda körningen lokalt med `npx wrangler dev --test-scheduled`
och öppna http://localhost:8787/__scheduled.

## Nya databasmigreringar
Lägg en ny fil i `migrations/` och kör den mot båda databaserna **innan**
koden deployas:
```bash
npm run migrate
npx wrangler d1 execute innebandy-preview --remote --file migrations/<fil>.sql
```

## Mejl: påminnelser och "passet blir av"
Mejl kan skickas från ett **Gmail-konto** (gratis, ingen egen domän behövs)
eller via [Resend](https://resend.com) (kräver egen domän). Är Gmail inställt
används det, annars Resend. Utan något av dem skickas inga mejl.

### Alternativ 1: Gmail
1. Skapa gärna ett separat konto, t.ex. `innebandy.gaget@gmail.com`.
2. Slå på **tvåstegsverifiering** för kontot (myaccount.google.com → Säkerhet).
3. Skapa ett **applösenord** på https://myaccount.google.com/apppasswords
   (16 tecken; mellanslagen spelar ingen roll).
4. Sätt båda som hemligheter:
   ```bash
   npx wrangler secret put GMAIL_USER
   npx wrangler secret put GMAIL_APP_PASSWORD
   ```
Mejlen skickas från Gmail-adressen med avsändarnamnet "Innebandy". Gmail
tillåter cirka 500 mejl per dygn.

### Alternativ 2: Resend
1. Skapa ett konto på resend.com och en API-nyckel.
2. För att kunna mejla vem som helst måste ni **verifiera en egen domän** i
   Resend (DNS-poster). Utan egen domän kan Resend bara skicka till den
   e-postadress kontot är registrerat på.
3. Sätt nyckeln som hemlighet:
   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```
4. Lägg till `FROM_EMAIL` under **Settings → Variables and Secrets** i
   Cloudflare, t.ex. `Innebandy <innebandy@er-doman.se>` (på den verifierade domänen).

### Gemensamt
- `NOTIFY_EMAILS` = valfritt, t.ex. `anna@mail.se,bjorn@mail.se`, för mejlet
  när passet blir av. Läggs under **Settings → Variables and Secrets**.

`SITE_URL` i `wrangler.jsonc` används för länkarna i mejlen. Byt den om ni
flyttar sajten till en egen domän.

Minsta antal spelare sätts nu per pass på adminsidan, så `MIN_PLAYERS`
behövs inte längre.

## Från den gamla versionen
Den gamla versionen sparade anmälningar i KV (`SIGNUPS`). De används inte
längre och flyttas inte över. KV-namespacet kan tas bort i Cloudflare när
den nya versionen fungerar.
