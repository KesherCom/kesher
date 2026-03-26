# Kesher & Bitfocus Companion Integration

Dieses Dokument erklärt, wie du Bitfocus Companion mit Kesher verbindest und welche Funktionen zur Verfügung stehen.

## Überblick

Kesher kann über das **kesher Companion Module** gesteuert werden. Das Modul verbindet sich mit Kesher über WebSocket und ermöglicht dir, Kesher-Funktionen über Companion-Buttons, Tasten und Touch-Screens (wie den Elgato Stream Deck) zu steuern.

Wichtig: Companion ist jetzt nur noch Anzeige- und Eingabegerät. Die vollständige Button-Konfiguration liegt im Kesher-Backend und wird im Kesher-Admin-Panel pro Rolle gepflegt. Operator-User bearbeiten oder veröffentlichen keine Companion-Layouts mehr selbst.

### Wichtige Konzepte

- **Backend URL**: Kesher Server, auf dem das Backend läuft (z.B. `http://localhost:8080`)
- **Role ID**: Die eindeutige Kennung einer Operatoren-Rolle (z.B. `Studio-A`, `Dispatcher`)
- **Bridge WebSocket**: Die Echtzeit-Verbindung zwischen Companion und Kesher
- **Discovery**: Ein API-Endpoint, der aktuelle Rollen, Benutzer und Partylines liefert
- **Page Targeting**: Automatische oder manuelle Auswahl, auf welcher Companion-Seite die Kesher-Instanz liegen soll
- **Universal Slots**: In Companion platzierst du einmal 15 universelle Kesher-Slots. Beschriftung, Farbe und Funktion kommen danach live aus Kesher.

---

## 1. Installation des Companion Moduls

### Schritt 1: Das Companion Modul bauen und verpacken

Das kesher Companion Module befindet sich in einem separaten Repository:
```
https://github.com/KesherCom/companion-module-kesher
```

**a) Repository klonen:**
```bash
git clone https://github.com/KesherCom/companion-module-kesher.git
cd companion-module-kesher
```

**b) Dependencies installieren:**
```bash
npm install
```

**c) Modul bauen:**
```bash
npm run build
```

**d) Paket für Companion erstellen:**
```bash
npm run package
```

Dies erzeugt eine `.tgz` Datei im Modul-Verzeichnis.

### Schritt 2: Modul in Bitfocus Companion installieren

1. Öffne **Bitfocus Companion** (Desktop oder Web)
2. Gehe zu **Settings** → **Modules**
3. Klick auf **Install custom module** oder **Import local module**
4. Wähle die `.tgz` Datei aus Schritt 1d aus
5. Warte, bis die Installation abgeschlossen ist

### Schritt 3: Neue Kesher-Instanz erstellen

1. Gehe zu **Connections**
2. Klick auf **+ Add Connection**
3. Suche nach **Kesher** und wähle das Modul aus
4. Eine neue Instanz wird erstellt

### Schritt 4: Verbindung zwischen Companion und Kesher herstellen

In der neuen Companion-Connection setzt du mindestens:

- `Backend host`
- `Backend port`
- `Use TLS (wss)` wenn dein Kesher per HTTPS läuft
- `Target role ID` der Rolle, die Companion steuern soll

Erst wenn diese Connection korrekt konfiguriert ist, kann Companion Discovery-Daten, Status und das veröffentlichte Kesher-Profil laden.

---

## 2. Konfiguration

Nach der Installation musst du die Kesher-Instanz konfigurieren.

### Grundeinstellungen

| Feld | Beschreibung | Beispiel |
|------|-------------|---------|
| **Backend host** | Hostname oder IP des Kesher-Servers | `localhost`, `192.168.1.100`, `kesher.example.com` |
| **Backend port** | Port des Kesher-Servers | `8080`, `443` (für HTTPS) |
| **Use TLS (wss)** | WebSocket-Verschlüsselung (wss statt ws) | An/Aus |
| **Companion shared secret** | Optional: Gemeinsames Geheimnis für Sicherheit | `mein-geheimnis-123` |

