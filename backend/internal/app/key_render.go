package app

import (
	"bytes"
	_ "embed"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"

	"github.com/fogleman/gg"
	"github.com/golang/freetype/truetype"
)

// Stream Deck key images follow the visual system (docs/design/README.md):
// IBM Plex Sans Condensed, one stroke icon set and colors with one meaning.
// On a key that means: red = your microphone goes out (or this line is
// where it would go), green = you hear it, yellow = someone calls, and
// everything else stays neutral. A key's kind shows through its icon, not
// its color.

//go:embed fonts/IBMPlexSansCondensed-SemiBold.ttf
var plexCondensedSemiBold []byte

//go:embed fonts/IBMPlexSansCondensed-Medium.ttf
var plexCondensedMedium []byte

var (
	buttonFontsOnce    sync.Once
	buttonFontBold     *truetype.Font
	buttonFontRegular  *truetype.Font
	buttonFontParseErr error
)

// parsedButtonFonts parses the embedded fonts once per process: SemiBold
// for labels, Medium for subtitles.
func parsedButtonFonts() (bold, regular *truetype.Font, err error) {
	buttonFontsOnce.Do(func() {
		if buttonFontBold, buttonFontParseErr = truetype.Parse(plexCondensedSemiBold); buttonFontParseErr != nil {
			return
		}
		buttonFontRegular, buttonFontParseErr = truetype.Parse(plexCondensedMedium)
	})
	return buttonFontBold, buttonFontRegular, buttonFontParseErr
}

// Visual system colors (packages/client-core/src/styles/tokens.css).
const (
	keyCanvas       = "#000000"
	keyGround       = "#0e1116"
	keyRaised       = "#1e2530"
	keyBorder       = "#2a323d"
	keyBorderStrong = "#3a4452"
	keyText         = "#e6eaf0"
	keyTextMuted    = "#9aa4b2"
	keyHear         = "#22c55e"
	keyHearText     = "#4ade80"
	keyOnAir        = "#ef4444"
	keyOnAirText    = "#fca5a5"
	keyCall         = "#facc15"
	keyCallBorder   = "#fde047"
	keyCallInk      = "#1a1405"
	keyCallInkSoft  = "#4a3d0a"
)

// keyLook is everything that colors one key.
type keyLook struct {
	fill, border, text, subtitle, icon string
	borderWidth                        float64 // in 72 px units
	hearBar                            bool    // green bar at the bottom: you hear this line
}

func keyLookFor(state ButtonState) keyLook {
	actionType := StreamDeckActionType(strings.TrimSpace(state.ActionType))
	look := keyLook{
		fill:        keyGround,
		border:      keyBorder,
		text:        keyText,
		subtitle:    keyTextMuted,
		icon:        keyTextMuted,
		borderWidth: 2,
	}
	if custom := strings.TrimSpace(state.Color); custom != "" {
		// A color chosen in the layout editor marks the key's frame.
		look.border = normalizeHexColor(custom)
		look.icon = look.border
	}

	listenKind := actionType == StreamDeckActionTypeListenRoom
	talkKind := actionType == StreamDeckActionTypePTTRoom ||
		actionType == StreamDeckActionTypeSelectTalkRoom ||
		actionType == StreamDeckActionTypeSelectListen
	if state.IsListening && (listenKind || talkKind) {
		look.hearBar = true
		if listenKind {
			look.border = keyHear
			look.icon = keyHearText
		}
	}
	if state.IsPTTSelected {
		// Selected as the line you talk on, like an armed card in the app.
		look.border = keyOnAir
		look.borderWidth = 3
		look.icon = keyOnAirText
	}

	pressed := state.IsActive || state.State == "TALK" || state.State == "BROADCAST"
	switch {
	case state.State == "CALL" || (pressed && actionType == StreamDeckActionTypeCallRoom):
		// Someone calls you, or you call a line.
		look.fill, look.border = keyCall, keyCallBorder
		look.text, look.subtitle, look.icon = keyCallInk, keyCallInkSoft, keyCallInk
	case pressed && (actionType == StreamDeckActionTypePageUp ||
		actionType == StreamDeckActionTypePageDown ||
		actionType == StreamDeckActionTypePageHome ||
		actionType == StreamDeckActionTypePageJump ||
		actionType == StreamDeckActionTypePageBack ||
		actionType == StreamDeckActionTypeVolumeDelta ||
		actionType == StreamDeckActionTypeListenRoom):
		// Pressing a navigation, volume or listen key sends no audio.
		look.fill, look.border = keyRaised, keyBorderStrong
	case pressed && actionType != StreamDeckActionTypeNone:
		// Your microphone goes out.
		look.fill, look.border = keyOnAir, keyOnAirText
		look.text, look.subtitle, look.icon = "#ffffff", "#fee2e2", "#ffffff"
		look.hearBar = false
	}
	return look
}

