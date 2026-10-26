# Unbusyness Business: MVP

AI office manager for trade businesses: calls → quotes → jobs → invoices → payments.

**Kaj zna:**

- **Klici:** voice agent (Retell, Vapi, ElevenLabs ali drug) pošlje vsak klic v aplikacijo. Iz klica nastane naloga, osnutek ponudbe ali rezervacija.
- **Drevo nalog ("Today"):** vse, kar potrebuje lastnika, na enem mestu.
- **Stranke:** zgodovina klicev, ponudb, jobov in računov za vsako stranko.
- **Ponudbe:** AI pripravi osnutek iz cenika. Lastnik potrdi in pošlje, stranka sprejme s klikom. Po 3 dneh gre samodejni opomnik.
- **Jobi:** tedenski koledar, dodelitev delavcu ali sebi, statusi *Na poti → Začel → Končano* in fotografije z oznako "Job photo" ali "Invoice".
- **Računi:** samodejno iz končanega joba, s številko in davkom. Plačilo prek Stripe, samodejni opomniki za neplačane in izvoz CSV za računovodjo.
- **Ekipa:** delavci se prijavijo s povabilom in vidijo samo svoje jobe, brez cen.
- **Telefon:** aplikacijo dodaš na začetni zaslon (PWA).
- **Vloge:** Owner/Director, Manager in Employee/Worker. Vsako podjetje ima ločene podatke, ena oseba je lahko v več podjetjih.
- **Integracije:** e-mail (Gmail, Microsoft 365, IMAP/SMTP) in koledar (Google, Microsoft). V koledar gredo samo termini, naloge ostanejo v Unbusyness.

## Zagon na Replitu (prvič)

1. **Ustvari Repl:** na replit.com klikni **Create Repl → Import** in naloži to mapo (ZIP), ali pa uvozi iz GitHuba.
2. **Baza:** odpri orodje **Database** (PostgreSQL) in jo ustvari. Replit sam doda `DATABASE_URL`.
3. **Prijava (Replit Auth):** deluje samodejno prek `REPL_ID`, ki ga Replit nastavi sam. Gumb "Log in with Replit" je že na prijavni strani.
   - Za demo brez Replit računa dodaj Secret `DEV_LOGIN=1`. Pojavi se prijava samo z imenom in e-mailom. **Za prave stranke tega ne vklopi.**
4. Klikni **Run**. Aplikacija sama ustvari tabele v bazi.
5. Odpri spletni pogled, prijavi se in vpiši podatke podjetja.
6. **Objava:** **Deploy → Reserved VM**. Ta vrsta je potrebna, ker aplikacija vsakih 15 minut pošilja opomnike.

## Secrets (Replit → Tools → Secrets)

Vse je neobvezno. Brez ključa aplikacija deluje, sporočila pa se samo shranijo v **Settings → Messages**, namesto da bi se poslala.

| Secret | Za kaj | Kje ga dobiš |
|---|---|---|
| `RESEND_API_KEY` | Pošiljanje e-mailov (ponudbe, računi, opomniki) | resend.com → API Keys |
| `MAIL_FROM` | Pošiljatelj, npr. `office@unbusyness.com` | Domeno najprej potrdiš v Resendu |
| `ANTHROPIC_API_KEY` | AI osnutki ponudb iz klica | console.anthropic.com. Brez ključa aplikacija izbere postavke iz cenika po ključnih besedah. |
| `AI_MODEL` | Neobvezno, privzeto `claude-sonnet-5-5` | |
| `STRIPE_SECRET_KEY` | Plačila računov (Stripe Connect) | dashboard.stripe.com → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | Samodejno označi plačane račune | Stripe → Webhooks → endpoint `https://<tvoja-domena>/api/webhooks/stripe`, dogodka `checkout.session.completed` in `account.updated` |
| `PLATFORM_FEE_PCT` | Tvoj delež od plačil, privzeto `0.5` | |
| `STRIPE_ALLOW_PLATFORM` | `1` = gumb "Pay" deluje že pred povezavo Stripe računa podjetja (za testiranje) | |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | SMS strankam in lastniku | twilio.com. V ZDA najprej registracija A2P 10DLC. |
| `ENCRYPTION_KEY` | **Obvezno za integracije.** Šifriranje žetonov in gesel | glej "Integracije" |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Gmail + Google Calendar | Google Cloud Console |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Outlook / Microsoft 365 + koledar | Microsoft Entra |
| `PUBLIC_URL` | Neobvezno, npr. `https://app.unbusyness.com`, za povezave v samodejnih opomnikih | |