### Zieleinstellungen

| Feld | Beschreibung | Beispiel |
|------|-------------|---------|
| **Target role ID** | Die Rolle, die dieses Companion-Modul steuert | `Studio-A`, `Dispatcher` |
| **Target page override** | Zielseite für die aus Kesher synchronisierten Presets | `-1` (Kesher-Mapping), `3`, `5` |

### Konfigurationsbeispiel

```
Backend host:           192.168.1.100
Backend port:           8080
Use TLS (wss):          ☐ (unchecked)
Companion shared secret: (leer)
Target role ID:         Studio-A
Target page override:   -1
```

**Erklärung:**
- Verbindet sich mit Kesher auf `192.168.1.100:8080` ohne TLS
- Steuert die Rolle `Studio-A`
- Nutzt das Kesher-Backend für die Seiten-Auswahl (`-1`)

Wichtig: Das Kesher-Backend akzeptiert für Discovery, Profil und Bridge nur noch `roleId`. Ein username-basierter Target-Pfad wird serverseitig nicht mehr unterstützt, auch wenn ältere Modulversionen das Feld noch anzeigen sollten.

### Backend-Sicherheitsoptionen

Das Backend kann Companion-Verbindungen zusätzlich absichern:

| Option | Ort | Wirkung |
|------|------|---------|
| **Companion shared secret** | Companion-Modul + Kesher Backend | Schützt Discovery und Bridge-WebSocket per gemeinsamem Secret |
| **companion_allowed_usernames** | Kesher Backend Config | Begrenzt Companion-Steuerung auf eine definierte Liste von Ziel-Usern |

Beispiel in `config.yaml`:

```yaml
companion_shared_secret: "super-secret"
companion_allowed_usernames:
  - studio-a-op
  - dispatcher-main
```

Oder per Umgebungsvariablen:

```sh
COMPANION_SHARED_SECRET=super-secret
COMPANION_ALLOWED_USERNAMES=studio-a-op,dispatcher-main
```

Zusätzlich validiert das Backend Companion-Befehle vor der Weiterleitung gegen die bestehenden Kesher-Policies:

- Talk-Rechte für Partyline-PTT und Room-Signale
- Listen-Rechte für Listen/Room-Matrix
- Direct-PTT/Direct-Signal nur bei erlaubter Rollenbeziehung
- Broadcast nur für erlaubte Broadcast-Gruppen
- Multi-Session-Warnstatus, wenn mehrere Browser-Sessions denselben User belegen

---

## 3. Verbindung und Synchronisierung

Der aktuelle Ablauf ist jetzt wie folgt:

### 3.1 Einmalig in Companion konfigurieren

Diese Dinge musst du weiterhin in Companion selbst setzen:

1. Kesher-Modul installieren
2. Kesher-Connection anlegen
3. Host, Port, TLS und `Target role ID` eintragen

Ohne diese Basis-Konfiguration weiß Companion nicht, mit welchem Kesher-Backend und welcher Rolle es sprechen soll.

### 3.2 Layout in Kesher konfigurieren

Danach passiert die eigentliche Tasten-Konfiguration ausschließlich in Kesher Admin:

1. In Kesher Admin den Bereich `Integrations` öffnen
2. In `Stream Deck Profiles` die Zielrolle auswählen
3. Das Rollenlayout pflegen und speichern
4. In `Companion` dieselbe Rolle veröffentlichen (`Publish to Companion`)

Damit veröffentlicht Kesher:

- die Rollenbindung
- die zugeordnete Companion-Seite
- das admin-gepflegte Rollenlayout
- die neue Profilversion für One-Click-Sync im Modul

### 3.3 Layout in Companion übernehmen