// keyIconFor is the icon of a key's kind; "" draws none.
func keyIconFor(actionType string) string {
	switch StreamDeckActionType(strings.TrimSpace(actionType)) {
	case StreamDeckActionTypePTTRoom, StreamDeckActionTypePTTSelected,
		StreamDeckActionTypeSelectTalkRoom, StreamDeckActionTypeSelectListen,
		StreamDeckActionTypeMuteToggle:
		return "mic"
	case StreamDeckActionTypeListenRoom:
		return "headphones"
	case StreamDeckActionTypeCallRoom, StreamDeckActionTypeIncomingCall:
		return "bell"
	case StreamDeckActionTypeDirectUser, StreamDeckActionTypeDirectRole:
		return "user"
	case StreamDeckActionTypeReplyToCaller:
		return "reply"
	case StreamDeckActionTypeBroadcastPTT:
		return "broadcast"
	case StreamDeckActionTypeVolumeDelta:
		return "speaker"
	case StreamDeckActionTypePageUp:
		return "arrow-up"
	case StreamDeckActionTypePageDown:
		return "arrow-down"
	case StreamDeckActionTypePageBack:
		return "arrow-left"
	case StreamDeckActionTypePageHome:
		return "home"
	case StreamDeckActionTypePageJump:
		return "folder"
	}
	return ""
}

// draw paints one key; callers hold r.mu.
func (r *ButtonImageRenderer) draw(state ButtonState) ([]byte, error) {
	w := float64(r.config.Width)
	h := float64(r.config.Height)
	s := math.Min(w, h) / 72 // drawing units: a 72 px key
	look := keyLookFor(state)
	label := strings.TrimSpace(state.Label)
	subtitle := strings.TrimSpace(state.Subtitle)
	icon := keyIconFor(state.ActionType)

	dc := gg.NewContext(r.config.Width, r.config.Height)
	dc.SetHexColor(keyCanvas)
	dc.Clear()

	// An unassigned key stays dark, like a switched-off button.
	if label == "" && icon == "" {
		return encodeKeyPNG(dc)
	}

	inset := 2 * s
	radius := 10 * s
	dc.SetHexColor(look.fill)
	dc.DrawRoundedRectangle(inset, inset, w-2*inset, h-2*inset, radius)
	dc.Fill()
	dc.SetHexColor(look.border)
	dc.SetLineWidth(look.borderWidth * s)
	half := look.borderWidth * s / 2
	dc.DrawRoundedRectangle(inset+half, inset+half, w-2*inset-2*half, h-2*inset-2*half, radius-half)
	dc.Stroke()

	if look.hearBar {
		barH := 5 * s
		dc.SetHexColor(keyHear)
		dc.DrawRoundedRectangle(inset+6*s, h-inset-barH-4*s, w-2*inset-12*s, barH, barH/2)
		dc.Fill()
	}

	// Layout: icon on top, label in the middle, subtitle below.
	textTop := 8 * s
	if icon != "" {
		size := 20 * s
		drawKeyIcon(dc, icon, w/2-size/2, 8*s, size, look.icon)
		textTop = 8*s + size + 2*s
	}
	textBottom := h - 8*s
	if look.hearBar {
		textBottom -= 8 * s
	}

	maxWidth := w - 12*s
	if subtitle != "" {
		subSize := r.fitFontSize(dc, subtitle, maxWidth, 12*s, 9*s, false)
		dc.SetFontFace(r.face(false, subSize))
		dc.SetHexColor(look.subtitle)
		subLine := wrapButtonLines(dc, subtitle, maxWidth, 1)[0]
		subY := textBottom - subSize*0.5
		dc.DrawStringAnchored(subLine, w/2, subY, 0.5, 0.35)
		textBottom = subY - subSize*0.75
	}
	if label != "" {
		maxLines := 2
		if textBottom-textTop < 2*13*s {
			maxLines = 1
		}
		start := 17 * s
		if icon == "" {
			// No icon (a pairing code, a plain label): more room for the text.
			start = 22 * s
		}
		size, lines := r.fitLabel(dc, label, maxWidth, maxLines, start, 10*s)
		lineHeight := size * 1.05
		blockCenter := (textTop + textBottom) / 2
		firstY := blockCenter - float64(len(lines)-1)*lineHeight/2
		dc.SetFontFace(r.face(true, size))
		dc.SetHexColor(look.text)
		for i, line := range lines {
			dc.DrawStringAnchored(line, w/2, firstY+float64(i)*lineHeight, 0.5, 0.35)
		}
	}
	return encodeKeyPNG(dc)
}