## Vloge in dostop

| Vloga | Lahko |
|---|---|
| **Owner / Director** | Vse: denar, nastavitve, integracije, ekipa. |
| **Manager** | Ekipa (razen lastnikov), stranke, klici, jobi, naloge, koledar, e-mail. Brez cen, ponudb in računov. |
| **Employee / Worker** | Samo svoji jobi, svoje naloge in svoj urnik. Brez cen. |

- **Preverjanje na strežniku:** pravice se preverjajo na strežniku pri vsakem klicu. Skrivanje gumbov v vmesniku je samo za preglednost.
- **Ločeni podatki:** vsak podatek pripada enemu podjetju. Vsaka poizvedba je omejena na aktivno podjetje uporabnika.
- **Več podjetij:** zveza User + Membership + Company pomeni, da je ena oseba lahko v več podjetjih in jih menja v stranskem meniju.
- **Nove vloge ali pravice:** dodaš jih v `lib/rbac.js` (seznam `PERMISSIONS` in `ROLES`). Vlogo samo za eno podjetje dodaš v tabelo `company_roles`.

## Integracije (Settings → Integrations)

Najprej obvezno dodaj Secret **`ENCRYPTION_KEY`**: z njim se šifrirajo žetoni in gesla. Ustvariš ga v Replit Shellu:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Shrani ga na varno. Če ga izgubiš ali zamenjaš, je treba vse račune ponovno povezati.

### Google (Gmail + Google Calendar)

1. Na console.cloud.google.com ustvari projekt.
2. Vklopi **Gmail API** in **Google Calendar API**.
3. **OAuth consent screen:** tip External, dodaj svoj e-mail. Dokler je aplikacija v načinu **Testing**, dodaj pod **Test users** e-maile prvih strank (do 100).
4. **Credentials → Create OAuth client ID → Web application.** Pod Authorized redirect URI vpiši naslov, ki ga vidiš v *Settings → Integrations → Setup details*, npr. `https://<tvoja-domena>/api/integrations/oauth/google/callback`.
5. V Replit Secrets dodaj `GOOGLE_CLIENT_ID` in `GOOGLE_CLIENT_SECRET`.

Gmail obsegi (branje, osnutki, pošiljanje) so pri Googlu "restricted". Za javni zagon bo Google zahteval preverjanje aplikacije (varnostni pregled). Za ročno uvajanje prvih strank zadošča način Testing.

### Microsoft (Outlook / Microsoft 365 + koledar)