In Companion werden die veröffentlichten Kesher-Buttons als **Universal Synced Layout** bereitgestellt.

- Kategorie `Universal Synced Layout`
- Slots `Slot 1` bis `Slot 15`

Diese Presets sind feste universelle Slots. Wenn du sie einmal in Companion auf 15 Buttons gelegt hast, werden spätere Änderungen aus Kesher live wirksam. Der Companion-Button sendet nur noch `press_button(slot)` an Kesher; die eigentliche Fachlogik wird im Backend aufgelöst.

Wichtig: Companion-Module können Presets bereitstellen, aber nicht selbstständig die Companion-Seiten beschreiben. Deshalb musst du die synchronisierten Presets in Companion einmal auf die gewünschten Buttons ziehen.

Danach pflegst du das Layout in der Praxis in Kesher Admin und aktualisierst es per `Publish to Companion`.

Du musst dafür **nicht** jedes Mal das Modul neu bauen oder das Package neu installieren. Neu bauen musst du nur, wenn sich der Code des Companion-Moduls selbst ändert.

## 4. Funktionen & Möglichkeiten

### 4.1 Verfügbare Actions (Befehle)

Mit Actions kannst du Kesher vom Stream Deck aus steuern. Die folgenden Actions sind verfügbar:

#### Stimm-Modus
- **Set voice mode to Always On** - Aktiviert Dauermikrofon
- **Set voice mode to PTT** - Schaltet auf Push-to-Talk um
- **Toggle voice mode** - Wechselt zwischen Always On und PTT

#### Raum-Steuerung
- **Select talk room** - Setzt den Sprach-Raum (wo deine Sprache hingeht)
- **Select listen room** - Setzt den Hörer-Raum (was du hörst)
- **Toggle listen room** - Schaltet einen Hörer-Raum an/aus

#### Sprechen auslösen
- **PTT to anchor room** - Spricht in den aktuellen Anker-Raum
- **PTT to explicit target** - Spricht in einen bestimmten Raum/Benutzer/Broadcast
- **Reply to latest caller** - Antwortet auf den letzten eingehenden Anruf
- **Direct PTT to user** - Direkte Punkt-zu-Punkt Verbindung mit einem Benutzer
- **Direct PTT to active role** - Direkte Verbindung zum aktuell aktiven Benutzer einer Rolle

#### Steuerung auf Benutzer-Ebene
- **Lookup role by ID** - Findet einen Benutzer anhand der Rollen-ID
- **Lookup partyline by ID** - Findet eine Partyline anhand der ID
- **Query state by path** - Liest beliebige Werte aus dem Kesher-Status

#### Sonstige
- **Send signal** - Sendet ein Signal an einen bestimmten Raum/Benutzer (z.B. für Workflows)

### 4.2 Verfügbare Feedbacks (Status-Anzeigen)

Mit Feedbacks zeigst du den aktuellen Status auf deinen Buttons an (z.B. Farbe ändern, Text aktualisieren).

| Feedback | Beschreibung |
|----------|-------------|
| **Bridge connected** | "Konnektiert" ist rot, "Getrennt" ist grün |
| **Bridge bound** | Zeigt, ob die Rolle aktiv steuert |
| **Mic live** | Farbl-Feedback wenn dein Mikrofon aktiv sendet |
| **Voice mode** | Aktueller Modus (Always On / PTT) anzeigen |
| **Listen/talk rooms selected** | Zeigt die aktuellen Räume an |
| **Last command failed** | Rot-Hervorhebung wenn der letzte Befehl fehlgeschlagen ist |

### 4.3 Verfügbare Variablen

Variablen sind Platzhalter, die du in Button-Labels oder anderen Feldern nutzen kannst.

#### Aktive Rollen (aktuelle Verbindung)
- `$(kesher:active_role_username)` - Benutzername für deine konfigurierte Role
- `$(kesher:active_role_user_id)` - User ID deiner Role (wenn aktiv)