func encodeKeyPNG(dc *gg.Context) ([]byte, error) {
	var buf bytes.Buffer
	if err := dc.EncodePNG(&buf); err != nil {
		return nil, fmt.Errorf("failed to encode PNG: %w", err)
	}
	return buf.Bytes(), nil
}

// fitFontSize shrinks the size from start down to min until the text fits
// maxWidth on one line; callers hold r.mu.
func (r *ButtonImageRenderer) fitFontSize(dc *gg.Context, text string, maxWidth, start, min float64, bold bool) float64 {
	size := math.Round(start)
	for size > min {
		dc.SetFontFace(r.face(bold, size))
		if width, _ := dc.MeasureString(text); width <= maxWidth {
			return size
		}
		size--
	}
	return min
}

// fitLabel finds the largest size (from start down to min) at which the
// label fits in maxLines lines without cutting a word. Only when even min
// is too big is the last line cut with "...". Callers hold r.mu.
func (r *ButtonImageRenderer) fitLabel(dc *gg.Context, label string, maxWidth float64, maxLines int, start, min float64) (float64, []string) {
	words := strings.Fields(label)
	for size := math.Round(start); size >= min; size-- {
		dc.SetFontFace(r.face(true, size))
		if lines, ok := wrapWords(dc, words, maxWidth, maxLines); ok {
			return size, lines
		}
	}
	dc.SetFontFace(r.face(true, min))
	return min, wrapButtonLines(dc, label, maxWidth, maxLines)
}

// wrapWords puts words on at most maxLines lines of maxWidth; ok is false
// when they do not fit.
func wrapWords(dc *gg.Context, words []string, maxWidth float64, maxLines int) ([]string, bool) {
	var lines []string
	current := ""
	for _, word := range words {
		candidate := word
		if current != "" {
			candidate = current + " " + word
		}
		if width, _ := dc.MeasureString(candidate); width <= maxWidth {
			current = candidate
			continue
		}
		if current == "" {
			return nil, false // a single word wider than the key
		}
		lines = append(lines, current)
		current = word
		if width, _ := dc.MeasureString(word); width > maxWidth {
			return nil, false
		}
	}
	if current != "" {
		lines = append(lines, current)
	}
	return lines, len(lines) <= maxLines
}

// ── Icons ────────────────────────────────────────────────────────────
// The same 24 px stroke icons as components/Icon.tsx in the app (stroke
// 1.8, round caps), plus page navigation icons the app does not need.

