# Innebandy-anmälan – gratis, reklamfri, på Cloudflare Pages

En liten sida där ni 8 anmäler er till nästa pass. Listan nollställs
automatiskt varje ny vecka (ingen manuell "reset" behövs). Valfritt:
skicka ett mejl till gruppen varje gång någon anmäler sig.

## Filer
```
public/index.html        ← själva sidan (formulär + lista)
functions/api/list.js     ← hämtar aktuell veckas anmälda
functions/api/signup.js   ← anmäl / avanmäl + ev. mejlutskick
functions/_week.js        ← hjälpfunktion för veckonumret
```

## Steg 1 – Lägg koden på GitHub
1. Skapa ett gratis GitHub-konto om du inte har ett.
2. Skapa ett nytt repo, t.ex. `innebandy`, och lägg in dessa filer
   (behåll mappstrukturen).

## Steg 2 – Cloudflare Pages
1. Skapa ett gratis konto på https://dash.cloudflare.com
2. Gå till **Workers & Pages → Create → Pages → Connect to Git**
   och välj ditt repo.
3. Build settings: lämna "Build command" tomt, **Build output
   directory: `public`** (functions-mappen hittas automatiskt).
4. Deploy. Ni får en gratis adress typ `innebandy.pages.dev`.

## Steg 3 – Lagring (KV) för anmälningarna
1. I Cloudflare-dashboarden: **Workers & Pages → KV → Create a
   namespace**, kalla den t.ex. `SIGNUPS`.
2. Gå till ert Pages-projekt → **Settings → Functions → KV
   namespace bindings → Add binding**:
   - Variable name: `SIGNUPS`
   - KV namespace: den ni just skapade
3. Deploya om (Retry deployment) så bindingen slår igenom.

Nu funkar anmälan och listan – helt gratis, ingen reklam.

## Steg 4 – Valfritt: mejl vid anmälan
1. Skapa ett gratis konto på https://resend.com (100 mejl/dag gratis,
   räcker med marginal för 8 personer).
2. Skapa en API-nyckel.
3. I Pages-projektet → **Settings → Environment variables**, lägg till:
   - `RESEND_API_KEY` = er nyckel
   - `NOTIFY_EMAILS` = t.ex. `anna@mail.se,bjorn@mail.se` (kommaseparerat)
   - `FROM_EMAIL` = en avsändaradress (Resend ger er en gratis
     `@resend.dev`-adress att testa med om ni inte har egen domän)
   - `MIN_PLAYERS` = t.ex. `6` (hur många som behövs för att det blir av)
4. Deploya om.

Utan dessa variabler fungerar sidan precis lika bra – ni missar bara
mejlutskicket och kollar listan i webbläsaren istället.

## Anpassa
- Byt ut namnen i `KNOWN_PLAYERS`-listan i `index.html` mot era 8 namn
  (eller lämna tom så skriver alla sitt namn själva varje gång).
- Ändra `MIN_PLAYERS` i både `index.html` och miljövariabeln.