#### Alle bekannten Rollen (dynamisch)
Für jede bekannte Rolle (von Discovery):
- `$(kesher:active_role_<roleid>_username)` - Benutzername (z.B. `active_role_studio_a_username`)
- `$(kesher:active_role_<roleid>_user_id)` - User ID

**Normalisierung:** Role-IDs werden zu Lowercase Snake-Case: `Studio-A` → `studio_a`

#### Partylines (dynamisch)
Für jede bekannte Partyline:
- `$(kesher:partyline_<id>_name)` - Name der Partyline
- `$(kesher:partyline_<id>_can_talk)` - Kann darin sprechen? (true/false)
- `$(kesher:partyline_<id>_can_listen)` - Kann man darin hören? (true/false)

#### Lookup-Ergebnisse
Wenn du "Lookup role by ID" oder "Lookup partyline by ID" nutzt:
- `$(kesher:lookup_role_found)` - true/false
- `$(kesher:lookup_role_username)` - Gefundener Benutzername
- `$(kesher:lookup_role_user_id)` - User ID
- `$(kesher:lookup_partyline_found)` - true/false
- `$(kesher:lookup_partyline_name)` - Name

#### Query-Ergebnisse
Nach "Query state by path":
- `$(kesher:query_found)` - Pfad gefunden? (true/false)
- `$(kesher:query_result)` - Der abgerufene Wert
- `$(kesher:query_path)` - Der abgefragte Pfad

#### Globale JSON-Daten
- `$(kesher:roles_json)` - Alle Rollen als JSON
- `$(kesher:partylines_json)` - Alle Partylines als JSON
- `$(kesher:target_page_number)` - Zielseite für Kesher-Buttons
- `$(kesher:target_page_source)` - Quelle der Seiten-Auswahl ("override", "kesher", "unset")

**Beispiel-Label:**
```
Studio A: $(kesher:active_role_studio_a_username)
PTT Mode: $(kesher:voice_mode)
```

---

## 5. Spezielle Features

### 4.1 Seiten-Auswahl (Page Targeting)

Der Companion speichert deine Buttons normalerweise auf Seiten. Kesher kann automatisch die richtige Seite auswählen.

**Zwei Modi:**

| Modus | Konfiguration | Effekt |
|-------|---------|--------|
| **Kesher-Mapping** | `Target page override: -1` | Kesher Backend bestimmt die Seite (Rolle → Seite Mapping) |
| **Fest** | `Target page override: 3` | Buttons landen immer auf Seite 3, unabhängig von Kesher |

**Wie funktioniert das Kesher-Mapping?**

1. Du loggst dich als Operator in Kesher selbst an
2. In den User Settings → Stream Deck konfigurierst du dein Layout
3. Mit `Publish Companion profile` veröffentlichst du Layout und Seiten-Zuordnung
4. Companion liest dieses Profil und stellt daraus synchronisierte Presets bereit
5. Diese Presets ziehst du in Companion auf die gewünschte Seite

**Vorteil:** Mehrere Operatoren können verschiedene Seiten und Layouts pflegen, ohne jedes Action-Detail direkt in Companion neu bauen zu müssen.

### 4.2 Role ID vs. Username

Das Modul bevorzugt **Role ID**, fällt aber zu **Username** zurück, wenn Role ID nicht gesetzt ist.

**Empfehlung:** Nutze immer **Role ID**, da das konsistenter ist.

Die Kesher Operatoren-Rollen sind eindeutig (z.B. `Studio-A`, `Dispatcher`). Diese sollten als `Target role ID` konfiguriert werden.

### 4.3 Sicherheit (Shared Secret)

Optional kannst du ein gemeinsames Geheimnis konfigurieren:

```
Companion shared secret: mein-sicheres-geheimnis
```

Das Backend kann dann so konfiguriert werden, dass es diesen Secret validiert. Dies schützt die Verbindung vor unbefugtem Zugriff im lokalen Netzwerk.

