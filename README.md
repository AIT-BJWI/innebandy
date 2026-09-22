# Innebandy-anmälan – gratis, reklamfri, på Cloudflare Workers

Uppdaterad version. Cloudflares nya enhetliga Workers-modell kräver att
API-logiken ligger i en enda "Worker"-fil och att bindningar (som KV)
deklareras i en `wrangler.jsonc`-fil i repot, istället för att bara
klickas ihop i dashboarden. Annars ger Cloudflare felet
"Bindings cannot be added to a Worker that only has static assets."

## Filer
```
wrangler.jsonc     ← konfiguration: Worker-namn, statiska filer, KV-bindning
src/index.js       ← all serverlogik (anmälan, lista, statiska filer)
public/index.html  ← själva sidan (formulär + lista)
```

## Byt ut era gamla filer
1. I ert GitHub-repo: **ta bort** den gamla `functions/`-mappen helt.
2. Lägg till/ersätt med `wrangler.jsonc` och `src/index.js` från den här mappen.
3. `public/index.html` är oförändrad, den kan ligga kvar som den är.
4. Committa och pusha till `main`.

`wrangler.jsonc` innehåller redan er KV-namespace-ID (`SIGNUPS`) som ni
skapade tidigare, så bindningen sätts upp automatiskt av Cloudflare när
den läser filen — ni behöver INTE lägga till den manuellt i
dashboarden längre.

## Efter push
1. Gå till ert projekt i Cloudflare → fliken **Deployments**
2. En ny deploy bör starta automatiskt (annars: **Retry deployment**)
3. Kontrollera i loggen att den hittar `wrangler.jsonc` och bygger utan fel
4. Gå till **Settings → Bindings** och bekräfta att `SIGNUPS` (KV namespace)
   nu visas där, under både Production och Previews — den kommer nu
   från filen, inte från ett manuellt klick

## Om ni behöver ändra KV-namespacets ID
Om `1c5440a89c9e487b8840fae5634d5f41` i `wrangler.jsonc` inte stämmer
(t.ex. om ni skapat om namespacet): gå till **Storage & Databases → KV**,
öppna namespacet `SIGNUPS`, kopiera dess ID, och klistra in det i
`wrangler.jsonc` istället.

## Valfritt: mejl vid anmälan
Samma som tidigare — lägg till dessa som **Environment variables** under
**Settings → Variables and Secrets**:
- `RESEND_API_KEY` = er Resend-nyckel (gratis konto på resend.com)
- `NOTIFY_EMAILS` = t.ex. `anna@mail.se,bjorn@mail.se`
- `FROM_EMAIL` = avsändaradress
- `MIN_PLAYERS` = t.ex. `6`

## Anpassa
- Byt ut namnen i `KNOWN_PLAYERS`-listan i `public/index.html` mot era 8 namn.
- Ändra `MIN_PLAYERS` i både `index.html` och miljövariabeln.