var keyIcons = map[string][]string{
	"mic":        {"R 9 3 6 11 3", "M5 11a7 7 0 0 0 14 0M12 18v3"},
	"headphones": {"M4 15v-3a8 8 0 0 1 16 0v3", "R 3 14 4 6 1.5", "R 17 14 4 6 1.5"},
	"bell":       {"M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z", "M10 20a2 2 0 0 0 4 0"},
	"user":       {"C 12 8 4", "M4 21a8 8 0 0 1 16 0"},
	"reply":      {"M9 14 4 9l5-5", "M4 9h10a6 6 0 0 1 6 6v3"},
	"broadcast":  {"C 12 12 2", "M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"},
	"speaker":    {"M4 10h4l5-4v12l-5-4H4z", "M16.5 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11"},
	"arrow-up":   {"M12 19V5M6 11l6-6 6 6"},
	"arrow-down": {"M12 5v14M6 13l6 6 6-6"},
	"arrow-left": {"M19 12H5M11 6l-6 6 6 6"},
	"home":       {"M4 11l8-7 8 7", "M6 9.5V20h12V9.5"},
	"folder":     {"M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"},
}

// drawKeyIcon draws an icon into a size x size box at (x, y). Shapes are
// SVG path data, or "R x y w h r" (rounded rect) and "C cx cy r" (circle).
func drawKeyIcon(dc *gg.Context, name string, x, y, size float64, color string) {
	shapes, ok := keyIcons[name]
	if !ok {
		return
	}
	k := size / 24
	dc.Push()
	defer dc.Pop()
	dc.SetHexColor(color)
	dc.SetLineWidth(1.8 * k)
	dc.SetLineCapRound()
	dc.SetLineJoinRound()
	for _, shape := range shapes {
		dc.NewSubPath()
		switch {
		case strings.HasPrefix(shape, "R "):
			v := parseFloats(shape[2:])
			dc.DrawRoundedRectangle(x+v[0]*k, y+v[1]*k, v[2]*k, v[3]*k, v[4]*k)
		case strings.HasPrefix(shape, "C "):
			v := parseFloats(shape[2:])
			dc.DrawCircle(x+v[0]*k, y+v[1]*k, v[2]*k)
		default:
			traceSVGPath(dc, shape, x, y, k)
		}
		dc.Stroke()
	}
}

func parseFloats(text string) []float64 {
	fields := strings.Fields(text)
	out := make([]float64, len(fields))
	for i, f := range fields {
		out[i], _ = strconv.ParseFloat(f, 64)
	}
	return out
}

// traceSVGPath adds SVG path data (M L H V A Z, absolute and relative) to
// the current path, scaled by k and moved to (ox, oy).
func traceSVGPath(dc *gg.Context, d string, ox, oy, k float64) {
	tokens := tokenizeSVGPath(d)
	var cx, cy, startX, startY float64
	cmd := byte(0)
	i := 0
	num := func() float64 {
		v, _ := strconv.ParseFloat(tokens[i], 64)
		i++
		return v
	}
	isNum := func() bool {
		return i < len(tokens) && !isSVGCommand(tokens[i])
	}
	moveTo := func(x, y float64) {
		cx, cy, startX, startY = x, y, x, y
		dc.MoveTo(ox+x*k, oy+y*k)
	}
	lineTo := func(x, y float64) {
		cx, cy = x, y
		dc.LineTo(ox+x*k, oy+y*k)
	}
	for i < len(tokens) {
		if isSVGCommand(tokens[i]) {
			cmd = tokens[i][0]
			i++
		}
		rel := cmd >= 'a' && cmd <= 'z'
		bx, by := 0.0, 0.0
		if rel {
			bx, by = cx, cy
		}
		switch cmd {
		case 'M', 'm':
			x, y := num(), num()
			moveTo(bx+x, by+y)
			// Further pairs after a move are lines.
			if rel {
				cmd = 'l'
			} else {
				cmd = 'L'
			}
		case 'L', 'l':
			x, y := num(), num()
			lineTo(bx+x, by+y)
		case 'H', 'h':
			lineTo(bx+num(), cy)
		case 'V', 'v':
			lineTo(cx, by+num())
		case 'A', 'a':
			rx, ry, rot := num(), num(), num()
			large, sweep := num() != 0, num() != 0
			x, y := bx+num(), by+num()
			arcTo(dc, cx, cy, rx, ry, rot, large, sweep, x, y, ox, oy, k)
			cx, cy = x, y
		case 'Z', 'z':
			dc.ClosePath()
			cx, cy = startX, startY
			if !isNum() {
				continue
			}
		default:
			i++ // unknown command: skip its value
		}
	}
}