1. Na entra.microsoft.com odpri **App registrations → New registration**.
2. Pod Supported account types izberi "Accounts in any organizational directory and personal Microsoft accounts".
3. **Redirect URI:** platforma Web, naslov `https://<tvoja-domena>/api/integrations/oauth/microsoft/callback`.
4. **Certificates & secrets → New client secret.**
5. **API permissions (Delegated):** `offline_access`, `openid`, `email`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`.
6. V Replit Secrets dodaj `MICROSOFT_CLIENT_ID` in `MICROSOFT_CLIENT_SECRET`. Neobvezno še `MICROSOFT_TENANT`, privzeto `common`.

Nekatera podjetja zahtevajo soglasje svojega IT skrbnika ("admin consent").

### IMAP / SMTP (ročno uvajanje)

Za vse ostale poštne strežnike. Vpišeš strežnik, vrata, uporabniško ime in geslo (pri Gmailu/iCloudu je to "app password"). Povezava se preizkusi, preden se shrani. Uporablja pakete `imapflow`, `nodemailer` in `mailparser`, ki jih Replit namesti z `npm install`.

### Kaj se zgodi po povezavi

- **E-mail:** ponudbe, računi in opomniki odidejo z lastnikovega pravega naslova. Na strani stranke se prikažejo e-maili s to stranko, na katere lahko odgovoriš ali shraniš osnutek. Brez povezanega nabiralnika se uporabi Resend, brez Resenda pa se sporočilo samo shrani.
- **Koledar:** v koledar gredo samo **termini**, torej jobi, ogledi stranke, inšpekcije in sestanki s časom. Notranje **naloge** ("pokliči dobavitelja", "pošlji ponudbo") ostanejo samo v Unbusyness. Rezervacija, ki jo zahteva AI, gre v koledar šele, ko jo potrdiš.
- **Smer sinhronizacije:** samo v eno smer (Unbusyness → koledar). Unbusyness je vir resnice: sprememba v Google ali Outlook koledarju se ob naslednji spremembi v Unbusyness prepiše.
- **Napake:** če koledar ne deluje, se job vseeno shrani. Napaka se pokaže pri jobu in v integracijah, gumb **Sync now** pa poskusi znova.

## Povezava voice agenta

Navodila za podjetje, ki dela voice agenta, so v **VOICE_INTEGRATION.md**. Pošlji jim to datoteko.

Pot v aplikaciji: **Settings → Voice agent**.

1. Izberi platformo (Retell, Vapi, ElevenLabs ali Generic).
2. Kopiraj URL za dogodke po klicu in URL-je za orodja med klicem.
3. Po potrebi vpiši skrivnost platforme (npr. Retell API key).

Pod **Recent deliveries** vidiš vsak prejeti klic in klic orodja, zato hitro ugotoviš, ali povezava deluje. Gumb **Test call** pošlje testni klic, tudi brez voice agenta.

## Struktura

```
server.js              zagon strežnika, usmerjanje
lib/db.js              baza (Postgres)
lib/schema.sql         tabele (izvede se ob vsakem zagonu, varno)
lib/auth.js            prijava (Replit Auth), seje, povabila ekipe, izbira podjetja
lib/rbac.js            vloge in pravice (dodaš nove tukaj)
lib/api.js             vse funkcije aplikacije (klici, stranke, ponudbe, jobi, računi, opomniki)
lib/voice/             plast za voice agente (ločena od jedra)
  contract.js          en skupen format klica in seznam orodij
  adapters.js          prevod za Retell, Vapi, ElevenLabs, Generic
  tools.js             orodja med klicem (prosti termini, rezervacija, povratni klic)
  index.js             naslovi, preverjanje podpisov, dnevnik
lib/integrations/      e-mail in koledar (ločeno od jedra)
  email.js             skupne funkcije: listThreads, getThread, createDraft, send (Gmail, Microsoft, IMAP)
  calendar.js          skupne funkcije + enosmerna sinhronizacija terminov (Google, Microsoft)
  oauth.js             OAuth za Google in Microsoft, osveževanje žetonov
  vault.js             šifriranje poverilnic (AES-256-GCM)
  index.js             Settings → Integrations in e-mail API
lib/services.js        e-mail (prek povezanega nabiralnika ali Resend), SMS, AI, Stripe
lib/docs.js            videz ponudb in računov (A4, PDF)
public/                aplikacija (HTML, CSS, JS, brez build koraka)
```

## Lokalni razvoj (neobvezno)

```
npm install
DATABASE_URL=postgres://... DEV_LOGIN=1 node server.js
```

Brez nameščenega paketa `pg` lahko uporabiš `PSQL_SHIM=1`: poizvedbe gredo prek ukaza `psql`. To je samo za testiranje.