---

### 5.1 Grenzen der Synchronisierung

Die meisten Kesher-Buttons lassen sich direkt nach Companion übersetzen. Zwei Fälle sind technisch eingeschränkt:

- **Page Up / Page Down**: Companion-Module dürfen Companion-Seiten nicht direkt umschalten
- **Volume Delta**: Diese Funktion verändert in Kesher den lokalen Mikrofon-Gain im Browser und ist nicht als Companion-Bridge-Befehl verfügbar

Für solche Fälle stellt das Modul Platzhalter-Presets bereit. Die sichtbare Beschriftung bleibt erhalten, die Funktion muss aber manuell anders gelöst werden.

## 6. Typische Workflows

### Workflow 1: Stream Deck für Raum-Steuerung

**Ziel:** Buttons auf meinem Stream Deck, um zwischen Räumen zu wechseln.

**Setup:**
1. Button 1: Action "Select talk room" → Room "Main Channel"
2. Button 2: Action "Select talk room" → Room "Backup Channel"
3. Button 3: Feedback "Voice mode" → Label zeigt Current Mode
4. Button 4: Action "Set voice mode to PTT"

**Feedback:**
- Button 3 wird rot, wenn im PTT-Modus

### Workflow 2: Schnelle Direktverbindung

**Ziel:** Mit einem Button direkt mit einem Dispatcher sprechen.

**Setup:**
1. Button: Action "Direct PTT to user" → Role ID "Dispatcher"
   - Action: "PTT to explicit target" → Type "direct" → Select "Dispatcher"

**Label:**
```
PTT to $(kesher:active_role_dispatcher_username)
```

### Workflow 3: Status-Display

**Ziel:** Einen Knopf, der zeigt, wer aktuell im Studio ist.

**Setup:**
1. Button: Text-Feld (kein Action)
2. Label:
```
Studio A: $(kesher:active_role_studio_a_username)
```

Das Label aktualisiert sich automatisch, wenn jemand in der Role `Studio-A` anmeldet/abmeldet.

---

## 7. Troubleshooting

### Problem: "Bridge not connected"

**Ursachen:**
1. Kesher-Backend läuft nicht
2. Host/Port falsch konfiguriert
3. Firewall blockiert Verbindung
4. TLS-Einstellung falsch (wss statt ws oder umgekehrt)

**Lösungen:**
- Überprüfe, dass Kesher auf der konfigurierten URL erreichbar ist:
  ```
  curl http://192.168.1.100:8080/api/health
  ```
- Überprüfe Host und Port in der Konfiguration
- Falls Kesher HTTPS nutzt, aktiviere "Use TLS (wss)"

### Problem: "Role not found" oder "Action fails"

**Ursachen:**
1. Role ID ist falsch geschrieben
2. Diese Role existiert nicht in Kesher
3. Die konfigurierte User Session hat keine Berechtigung

**Lösungen:**
- Überprüfe die exakte Role ID in Kesher Admin → Rollen
- Stelle sicher, dass die Role in Kesher-Backend definiert ist
- Überprüfe die Berechtigung der Role in Kesher Admin

### Problem: "Last command failed" Feedback leuchtet immer

**Ursachen:**
1. Keine Berechtigung für die Aktion
2. Ziel (Raum/Benutzer) existiert nicht
3. Kesher lehnt den Befehl ab (z.B. unerlaubter Raum für diese Role)

**Lösungen:**
- Überprüfe Rollen-Berechtigungen in Kesher Admin
- Vergewissere dich, dass Ziel-Räume/Benutzer existieren
- Siehe Kesher Backend-Logs für Fehler-Details

### Problem: Ich sehe meine Kesher-Buttons in Companion nicht

**Ursachen:**
1. Die Kesher-Connection in Companion ist noch nicht korrekt konfiguriert
2. Es wurde noch kein `Publish Companion profile` in Kesher ausgeführt
3. Du schaust in Companion nicht in die Preset-Liste der Kesher-Connection