func isSVGCommand(token string) bool {
	return len(token) == 1 && strings.ContainsRune("MmLlHhVvAaZz", rune(token[0]))
}

func tokenizeSVGPath(d string) []string {
	var tokens []string
	var current strings.Builder
	flush := func() {
		if current.Len() > 0 {
			tokens = append(tokens, current.String())
			current.Reset()
		}
	}
	for _, ch := range d {
		switch {
		case strings.ContainsRune("MmLlHhVvAaZz", ch):
			flush()
			tokens = append(tokens, string(ch))
		case ch == ' ' || ch == ',':
			flush()
		case ch == '-':
			flush()
			current.WriteRune(ch)
		case ch == '.' && strings.Contains(current.String(), "."):
			flush()
			current.WriteRune(ch)
		default:
			current.WriteRune(ch)
		}
	}
	flush()
	return tokens
}

// arcTo draws an SVG elliptical arc (endpoint form) as line segments.
func arcTo(dc *gg.Context, x1, y1, rx, ry, rotDeg float64, large, sweep bool, x2, y2, ox, oy, k float64) {
	if rx == 0 || ry == 0 {
		dc.LineTo(ox+x2*k, oy+y2*k)
		return
	}
	phi := rotDeg * math.Pi / 180
	cosPhi, sinPhi := math.Cos(phi), math.Sin(phi)
	dx, dy := (x1-x2)/2, (y1-y2)/2
	x1p := cosPhi*dx + sinPhi*dy
	y1p := -sinPhi*dx + cosPhi*dy
	rx, ry = math.Abs(rx), math.Abs(ry)
	if lambda := x1p*x1p/(rx*rx) + y1p*y1p/(ry*ry); lambda > 1 {
		rx *= math.Sqrt(lambda)
		ry *= math.Sqrt(lambda)
	}
	num := rx*rx*ry*ry - rx*rx*y1p*y1p - ry*ry*x1p*x1p
	den := rx*rx*y1p*y1p + ry*ry*x1p*x1p
	coef := 0.0
	if den != 0 && num > 0 {
		coef = math.Sqrt(num / den)
	}
	if large == sweep {
		coef = -coef
	}
	cxp := coef * rx * y1p / ry
	cyp := -coef * ry * x1p / rx
	centerX := cosPhi*cxp - sinPhi*cyp + (x1+x2)/2
	centerY := sinPhi*cxp + cosPhi*cyp + (y1+y2)/2
	angle := func(ux, uy, vx, vy float64) float64 {
		a := math.Atan2(ux*vy-uy*vx, ux*vx+uy*vy)
		return a
	}
	theta1 := angle(1, 0, (x1p-cxp)/rx, (y1p-cyp)/ry)
	delta := angle((x1p-cxp)/rx, (y1p-cyp)/ry, (-x1p-cxp)/rx, (-y1p-cyp)/ry)
	if !sweep && delta > 0 {
		delta -= 2 * math.Pi
	} else if sweep && delta < 0 {
		delta += 2 * math.Pi
	}
	steps := int(math.Ceil(math.Abs(delta) / (math.Pi / 16)))
	for step := 1; step <= steps; step++ {
		t := theta1 + delta*float64(step)/float64(steps)
		px := centerX + rx*math.Cos(t)*cosPhi - ry*math.Sin(t)*sinPhi
		py := centerY + rx*math.Cos(t)*sinPhi + ry*math.Sin(t)*cosPhi
		dc.LineTo(ox+px*k, oy+py*k)
	}
}
