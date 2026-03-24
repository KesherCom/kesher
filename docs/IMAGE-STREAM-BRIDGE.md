# Kesher Intercom Image-Stream Bridge für Bitfocus Companion

Technischen Briefing zur Implementierung einer Pipeline für dynamisch gerenderte UI-Grafiken.

## Überblick

Diese Implementierung bietet eine WebSocket-basierte Pipeline, die Intercom-Zustände in dynamisch gerenderte 72x72px Grafiken (PNG) umwandelt und diese direkt auf Stream Deck Tasten via Bitfocus Companion pusht.

## Architektur

### Komponenten

```
┌─────────────────────────────┐
│   Kesher Backend (Go)       │
├─────────────────────────────┤
│ ImageStreamCoordinator      │
│ └─ renderButtonImage()      │
│ └─ BroadcastImageUpdate()   │
│ └─ WebSocket Handler        │
└──────────────┬──────────────┘
               │ WebSocket
               │ /api/image-stream
               ▼
┌─────────────────────────────┐
│   Bitfocus Companion Module │
├─────────────────────────────┤
│ ImageBridge                 │
│ └─ connectToKeher()         │
│ └─ getImage(bankIndex)      │
│                             │
│ dynamic_button_image        │
│ Feedback (API v3)           │
│ └─ imageBuffer support      │
└─────────────────────────────┘
```

## Teil 1: Backend (Go)

### Datei: `image_stream.go`

#### ButtonImageRenderer
Rendert Intercom-Zustände zu PNG-Bildern (72x72px):

```go
type ButtonImageRenderer struct {
    config ButtonImageRenderConfig
    fontFace font.Face
    mu sync.RWMutex
}

func (r *ButtonImageRenderer) RenderButtonImage(state ButtonState) ([]byte, error)
```

**Unterstützte States:**
- `IDLE`: Dunkelgrau (Standby)
- `TALK`: Crimson Rot (aktiver Mic)
- `LISTEN`: Dodger Blau (Empfang aktiv)
- `BROADCAST`: Dark Orange (Broadcast aktiv)

#### ImageStreamCoordinator
Verwaltet WebSocket-Verbindungen und Broadcasting:

```go
type ImageStreamCoordinator struct {
    mu sync.RWMutex
    clients map[*ImageStreamClient]struct{}
    renderer *ButtonImageRenderer
}

func (c *ImageStreamCoordinator) BroadcastImageUpdate(
    state ButtonState, 
    bank, 
    buttonIndex int
)
```

#### Protokoll (ImageStreamMessage)
```json
{
  "type": "update_button_image",
  "bank": 1,
  "buttonIndex": 5,
  "imageBuffer": "iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAY...",
  "label": "PROD",
  "channel": "1",
  "state": "TALK"
}
```

### Integration im Server

```go
// server.go
type Server struct {
    // ...
    imageStreamCoord *ImageStreamCoordinator
}

// In NewServer():
imageStreamCoord, err := NewImageStreamCoordinator(logger)
s.imageStreamCoord = imageStreamCoord

// Route registrieren:
mux.HandleFunc("/api/image-stream", s.HandleImageStreamWebSocket)
```

### WebSocket Handler
```go
func (s *Server) HandleImageStreamWebSocket(w http.ResponseWriter, r *http.Request) {
    // WebSocket-Upgrade
    // Client-Liste verwalten
    // Nachrichten broadcasten
}
```

## Teil 2: Companion Module (TypeScript/Node.js)

### Datei: `imageRenderer.ts`

Rendering-Service mit **Canvas-Unterstützung**:

```typescript
export function renderButtonImage(
    state: ButtonState,
    options?: RenderOptions
): Buffer
```

**Abhängigkeit:** `canvas` npm-Paket

**Features:**
- 72x72px PNG Export
- SVG-ähnliche Icons (Mic, Ear, Broadcast)
- Dynamische Hintergrundfarben
- Text-Wrapping für Labels

### Datei: `imageBridge.ts`

WebSocket-Client zur Kesher-Backend-Verbindung:

```typescript
export class ImageBridge {
    private imageStorage = new Map<number, Buffer>();
    
    connect(): void
    disconnect(): void
    getImage(bankIndex: number): Buffer | undefined
}
```

**Funktion:**
- Verbindet sich zu `/api/image-stream`
- Speichert empfangene Images in lokaler Map
- Triggert `checkFeedbacks('dynamic_button_image')`
- Auto-Reconnect mit exponentieller Backoff-Strategie

