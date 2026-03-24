#!/usr/bin/env node

/**
 * Integrationsbeispiel: Kesher Hub mit Image Stream Broadcasting
 * 
 * Dieses Beispiel zeigt, wie man den Image Stream Coordinator 
 * mit dem Kesher Hub integriert, um bei Zustandsänderungen 
 * automatisch neue Button-Images zu generieren.
 */

// Typisches Integrationsszenario im Kesher Backend:

/**
 * In der Hub-Methode handling WebSocket Nachrichten:
 */
function exampleHubIntegration() {
    // hub.go - Änderungen beim Empfangen von state updates:
    
    return `
    func (h *Hub) handleVoiceModeUpdate(c *client, voiceMode string) {
        c.voiceMode = voiceMode
        
        // Trigger image render für alle Companion clients
        if h.server.imageStreamCoord != nil {
            for bankIdx := 0; bankIdx < 32; bankIdx++ {
                buttonState := ButtonState{
                    Channel:    fmt.Sprintf("%d", bankIdx),
                    State:      voiceMode, // "IDLE", "TALK", "LISTEN", "BROADCAST"
                    Label:      c.user.Username,
                    IsActive:   voiceMode != "IDLE",
                }
                h.server.imageStreamCoord.BroadcastImageUpdate(
                    buttonState,
                    1, // bank
                    bankIdx,
                )
            }
        }
    }
    `;
}

/**
 * Im Companion Module - Feedback Verwendung:
 */
function exampleCompanionFeedback() {
    return `
    // In einer Companion Action oder Feedback
    <ControlButton>
        <Feedback id="dynamic_button_image">
            <Option id="bankIndex">5</Option>
        </Feedback>
    </ControlButton>
    
    // Das Feedback wird dann automatisch:
    // 1. Die lokale Image-Map prüfen
    // 2. Den PNG-Buffer zurückgeben
    // 3. Companion zeigt das Image auf der Taste
    `;
}

/**
 * Vollständige Kampagne/Integration Checkliste
 */
const integrationChecklist = `
## Image Stream Integration Checkliste

### Backend (Go)

- [ ] image_stream.go ist kompiliert
- [ ] SERVER_INSTANCE.imageStreamCoord ist nicht nil
- [ ] /api/image-stream Route ist verfügbar
- [ ] Hub ruft imageStreamCoord.BroadcastImageUpdate() auf
- [ ] Logging zeigt "update_button_image" Messages

### Companion Module

- [ ] package.json enthält "canvas" Dependency
- [ ] imageRenderer.ts compiliert erfolgreich
- [ ] imageBridge.ts erhält WebSocket Messages
- [ ] dynamic_button_image Feedback ist registriert
- [ ] imageBuffer wird korrekt zurückgegeben

### Stream Deck

- [ ] Module ist installiert
- [ ] Mindestens ein Button mit dynamic_button_image Feedback
- [ ] Button Index ist gültig (0-31)
- [ ] WebSocket ist verbunden (Logs prüfen)

### Testing

- [ ] Starten: Kesher Backend
  make run-backend
  
- [ ] Starten: Companion mit Modul
  
- [ ] Trigger State Change:
  curl -X PUT http://localhost:8080/api/admin/roles/1 -d '...'
  
- [ ] Prüfen:
  - Button Image ändert sich
  - Logs zeigen "Stored image for button..."
  - WebSocket zeigt "update_button_image" Messages

### Performance Check

- [ ] Monitor CPU während Button Updates
- [ ] Netzwerk-Latenz messen (sollte < 50ms sein)
- [ ] Speicher-Nutzung (sollte < 100MB für 32 Buttons sein)
`;

/**
 * Praktisches Szenario: PTT Button
 */
function examplePTTButtonScenario() {
    return `
    // Szenario: Beim Drücken eine PTT-Action wird das Button-Image aktualisiert
    
    // 1. Benutzer drückt Button (PTT)
    // 2. Action wird zum Kesher Backend gesendet
    // 3. Hub aktualisiert Client State (voiceMode = "TALK")
    // 4. Hub ruft imageStreamCoord.BroadcastImageUpdate() auf
    // 5. Image wird rendered (Rot, Mic-Icon, "PROD")
    // 6. Companion Module empfängt update_button_image Message
    // 7. ImageBridge speichert Buffer in Storage Map
    // 8. dynamic_button_image Feedback wird triggered
    // 9. Companion setzt Button Image auf Stream Deck
    // 10. Image erscheint rotes Mic-Icon auf der Taste!
    
    // Gesamtlatenz: ~20-50ms (Netzwerk + Rendering)
    `;
}

/**
 * API Beispiel: Image Stream Messages
 */
function exampleAPIMessages() {
    const updateButtonMessage = {
        type: "update_button_image",
        bank: 1,
        buttonIndex: 5,
        imageBuffer: "iVBORw0KGgoAAAANSUh...[BASE64 PNG DATA]...==",
        label: "PROD-1",
        channel: "5",
        state: "TALK"
    };
    
    const idleButtonMessage = {
        type: "update_button_image",
        bank: 1,
        buttonIndex: 5,
        imageBuffer: "iVBORw0KGgoAAAANSUh...[GRAY PNG]...==",
        label: "PROD-1",
        channel: "5",
        state: "IDLE"
    };
    
    return { updateButtonMessage, idleButtonMessage };
}

/**
 * Error Handling Szenarien
 */
function exampleErrorHandling() {
    return `
    // Problem 1: WebSocket nicht verbunden
    if (!imageBridge.isConnected()) {
        instance.log('warn', 'Image stream disconnected, reconnecting...');
        imageBridge.connect();
    }
    
    // Problem 2: Image Rendering fehlgeschlagen
    try {
        const buffer = renderer.RenderButtonImage(state);
    } catch (err) {
        instance.log('error', 'Failed to render: ' + err.message);
        // Fallback: verwende cached Image oder placeholder
    }
    
    // Problem 3: Client Queue voll
    // imageBridge ignoriert neue Messages automatisch
    // Sollte sehr selten vorkommen (16 Message Queue)
    `;
}

console.log('=== Image Stream Bridge Integration Guide ===\n');
console.log('Checklist:');
console.log(integrationChecklist);
console.log('\nPTT Button Scenario:');
console.log(examplePTTButtonScenario());
console.log('\nAPI Messages:');
console.log(JSON.stringify(exampleAPIMessages(), null, 2));
