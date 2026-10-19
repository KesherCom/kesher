# Kesher – Anleitung für Nutzer

*English version: [en.md](en.md)*

Diese Anleitung ist für alle, die Kesher im Gottesdienst oder bei einer
Veranstaltung benutzen: Ton, Licht, Video, Kamera, Bühne, Regie. Man braucht
dafür keine Technikkenntnisse.

- **Teil A** erklärt die Bedienung – für alle, die mit Kesher sprechen.
- **Teil B** ist für die Person, die Kesher einrichtet und verwaltet
  (Technik-Leitung).

Die Bedienoberfläche von Kesher ist auf Englisch. In dieser Anleitung stehen
die Beschriftungen deshalb so, wie sie auf dem Bildschirm erscheinen, z. B.
**„Hold to talk“**, mit der deutschen Erklärung daneben.

---

## Inhalt

**Teil A – Bedienung**

1. [Was ist Kesher?](#1-was-ist-kesher)
2. [Die wichtigsten Begriffe](#2-die-wichtigsten-begriffe)
3. [Womit kann ich Kesher benutzen?](#3-womit-kann-ich-kesher-benutzen)
4. [Verbinden und anmelden](#4-verbinden-und-anmelden)
5. [Der Hauptbildschirm](#5-der-hauptbildschirm)
6. [Sprechen](#6-sprechen)
7. [Zuhören und Lautstärke](#7-zuhören-und-lautstärke)
8. [Rufen und Rufe beantworten](#8-rufen-und-rufe-beantworten)
9. [Chat](#9-chat)
10. [Die einfache Ansicht (Handy)](#10-die-einfache-ansicht-handy)
11. [Einstellungen](#11-einstellungen)
12. [Stream Deck](#12-stream-deck)
13. [Raspberry-Pi-Station](#13-raspberry-pi-station)
14. [Tipps für den Einsatz](#14-tipps-für-den-einsatz)
15. [Wenn etwas nicht geht](#15-wenn-etwas-nicht-geht)

**Teil B – Einrichten und verwalten**

16. [Server installieren](#16-server-installieren)
17. [Ersteinrichtung](#17-ersteinrichtung)
18. [Der Admin-Bereich](#18-der-admin-bereich)
19. [Rollen und Party-Lines einrichten](#19-rollen-und-party-lines-einrichten)
20. [Stationen und Stream Decks freigeben](#20-stationen-und-stream-decks-freigeben)
21. [Sicherung, PIN und weitere Einstellungen](#21-sicherung-pin-und-weitere-einstellungen)
22. [Netzwerk – was die Technik-Leitung wissen muss](#22-netzwerk--was-die-technik-leitung-wissen-muss)

---

# Teil A – Bedienung

## 1. Was ist Kesher?

Kesher ist eine **Intercom-Anlage**: Das Technik-Team spricht damit während
einer Veranstaltung miteinander – wie mit Funkgeräten, aber über das
vorhandene Netzwerk (LAN oder WLAN).

- Man hört und spricht über ein **Headset** (Kopfhörer mit Mikrofon).
- Gesprochen wird auf **Party-Lines** (Gesprächskanäle), z. B. „FOH“ oder
  „Stage“, oder **direkt** mit einer einzelnen Person.
- Man kann Kesher im **Browser**, in der **Desktop-App**, auf dem **Handy**,
  mit einem **Stream Deck** oder an einer festen **Raspberry-Pi-Station**
  benutzen. Alle hören sich gegenseitig, egal welches Gerät sie haben.

## 2. Die wichtigsten Begriffe

| Begriff | Bedeutung |
| --- | --- |
| **Party-Line** | Ein Gesprächskanal für eine Gruppe, z. B. „FOH“, „Stage“, „Livestream“. Wer zuhört, hört alle, die auf dieser Line sprechen. |
| **Rolle** | Deine Aufgabe, z. B. „Audio“, „Video“, „Camera“. Die Rolle bestimmt, auf welchen Party-Lines du sprechen und zuhören darfst. Mehrere Personen können dieselbe Rolle haben. |
| **Direktgespräch** | Du sprichst mit genau einer Person. Nur sie hört dich. |
| **Broadcast-Kanal** | Ein Knopf, mit dem du auf mehreren Party-Lines gleichzeitig sprichst – für Durchsagen an alle, z. B. „All Tech“. |
| **Ruf (Call)** | Ein Signal, damit jemand aufmerksam wird – wie ein Klingeln. Es blinkt gelb. |
| **Sprechtaste (Push-to-talk)** | Du sprichst nur, solange du die Taste gedrückt hältst. Das ist der Normalfall. |
| **Offenes Mikrofon (Always on)** | Dein Mikrofon ist dauerhaft offen, ohne Taste. |
| **Platz** | Das Gerät, an dem du sitzt (dieser Browser, diese Desktop-App, diese Station). Ein Stream Deck gehört zu einem Platz, nicht zu einer Person. |

### Was die Farben bedeuten

Jede Farbe hat in Kesher genau eine Bedeutung – auf dem Bildschirm und auf dem
Stream Deck:

| Farbe | Bedeutung |
| --- | --- |
| 🟢 **Grün** | Du hörst etwas / jemand spricht gerade |
| 🔴 **Rot** | **Dein Mikrofon ist auf Sendung** („On air“). Ein roter Rahmen heißt: Diese Line ist zum Sprechen ausgewählt. |
| 🟡 **Gelb** | Jemand ruft (Call) |
| 🟠 **Orange** | Achtung, Problem (z. B. kein Mikrofon) |
| 🔵 **Cyan** | Nur Auswahl/Markierung, kein Zustand |

Merksatz: **Rot = man hört dich.**

## 3. Womit kann ich Kesher benutzen?

| Gerät | Geeignet für | Hinweis |
| --- | --- | --- |
| **Desktop-App** (Windows, Mac) | Feste Arbeitsplätze: Ton, Video, Licht, Regie | Beste Tonqualität, geringste Verzögerung. **Empfohlen.** |
| **Browser** (Chrome, Edge, Firefox, Safari) | Wenn keine App installiert ist | Funktioniert überall, etwas mehr Verzögerung |
| **Handy / Tablet** (Browser) | Kamera, Bühne, wer sich bewegt | Immer mit Sprechtaste; am besten zum Home-Bildschirm hinzufügen |
| **Raspberry-Pi-Station** | Feste Plätze ohne Bildschirm, z. B. Bühnenrand | Headset einstecken, fertig. Wird von der Technik-Leitung eingerichtet |
| **Stream Deck** | Schnelle Tasten statt Maus | Zusätzlich zur App oder zum Browser |

**Headset:** Benutze möglichst ein Headset mit Mikrofon. Mit Lautsprechern und
Raummikrofon hören die anderen sich selbst als Echo.

## 4. Verbinden und anmelden

### 4.1 Im Browser

1. Die Technik-Leitung gibt dir die Adresse, z. B. `https://192.168.1.50:8443`.
2. Beim ersten Mal zeigt der Browser eine **Sicherheitswarnung** (das
   Zertifikat ist selbst erstellt). Das ist im eigenen Netzwerk normal:
   - Chrome/Edge: **„Erweitert“** → **„Weiter zu … (unsicher)“**
   - Firefox: **„Erweitert…“** → **„Risiko akzeptieren und fortfahren“**
   - Safari/iPhone: **„Details einblenden“** → **„diese Website besuchen“**
3. Wenn der Browser fragt, ob Kesher das **Mikrofon** benutzen darf:
   **Erlauben**.

> Wichtig: Die Adresse muss mit **https** beginnen. Mit `http://` erlaubt der
> Browser auf anderen Geräten kein Mikrofon.

### 4.2 In der Desktop-App

Beim Start zeigt die App den Bildschirm **„Server-Verbindung einrichten“**.

- Unter **„Im Netzwerk gefunden“** erscheint der Kesher-Server meist von
  selbst. Klicke auf **„Verbinden“**.
- Erscheint nichts: **„Erneut suchen“** klicken. Hilft das nicht, die Adresse,
  die dir die Technik-Leitung gibt, in **„Server-Adresse“** eintragen (z. B.
  `192.168.1.50:8080`) und **„Speichern und verbinden“** klicken.
- Die App merkt sich die Adresse. Beim nächsten Start steht sie schon drin.
- Später ändern: oben in der App auf **„Netzwerk“** klicken.

### 4.3 Auf dem Handy

Wie im Browser (4.1). Danach empfohlen: Kesher **zum Home-Bildschirm
hinzufügen** (iPhone: Teilen-Symbol → „Zum Home-Bildschirm“; Android: Menü ⋮ →
„Zum Startbildschirm hinzufügen“). So läuft der Ton zuverlässiger weiter, wenn
der Bildschirm aus ist.

### 4.4 Anmelden

Es gibt keine Passwörter. Auf der Anmeldeseite:

1. **„Display name“** – dein Name, wie ihn die anderen sehen, z. B. `Tim`
   oder `TimFOH`. Leerzeichen werden automatisch entfernt.
2. **„Role“** – deine Aufgabe auswählen, z. B. „Audio“.
3. **„Join Intercom“** klicken.

**„Role currently in use“:** Manche Rollen darf nur eine Person gleichzeitig
haben (z. B. „Producer“). Ist sie schon besetzt, fragt Kesher nach. Mit
**„Confirm takeover“** übernimmst du die Rolle – die andere Person wird dabei
abgemeldet. Mit **„Cancel“** brichst du ab. Bitte nur übernehmen, wenn das
abgesprochen ist.

**Abmelden:** oben rechts auf das **Schloss-Symbol** („Log out and lock“).

## 5. Der Hauptbildschirm

Nach der Anmeldung siehst du die **Stationsansicht**. Sie hat diese Bereiche:

```
┌──────────────────────────────────────────────────────────────┐
│ ● Tim  Audio · connected   [Mikrofon-Anzeige]   ⚙  🔒         │  Kopfzeile
├────────────────────────────────────────┬─────────────────────┤
│ Talk channels   (Party-Lines)          │ Chat                │
│ Direct communication   (Personen)      │                     │
│ Broadcast channels                     │                     │
├────────────────────────────────────────┴─────────────────────┤
│ [Reply to caller]   [Hold to talk]   Always on ○              │  Sprechleiste
└──────────────────────────────────────────────────────────────┘
```

### Kopfzeile

- **Punkt und Name:** dein Name, darunter deine Rolle und der
  Verbindungszustand („connected“ = verbunden).
- **Mikrofon-Anzeige:** zeigt, ob dein Mikrofon auf Sendung ist
  (**„On air“**, rot), aus ist (**„Mic off“**) oder ein Problem hat
  (**„Mic problem“**, orange). Der Balken zeigt deinen Pegel. Ein Klick öffnet
  die Toneinstellungen.
- **Zahnrad** („Settings“): Einstellungen.
- **Schloss** („Log out and lock“): Abmelden.

### Verbindungsanzeige

Wenn die Verbindung kurz weg ist, erscheint oben ein Hinweis:
**„Reconnecting...“** (verbindet neu) oder **„Connecting...“**. Kesher
verbindet sich von selbst wieder – du musst nichts tun. Steht dort
**„Offline“**, wurdest du abgemeldet (z. B. weil jemand deine Rolle übernommen
hat). Dann neu anmelden.

### „Talk channels“ – die Party-Lines

Für jede Party-Line gibt es eine Karte. Darauf steht der Name und darunter der
Zustand:

| Anzeige | Bedeutung |
| --- | --- |
| **On air** | Du sprichst gerade auf dieser Line |
| **Tim is talking** | Jemand spricht gerade (grün) |
| **Selected for talk** | Diese Line ist zum Sprechen ausgewählt (roter Rahmen) |
| **Listening · 4** | Du hörst zu; 4 Personen hören auf dieser Line |
| **Always listening · 4** | Du hörst immer zu – das hat die Technik-Leitung so festgelegt |
| **Not listening** | Du hörst gerade nicht zu |
| **Talk only** | Du darfst hier nur sprechen, nicht zuhören |
| **No access** | Diese Line ist für deine Rolle gesperrt |

Unter jeder Karte gibt es kleine Knöpfe:

- 🎧 **Kopfhörer** („Listen“): Zuhören an/aus.
- 🔔 **Glocke** („Call“): Alle auf dieser Line rufen.
- 📌 **Stecknadel** („Add to favorites“): Als Favorit markieren.
- **„0 dB“**: Lautstärke dieser Line (siehe Kapitel 7).

Ein Buchstabe neben dem Namen zeigt die Wichtigkeit der Line: **L** = niedrig,
**H** = hoch, **C** = kritisch. Normale Lines haben keinen Buchstaben.

### „Direct communication“ – Personen

Hier stehen alle anderen, die gerade angemeldet sind, sortiert nach Rolle.
Halte eine Person gedrückt, um nur mit ihr zu sprechen (Kapitel 6).

### „Broadcast channels“

Erscheint nur, wenn es Broadcast-Kanäle gibt. Damit sprichst du auf mehreren
Party-Lines gleichzeitig, z. B. eine Durchsage an alle („All Tech“).
**„RX“** bedeutet: Du empfängst gerade eine solche Durchsage.

## 6. Sprechen

### 6.1 Auf einer Party-Line sprechen (normal)

1. **Line auswählen:** einmal auf die Karte der Party-Line klicken. Sie bekommt
   einen roten Rahmen („Selected for talk“). Es ist immer nur **eine** Line
   ausgewählt – eine neue Auswahl ersetzt die alte. Nach der Anmeldung ist oft
   schon die Standard-Line deiner Rolle ausgewählt.
2. **Sprechen:** den Knopf **„Hold to talk“** unten **gedrückt halten** und
   sprechen. Die Karte wird rot („On air“).
3. **Loslassen**, wenn du fertig bist. Das Mikrofon ist sofort wieder zu.

Statt mit der Maus geht es auch mit der **Leertaste**: gedrückt halten =
sprechen. (Die Taste lässt sich ändern, siehe 11.2.)

> Tipp: Wenn du lieber direkt auf die Karte drückst, schalte in den
> Einstellungen **„Hold a party line to talk on it“** ein. Dann sprichst du,
> solange du die Karte einer Line gedrückt hältst.

### 6.2 Mit einer Person direkt sprechen

Unter **„Direct communication“** die Karte der Person **gedrückt halten** und
sprechen. Nur diese Person hört dich. Bei ihr steht dann „Talking to you“.

### 6.3 Antworten („Reply to caller“)

Wenn dich jemand gerufen oder direkt angesprochen hat, zeigt der Knopf
**„Reply to caller“** seinen Namen. **Gedrückt halten** – und du antwortest
genau dieser Person, ohne sie erst suchen zu müssen. Steht dort
„No active caller“, hat dich noch niemand angesprochen.

### 6.4 Durchsage an mehrere Lines

Unter **„Broadcast channels“** den Kanal **gedrückt halten** und sprechen.
Ist er ausgegraut, darf deine Rolle ihn nicht benutzen.

### 6.5 Offenes Mikrofon („Always on“)

Mit dem Schalter **„Always on“** unten bleibt dein Mikrofon dauerhaft offen,
ohne Taste. Das ist nur sinnvoll, wenn du ständig sprechen musst (z. B. Regie
während der Sendung).

- Bitte wieder ausschalten, wenn du nicht sprichst – sonst hören alle deine
  Nebengeräusche.
- Auf **Handy und Tablet** gibt es kein offenes Mikrofon; dort wird immer
  mit Sprechtaste gesprochen.
- Wenn du während „Always on“ eine Person direkt gedrückt hältst, pausiert
  das offene Mikrofon kurz und geht danach wieder an.

## 7. Zuhören und Lautstärke

- **Zuhören ein/aus:** auf den 🎧 Kopfhörer unter einer Party-Line klicken.
  Ist er grün, hörst du zu.
- Bei **„Always listening“** kannst du das Zuhören nicht abschalten – die
  Technik-Leitung hat festgelegt, dass diese Line wichtig ist.
- **Lautstärke einer Line oder Person:** auf den dB-Wert (z. B. „0 dB“) unter
  der Karte klicken. Es erscheint ein Schieberegler. **Doppelklick** auf den
  Regler setzt ihn auf 0 dB zurück. Die Einstellung gilt nur auf diesem Gerät.
- Die **Gesamtlautstärke** stellst du wie gewohnt am Computer, Handy oder
  Headset ein.

**Favoriten:** Mit der 📌 Stecknadel markierst du Lines und Personen, die du
oft brauchst. In den Einstellungen kannst du **„Only favorites“** einschalten
– dann siehst du nur noch diese. Praktisch, wenn es hektisch wird.

## 8. Rufen und Rufe beantworten

- **Jemanden rufen:** auf die 🔔 Glocke unter einer Party-Line (ruft alle auf
  dieser Line) oder unter einer Person (ruft nur sie) klicken.
- **Wenn du gerufen wirst:** Der Bildschirm blinkt kurz gelb mit
  **„Incoming group call“** (Ruf auf einer Party-Line) oder
  **„Incoming direct signal“** (Ruf an dich persönlich), dazu der Name.
- **Antworten:** **„Reply to caller“** gedrückt halten und sprechen.

## 9. Chat

Rechts ist der **Chat** für kurze Textnachrichten – nützlich, wenn man gerade
nicht sprechen kann (z. B. Kamera während einer ruhigen Szene).

1. Bei **„To“** wählen, an wen die Nachricht geht: deine Sprech-Line
   (Standard), eine andere Party-Line, eine Person oder eine ganze Rolle.
2. Nachricht eintippen. Abkürzung: **@** und Name für eine Person oder
   Rolle, **#** für eine Party-Line. Kesher schlägt Namen vor; mit den
   Pfeiltasten auswählen und **Enter** drücken.
3. **Enter** drücken oder auf Senden klicken.

- Neue Nachrichten stehen **oben**.
- Klick auf einen Absendernamen = direkt an diese Person antworten.
- **„Confirm“** (wenn eingeschaltet): Der Empfänger soll bestätigen, dass er
  die Nachricht gelesen hat. Du siehst dann **„Waiting for confirmation“**
  bzw. **„Confirmed by …“**. Bekommst du so eine Nachricht, klicke auf
  **„Confirm“**.
- **„Not delivered: …“**: Die Nachricht kam nicht an, z. B. weil
  „nobody in this role is online“ (niemand mit dieser Rolle angemeldet).
  Dein Text steht wieder im Feld.
- Du siehst Nachrichten von Party-Lines, auf denen du zuhörst, und alle
  Nachrichten an dich.

## 10. Die einfache Ansicht (Handy)

Für manche Rollen (z. B. „Camera“) zeigt Kesher eine **einfache Ansicht** mit
großen Knöpfen – gedacht für das Handy:

- **„Hold to talk“** – gedrückt halten zum Sprechen. Darunter steht, auf
  welcher Line du sprichst.
- **„Reply to caller“** – gedrückt halten, um dem zu antworten, der dich
  zuletzt angesprochen hat.
- **„Microphone“** / **„Speaker output“** – Mikrofon und Lautsprecher wählen.
- **„Background audio assist“** – hält den Ton am Laufen, wenn der Bildschirm
  aus ist. Eingeschaltet lassen.
- **„Keep device awake while connected“** – Bildschirm bleibt an.
- **„Logout“** – abmelden.

Ob du die einfache oder die volle Ansicht bekommst, legt die Technik-Leitung
für jede Rolle fest.

## 11. Einstellungen

Das **Zahnrad** oben rechts öffnet die Einstellungen. Sie gelten nur für
dieses Gerät. Schließen mit **X**, **Esc** oder Klick daneben.

### 11.1 „Sound“ – Mikrofon und Lautsprecher

**Microphone**

- **„Device“** – welches Mikrofon (dein Headset wählen).
- **„Level“** – zeigt deinen Pegel beim Sprechen. Steht dort
  **„Too loud: lower the gain“**, ist es zu laut.
- **„Gain“** – Mikrofon lauter/leiser. Doppelklick = zurück auf 0 dB.
- **„Hear yourself“** – du hörst dich selbst im Kopfhörer. Ideal, um das
  Headset-Mikrofon richtig vor den Mund zu setzen und den Pegel einzustellen.
  Erst Kopfhörer aufsetzen! Mit **„Stop test“** beenden.
- **„Noise gate“** – schaltet leise Hintergrundgeräusche zwischen den Wörtern
  stumm. Hilfreich in lauter Umgebung. Mit dem Regler **„Opens above …“**
  einstellen, ab welcher Lautstärke das Mikrofon öffnet. Ist der Wert zu hoch,
  werden Wortanfänge abgeschnitten.

**Speaker**

- **„Device“** – Kopfhörer bzw. Lautsprecher wählen. (Manche Browser
  spielen immer über das Standardgerät des Systems.)

**Performance audio** (nur Desktop-App)

- Zeigt Mikrofon, Lautsprecher und Einstellungen der schnellen Audio-Engine.
- **„Device access“** (Windows): normalerweise auf
  **„Automatic (lowest latency)“** lassen. Wenn der Ton stottert:
  **„Shared low latency (WASAPI)“** wählen. Bei **„Exclusive“** kann kein
  anderes Programm das Headset gleichzeitig benutzen.
- **„Measure latency“** misst die Verzögerung: Headset-Hörer ans Mikrofon
  halten, klicken – das Ergebnis steht bei „Mouth-to-ear“.

### 11.2 „Controls“ – Bedienung

- **„Hold a party line to talk on it“** – an: Karte gedrückt halten = auf
  dieser Line sprechen. Aus (Standard): Karte antippen wählt die Line aus,
  gesprochen wird mit „Hold to talk“.
- **„Talk button first“** – tauscht die Reihenfolge von „Hold to talk“ und
  „Reply to caller“ in der unteren Leiste.
- **Tastenkürzel:**
  - **„Push to Talk (room)“** – gedrückt halten zum Sprechen. Standard:
    **Leertaste**.
  - **„Toggle Always On“** – offenes Mikrofon ein/aus. Standard: keine Taste.
  - Ändern mit **„Set“** und dann die gewünschte Taste drücken
    (auch mit Strg/Alt/Umschalt). **„Clear“** entfernt die Taste.
  - Während du in ein Textfeld tippst (z. B. Chat), sind die Tastenkürzel aus.

### 11.3 „View“ – Ansicht

- **„Only favorites“** – nur markierte Lines und Personen zeigen.
- **„People in tabs by role“** – Personen nach Rolle in Reitern ordnen
  (praktisch bei vielen Leuten).
- **„Volume on each card“** – dB-Wert auf jeder Karte zeigen.

### 11.4 „Device“ – Gerät

- **„Keep audio running in the background“** – Ton läuft weiter, wenn der
  Bildschirm aus ist oder eine andere App offen ist. Anlassen.
- **„Keep the screen on“** – Gerät geht nicht in den Ruhezustand.
- Unten stehen Version und Gerätedaten – wichtig, wenn du der Technik-Leitung
  ein Problem meldest.

### 11.5 „Stream Deck“

Siehe nächstes Kapitel.

## 12. Stream Deck

Ein **Elgato Stream Deck** ist ein Tastenfeld mit kleinen Bildschirmen auf
jeder Taste. Mit Kesher kannst du dir darauf Tasten für Lines, Personen und
Rufe legen.

### 12.1 Anschließen

- **Mit der Desktop-App:** Stream Deck **MK.2** (15 Tasten) einfach an den PC
  stecken – es funktioniert sofort. Vorher die Elgato-Stream-Deck-Software
  beenden, denn nur ein Programm kann das Deck benutzen.
- **Mit Bitfocus Companion** (andere Modelle, oder wenn Companion ohnehin
  läuft): Die Technik-Leitung richtet Companion ein. Das Deck zeigt dann einen
  **4-stelligen Code**. Gib ihn in den Einstellungen unter **Stream Deck** bei
  **„Code“** ein und klicke **„Pair deck“**.

Das Stream Deck gehört zu **deinem Platz**, nicht zu dir. Es steuert immer,
wer gerade an diesem Gerät angemeldet ist, und behält seine Tastenbelegung.

### 12.2 Tasten belegen

Einstellungen → **Stream Deck**:

1. Auf eine Taste im Raster klicken.
2. Bei **„What it does“** erst eine Art wählen, dann die Funktion:

   | Art | Funktion |
   | --- | --- |
   | **Party line** | **Talk** (halten = sprechen), **Listen on / off** (Zuhören an/aus), **Call** (rufen) |
   | **Person** | **Talk** – halten = nur mit dieser Person sprechen |
   | **Role** | **Talk** – halten = mit allen dieser Rolle sprechen |
   | **Group** | **Announce** – halten = Durchsage auf allen Lines der Gruppe |
   | **Calls** | **Reply** (dem letzten Rufer antworten), **Show incoming calls** (zeigt, wer ruft) |
   | **Microphone** | **Open mic on / off**, **Louder / Quieter** |
   | **Pages** | Nächste/vorige/erste Seite, Ordner öffnen |
   | **Nothing** | Taste bleibt leer |

3. Bei **„How it looks“** optional einen eigenen **Namen**, eine zweite Zeile
   und eine **Rahmenfarbe** wählen. (Rot, Grün und Gelb sind für Sprechen,
   Hören und Rufe reserviert.)

Weitere Möglichkeiten:

- **Tasten tauschen:** Taste auf eine andere ziehen.
- **„Copy“ / „Paste“ / „Clear“** für einzelne Tasten.
- **Seiten:** mit **„+“** weitere Seiten anlegen. Eine Seite kann sich auch
  selbst füllen: bei **„Keys“** **„All party lines“** oder **„All roles“**
  wählen.
- **Ordner:** über „Open a folder or page“ → „New folder…“. Taste 1 in einem
  Ordner ist immer **„Back“** (zurück).
- **„Try keys here“** – Tasten am Bildschirm ausprobieren.
- **„Undo“** – letzte Änderungen rückgängig machen.
- Änderungen werden **automatisch gespeichert** („All changes saved“).
- Unter **„More“**: Belegung **exportieren/importieren** oder
  **„Reset layout“** (alles zurücksetzen).

### 12.3 Was die Tasten zeigen

| Taste zeigt | Bedeutung |
| --- | --- |
| Rot gefüllt | Dein Mikrofon ist auf Sendung |
| Roter Rahmen | Deine ausgewählte Sprech-Line |
| Grüner Balken unten | Du hörst diese Line |
| Gelb blinkend | Jemand ruft |

## 13. Raspberry-Pi-Station

Eine Station ist ein kleiner Computer mit Headset, fest an einem Platz – ohne
Bildschirm. Die Technik-Leitung richtet sie ein (Kapitel 20).

- **Headset einstecken, fertig.** Die Station meldet sich selbst an.
- Hat die Station einen **Sprechknopf**: gedrückt halten = sprechen (oder, je
  nach Einstellung, Mikrofon an/aus).
- Die **LED** zeigt den Zustand:

  | LED | Bedeutung |
  | --- | --- |
  | blinkt langsam | Kein Server gefunden |
  | blinkt doppelt | Wartet auf Freigabe durch die Technik-Leitung |
  | aus | Bereit, Mikrofon zu |
  | an | Du sprichst |

## 14. Tipps für den Einsatz

- **Vor dem Gottesdienst testen:** anmelden, mit **„Hear yourself“** das
  Mikrofon prüfen, einmal auf deiner Line sprechen und fragen, ob man dich
  hört.
- **Erst denken, dann drücken:** Taste drücken, kurz warten, dann sprechen –
  sonst fehlt das erste Wort.
- **Kurz und klar:** „Kamera 2 für Ton: Pastor-Mikro ist stumm.“ – erst wer,
  dann an wen, dann was.
- **Taste loslassen**, wenn du fertig bist. Rot heißt: alle hören dich.
- **Während der Predigt/Moderation** nur Nötiges sprechen; für Unwichtiges den
  Chat nutzen.
- **Direkt statt Line**, wenn es nur eine Person betrifft – dann werden die
  anderen nicht gestört.
- **Akku** von Handy und Funk-Headset vorher laden.

## 15. Wenn etwas nicht geht

| Problem | Lösung |
| --- | --- |
| **„Mic problem“ / „No microphone found“** | Headset eingesteckt? In Einstellungen → Sound das richtige Mikrofon wählen. Im Browser das Mikrofon erlauben (Schloss-Symbol neben der Adresse). |
| **Browser fragt nicht nach dem Mikrofon** | Die Adresse muss mit **https://** beginnen. |
| **Ich höre nichts** | Kopfhörer bei 🎧 aktiv (grün)? Lautstärke der Line nicht ganz unten? Richtiger Lautsprecher in Einstellungen → Sound? Lautstärke am Gerät? |
| **Die anderen hören mich nicht** | Ist die richtige Line ausgewählt (roter Rahmen)? Wird die Anzeige beim Sprechen rot („On air“)? Pegel in Einstellungen → Sound prüfen. Ist das Noise gate zu hoch eingestellt? |
| **Echo bei den anderen** | Headset statt Lautsprecher benutzen. |
| **Karte ist ausgegraut / „No access“** | Deine Rolle darf diese Line nicht benutzen. Technik-Leitung fragen. |
| **„Reconnecting...“** | Kurz warten, Kesher verbindet sich selbst neu. Dauert es lange: WLAN prüfen. |
| **„Offline“** | Du wurdest abgemeldet (z. B. Rolle übernommen). Neu anmelden. |
| **„Keine Verbindung zum Backend“** (Desktop-App) | Server läuft nicht oder falsche Adresse. **„Erneut versuchen“** oder **„Server-Adresse aendern“**. |
| **Ton reißt ab, wenn das Handy gesperrt ist** | Kesher zum Home-Bildschirm hinzufügen; „Keep audio running in the background“ anlassen. |
| **Desktop-App: Ton stottert** | Einstellungen → Sound → Device access: **„Shared low latency (WASAPI)“**. |
| **Stream Deck reagiert nicht** | Elgato-Software schließen. Bei Companion: Code eingeben („Pair deck“). |
| **Ton verzögert** | Desktop-App statt Browser verwenden; wenn möglich Kabel statt WLAN. |

Wenn nichts hilft: die Technik-Leitung fragen und die Versionsnummer aus
Einstellungen → Device nennen.

---

# Teil B – Einrichten und verwalten

Dieser Teil ist für die Person, die Kesher in der Gemeinde aufsetzt und
betreut. Programmierkenntnisse sind nicht nötig; ein paar Befehle muss man
aber abtippen können.

## 16. Server installieren

Kesher braucht **einen Server** im Netzwerk. Alle Geräte verbinden sich mit
ihm.

| Möglichkeit | Wann |
| --- | --- |
| **Linux-Rechner** (z. B. Mini-PC mit Ubuntu oder Debian) | **Empfohlen** für den festen Betrieb, bis ca. 50 Personen |
| **Windows- oder Mac-PC** | Für Proben oder kleine Teams |

### Linux – ein Befehl

Auf dem Linux-Rechner ein Terminal öffnen und eingeben:

```bash
curl -fsSL https://raw.githubusercontent.com/KesherCom/kesher/main/deploy/server/install.sh | sudo bash
```

Das Programm installiert alles Nötige, startet Kesher und sorgt dafür, dass
Kesher nach jedem Neustart wieder läuft. Am Ende zeigt es die Adresse an,
z. B. `https://192.168.1.50:8443`.

Nützliche Befehle danach:

| Befehl | Was er tut |
| --- | --- |
| `kesher status` | Läuft Kesher? Unter welcher Adresse? |
| `sudo kesher update` | Auf die neueste Version aktualisieren |
| `sudo kesher restart` | Neu starten |
| `sudo kesher backup` | Sicherung der Daten anlegen |
| `sudo kesher new-certificate` | Nötig, wenn sich die IP-Adresse des Servers geändert hat |
| `kesher logs` | Protokoll anzeigen (bei Problemen) |

Tipp: **Vor einer großen Veranstaltung nicht updaten.** Lieber in der Woche
davor aktualisieren und testen.

### Windows-PC

1. Von der Download-Seite `kesher-server-windows-amd64.zip` herunterladen und
   entpacken.
2. Das Programm starten (Details in [docs/deployment/server.md](../deployment/server.md)).
3. Wenn Windows nach der Firewall fragt: Zugriff in **privaten Netzwerken**
   erlauben.
4. Der PC darf während der Veranstaltung **nicht in den Ruhezustand** gehen.

### Desktop-App für die Mitarbeitenden

Auf der Download-Seite
([Releases](https://github.com/KesherCom/kesher/releases)):

- Windows: `kesher-desktop-windows-amd64-setup.exe`
- Mac mit Apple-Chip (M1, M2 …): `kesher-desktop-macos-arm64.dmg`
- Mac mit Intel-Chip: `kesher-desktop-macos-amd64.dmg`

Mehr dazu in [docs/releases/downloads.md](../releases/downloads.md).

## 17. Ersteinrichtung

Beim ersten Aufruf der Server-Adresse im Browser erscheint
**„Welcome to kesher“**:

1. **„Admin PIN“** – eine PIN für den Admin-Bereich wählen (mindestens 4
   Zeichen, keine Leerzeichen) und bei **„Repeat the PIN“** wiederholen.
   **Gut merken!**
2. **„Start with“**:
   - **„Example setup“** (empfohlen) – legt Beispiel-Rollen (Audio, Video,
     Lighting, Broadcast, Camera, Pastor, Producer), Party-Lines (FOH, Stage,
     Video Control, Livestream, Lighting Booth) und den Broadcast-Kanal
     „All Tech“ an. Alles lässt sich später umbenennen oder löschen.
   - **„Empty“** – alles leer; du legst Rollen und Lines selbst an, bevor sich
     jemand anmelden kann.
3. **„Finish setup“** klicken. Der Admin-Bereich öffnet sich.

Diese Seite erscheint nur ein einziges Mal.

## 18. Der Admin-Bereich

**Öffnen:** Auf der Anmeldeseite **„Show admin“** klicken, die PIN eingeben,
**„Open admin console“**. Schließen mit dem **Schloss** oben.

Links sind vier Bereiche:

| Bereich | Inhalt |
| --- | --- |
| **Live** | Wer ist online, was braucht Aufmerksamkeit |
| **Setup** | Rollen, Party-Lines, wer wo spricht und hört, Personen |
| **Devices** | Raspberry-Pi-Stationen, Stream Decks, Companion |
| **System** | Sicherung, Admin-PIN, Telegram, Protokolle, Chat-Verlauf |

Eine Zahl neben **Devices** heißt: Eine Station oder ein Stream Deck wartet
auf Freigabe.

### Live – während der Veranstaltung

- Kacheln zeigen: Personen online, Stationen online, Stream Decks, Zustand
  des Servers (**„OK“** oder **„Check“** mit Hinweis).
- **„Online now“** – alle Angemeldeten. Pro Person:
  - **„Mute mic“** – Mikrofon dieser Person sofort ausschalten (z. B. wenn
    jemand das offene Mikrofon vergessen hat). Beim nächsten Drücken spricht
    sie wieder.
  - **„Kick“** – Person auf allen Geräten abmelden.
- **„Party lines“** – wie viele auf jeder Line zuhören.
- **„Audio and network“** – technische Messwerte, nur für die Fehlersuche.

## 19. Rollen und Party-Lines einrichten

### Party-Line anlegen

**Setup → „Party lines“ → „Create party line“**:

- **ID** (kurz, ohne Leerzeichen, z. B. `stage`) und **Name** (z. B. „Stage“).
  Die ID lässt sich später nicht ändern.
- **„Priority“** – Low / Normal / High / Critical. Wird auf den Karten als
  Buchstabe angezeigt.
- **„Allowed senders“** – welche Rollen sprechen dürfen.
- **„Allowed receivers“** – welche Rollen zuhören dürfen.
- **„Forced listeners“** – welche Rollen **immer** zuhören (können es nicht
  abschalten).

Achtung: **„Delete“** löscht ohne Rückfrage.

### Rolle anlegen

**Setup → „Roles“ → „Create role“**:

- **ID** und **Name** (z. B. `camera` / „Camera“).
- **„Default party line“** – auf dieser Line spricht man nach der Anmeldung.
- **„Default audio mode“** – **„PTT“** (Sprechtaste, empfohlen) oder
  **„Always on“**.
- **„Default to simple mobile view“** – einfache Handy-Ansicht (gut für
  Kamera und Bühne).
- **„Only one person at a time“** – nur eine Person darf diese Rolle haben;
  eine zweite Anmeldung übernimmt sie (z. B. für die Regie).

### Wer spricht und hört wo – die Tabelle

**Setup → „Who talks and hears where“** ist der einfachste Weg, Rechte zu
vergeben. Zeilen = Rollen, Spalten = Party-Lines. Jeder Klick auf ein Feld
schaltet weiter:

**–** (kein Zugriff) → **Hear** (darf zuhören) → **Always** (hört immer) →
**Talk + Hear** → **Talk + Always**

Geänderte Felder sind markiert. Am Ende **„Save changes“** klicken
(**„Discard“** verwirft die Änderungen).

**Typischer Ablauf für eine neue Rolle:**

1. Rolle anlegen.
2. In der Tabelle die Felder dieser Rolle einstellen.
3. **„Save changes“**.
4. Bei der Rolle die Standard-Line setzen.

### Broadcast-Kanäle

**Setup → „Broadcast channels“ → „Create channel“**: Name, Priorität,
**„Included party lines“** (auf welchen Lines die Durchsage zu hören ist) und
**„Allowed roles“** (wer den Kanal benutzen darf).

### Personen

**Setup → „Users“**: Personen entstehen automatisch, wenn sie sich anmelden.
Hier kann man Offline-Personen löschen.

Kleines Extra: Bei **„Birthday Users (Today)“** Namen eintragen – sie bekommen
bei der Anmeldung einen Geburtstagsgruß.

## 20. Stationen und Stream Decks freigeben

### Raspberry-Pi-Station

Was man braucht: Raspberry Pi 5 (empfohlen), 4 oder 3, Raspberry Pi OS Lite
64-bit, ein **USB-Headset** (der Kopfhöreranschluss des Pi hat kein Mikrofon)
und möglichst ein **Netzwerkkabel**. Die Installation ist in
[docs/hardware/raspberry-pi.md](../hardware/raspberry-pi.md) beschrieben.

**Freigeben:** Sobald die Station eingeschaltet und im Netzwerk ist, erscheint
sie unter **Devices → „Stations (Raspberry Pi)“ → „Waiting for approval“**:

1. **„Name in the user list“** – wie die Station heißen soll, z. B.
   `Buehne-links`.
2. **„Role“** – welche Rolle die Station hat.
3. **„Talk mode“** – **„Push to talk (button)“** (Sprechknopf) oder
   **„Always on (button mutes)“** (Mikrofon offen, Knopf schaltet stumm).
4. **„Approve“**. Nach wenigen Sekunden ist die Station verbunden.

Mit **„Edit“** lassen sich Name, Rolle und Modus jederzeit ändern;
**„Remove“** entfernt die Station (sie muss dann neu freigegeben werden).

### Stream Decks über Companion

Für Stream Decks, die über **Bitfocus Companion** laufen, siehe
[docs/COMPANION-SETUP.md](../COMPANION-SETUP.md). Kurz: Pro Stream Deck eine
Kesher-Verbindung in Companion anlegen. Das Deck zeigt dann einen Code und
erscheint unter **Devices → „Stream Decks“**. Dort mit **„Pair…“** einem Platz
zuordnen – oder die Person am Platz gibt den Code selbst in ihren
Einstellungen ein.

Ein Stream Deck MK.2 an einem PC mit der **Desktop-App** braucht keine
Freigabe – einfach einstecken.

## 21. Sicherung, PIN und weitere Einstellungen

Alles unter **System**:

- **„Showfile (backup and restore)“**
  - **„Export showfile“** – lädt die ganze Konfiguration (Rollen, Lines,
    Rechte, Stream-Deck-Belegungen …) als Datei herunter. **Vor jeder größeren
    Änderung exportieren!**
  - Import: Datei mit **„Load JSON file“** laden, gewünschte Teile ankreuzen,
    **„Create Backup Before Import“** angekreuzt lassen,
    **„Import selected sections“**.
- **„Admin PIN“** – PIN ändern: aktuelle PIN, neue PIN zweimal,
  **„Update PIN“**.
- **„Telegram bot“** / **„Telegram allowlist“** – Nachrichten zwischen einer
  Telegram-Gruppe und einer Party-Line austauschen. Anleitung:
  [docs/TELEGRAM-BOT-SETUP.md](../TELEGRAM-BOT-SETUP.md).
- **„Logs“** – Protokoll für die Fehlersuche; mit **„Download TXT“**
  speichern.
- **„Chat history“** – **„Clear for new Show“** leert den Chat für alle,
  z. B. vor dem nächsten Gottesdienst. Dort lassen sich auch Lesebestätigungen
  (**„ACK-Nachrichten aktivieren“**) ein- und ausschalten.

## 22. Netzwerk – was die Technik-Leitung wissen muss

- **Alle Geräte im selben Netzwerk** (LAN/WLAN) wie der Server. Dann finden
  Desktop-App und Stationen den Server von selbst.
- **Browser brauchen https** (`https://<server>:8443`), sonst gibt es kein
  Mikrofon. Die Zertifikatswarnung muss auf jedem Gerät einmal bestätigt
  werden (Kapitel 4.1).
- **Feste Plätze per Kabel**, WLAN nur für mobile Geräte. WLAN funktioniert,
  bringt aber mehr und schwankende Verzögerung.
- Der Server sollte eine **feste IP-Adresse** haben (im Router einstellen).
  Ändert sie sich doch: `sudo kesher new-certificate` ausführen.
- Der Installer öffnet diese Ports in der Firewall des Servers. Falls eine
  andere Firewall dazwischen ist, müssen sie offen sein:

  | Port | Wofür |
  | --- | --- |
  | 8443 (TCP) | Browser |
  | 8080 (TCP) | Desktop-App und Stationen |
  | 8081 (UDP) | Ton der Desktop-App und Stationen |
  | 8082 (UDP) | Ton der Browser |
  | 5353 (UDP) | Automatisches Finden des Servers |

| Problem | Lösung |
| --- | --- |
| Verbindung da, aber kein Ton | UDP 8081 und 8082 freigeben |
| App oder Station findet den Server nicht | Gleiches Netzwerk? UDP 5353 offen? Sonst Adresse von Hand eingeben |
| Ton geht nur in manchen Netzen | `KESHER_PUBLIC_IP` setzen, dann `sudo kesher new-certificate` (siehe [server.md](../deployment/server.md)) |
| Server startet nicht | `kesher logs` ansehen |
| Admin-PIN vergessen | Auf dem Server in `/opt/kesher/.env` die Zeile `ADMIN_PIN=…` setzen und `sudo kesher restart` |