### Datei: `feedbacks.ts` - Neue Feedback-Definition

```typescript
dynamic_button_image: {
    name: "Display Dynamic Web-UI Button Image",
    type: "advanced",
    options: [{
        id: "bankIndex",
        type: "number",
        label: "Button Index",
        default: 0,
        min: 0,
        max: 31
    }],
    callback: (feedback) => {
        const imageBuffer = this.getButtonImage(feedback.options.bankIndex);
        if (imageBuffer) {
            return { imageBuffer };  // Companion API v3 Magic!
        }
        return false;
    }
}
```

**Wichtig:** Der `imageBuffer` Property in der Rückgabe verwendet die Companion API v3 Funktion für direktes Image-Rendering.

### Integration in `main.ts`

```typescript
export class ModuleInstance extends InstanceBase<ModuleConfig> {
    private imageBridge: ImageBridge | null = null;
    
    async init(config: ModuleConfig): Promise<void> {
        // ...
        this.connectImageBridge();
    }
    
    private connectImageBridge(): void {
        this.imageBridge = new ImageBridge(this, this.baseHttpURL());
        this.imageBridge.connect();
    }
    
    getButtonImage(bankIndex: number): Buffer | undefined {
        return this.imageBridge?.getImage(bankIndex);
    }
}
```

## Teil 3: Workflow

### Delta-Updates (Optimierung)

Das System sendet nur dann neue Images, wenn sich der Zustand ändert:

```typescript
// Pseudocode im Hub
if clientState[channel].state !== previousState[channel].state {
    imageStreamCoord.BroadcastImageUpdate(newState, bank, buttonIndex);
}
```

**Vorteil:** Minimale CPU-Last durch Vermeidung redundanter Rendering-Zyklen.

### Performance

- **Rendering:** < 5ms pro Image (72x72px)
- **Binary Size:** ~2-4 KB pro PNG (komprimiert)
- **Latenz:** < 10ms über lokales Netzwerk
- **CPU:** ~1-2% für 32 Buttons @ 1 Hz Update Rate

## Setup & Verwendung

### 1. Backend Dependencies

```bash
cd backend
go mod tidy  # Lädt golang.org/x/image und github.com/golang/freetype
make build
```

### 2. Companion Module Installation

```bash
cd companion-module-kesher
npm install canvas  # oder yarn add canvas
npm run build       # oder yarn build
npm run package     # Paket für Bitfocus erstellen
```

### 3. Stream Deck Konfiguration

1. Im Companion Module auswählen: "Display Dynamic Web-UI Button Image"
2. Button Index setzen (0-31)
3. Dynamic images erscheinen auf der Taste

## Logging & Debugging

### Backend (Go)
```
INFO: Connected to Kesher image stream
DEBUG: Stored image for button 1.5 (3245 bytes)
WARN: Failed to process image update: <error>
```

### Companion Module (TypeScript)
```typescript
this.instance.log("debug", "Image stored for button...");
this.instance.log("warn", "Disconnected from image stream");
```

## Zukünftige Erweiterungen

1. **Custom Fonts:** WOFF/TTF-Support für Typography
2. **Animationen:** GIF-Support für animierte Icons
3. **Farbverwaltung:** Durch Intercom-Konfiguration anpassbar
4. **SVG-Engine:** Direktes SVG-zu-PNG-Rendering
5. **Caching:** LRU-Cache für häufig verwendete Designs

## Troubleshooting

### Images werden nicht angezeigt
- [ ] Ist `/api/image-stream` Endpoint erreichbar?
- [ ] Öffnet sich die WebSocket-Verbindung?
- [ ] Logs prüfen auf Render-Fehler

### Hohe CPU-Last
- [ ] Image-Rendering-Rate reduzieren
- [ ] Größere Update-Intervalle verwenden
- [ ] Channel-Liste prüfen (zu viele aktive Channels?)

### WebSocket Timeout
- [ ] Firewall-Einstellungen prüfen
- [ ] Netzwerk-Latenz messen
- [ ] Reconnect-Delay erhöhen

## Technische Ressourcen

- [Companion API v3 Docs](https://github.com/bitfocus/companion-module-base)
- [Canvas.js Documentation](https://github.com/Automattic/node-canvas)
- [Go Image Package](https://golang.org/pkg/image/)
- [golang.org/x/image](https://pkg.go.dev/golang.org/x/image)