**Lösungen:**
- Prüfe Host, Port, TLS und `Target role ID`
- Klicke in Kesher auf `Publish Companion profile`
- Öffne in Companion die Presets der Kesher-Connection und suche nach `Live Synced Layout / Page X`

### Problem: Buttons landen auf falscher Seite

**Ursachen:**
1. `Target page override` ist nicht `-1` (statt Kesher-Mapping zu nutzen)
2. Kesher-Mapping wurde noch nicht veröffentlicht
3. Operator hat `Publish Companion profile` noch nicht geklickt
4. Die synchronisierten Presets wurden in Companion noch nicht auf die Zielseite gezogen

**Lösungen:**
- Setze `Target page override` auf `-1`
- Starte dich in Kesher als Operator an und klick `Publish Companion profile` in User Settings
- Warte kurz und überprüfe die neue Seite-Nummer über die Variablen `target_page_number` und `target_page_source`
- Ziehe die Presets aus `Live Synced Layout / Page X` in Companion auf die gewünschte Seite

### Problem: TLS-Zertifikat-Fehler

**Symptom:** Verbindung funktioniert mit HTTP, aber nicht mit HTTPS/WSS

**Lösungen:**
1. Prüfe, ob das Zertifikat gültig ist
2. Falls selbstsigniert: Companion muss das Zertifikat akzeptieren
3. Oder: Schalte TLS aus (nur für lokale Netzwerke empfohlen)

---

## 8. API-Endpoints (für Entwickler)

Falls du die Kesher-Companion-Integration selbst integrieren möchtest:

### Discovery Endpoint

```
GET /api/companion/discovery?roleId=Studio-A
```

**Response:**
```json
{
  "roleId": "Studio-A",
  "activeRoleUsers": [
    {
      "userId": "user123",
      "username": "Operator1",
      "roleId": "Studio-A"
    }
  ],
  "partylines": [
    {
      "id": "pline1",
      "name": "Main Channel",
      "canTalk": true,
      "canListen": true
    }
  ],
  "pageNumber": 5,
  "profileVersion": 1,
  "profileStatus": "active"
}
```

### Bridge WebSocket

```
WS wss://kesher.example.com/api/companion/ws?roleId=Studio-A
```

Nachdem die Verbindung etabliert ist, empfängt Companion Echtzeit-Updates.

### Profil Publishing

```
POST /api/user/companion/publish
Content-Type: application/json
Authorization: Bearer <token>
```

Veröffentlicht das Companion-Profil für die aktuelle Rolle des angemeldeten Benutzers.

---

## 9. Best Practices

1. **Nutze Role IDs** statt Usernames - sie sind konsistenter
2. **Veröffentliche Companion-Profile** in Kesher, damit Layout und Seiten-Zuordnung synchronisiert werden
3. **Ziehe die synchronisierten Presets einmal in Companion auf die Zielseite**
4. **Teste Berechtigung** in Kesher Admin, bevor du Companion-Buttons erstellst
5. **Nutze aussagekräftige Labels** mit Variablen, um den Status anzuzeigen
6. **Dokumentiere deine Seiten-Aufteilung** (welche Seite wofür?)
7. **Sichere deine Instanz** mit Shared Secret, wenn das Netzwerk nicht vollständig vertraut ist

---

## 10. Weitere Ressourcen

- **Kesher Haupt-Dokumentation**: [README.md](../README.md)
- **Companion Module GitHub**: https://github.com/KesherCom/companion-module-kesher
- **Bitfocus Companion Docs**: https://companion.bitfocus.io/
- **Kesher Architecture**: [architecture-flow-diagram.md](architecture-flow-diagram.md)

---

**Fragen oder Probleme?** Erstelle ein Issue in den GitHub Repositories oder kontaktiere das Kesher Team.
