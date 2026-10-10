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
func keyIconFor(state ButtonState) string {
	switch StreamDeckActionType(strings.TrimSpace(state.ActionType)) {
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
		// Mic gain: the sign says which way.
		if state.VolumeDelta < 0 {
			return "mic-minus"
		}
		return "mic-plus"
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
	icon := keyIconFor(state)

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

	layout := r.layoutKey(dc, label, subtitle, icon, look.hearBar, w, h, s)
	if layout.showIcon {
		size := keyIconSize * s
		drawKeyIcon(dc, icon, w/2-size/2, keyPadding*s, size, look.icon)
	}
	if layout.subtitle != "" {
		dc.SetFontFace(r.face(false, layout.subtitleSize))
		dc.SetHexColor(look.subtitle)
		dc.DrawStringAnchored(layout.subtitle, w/2, layout.subtitleY, 0.5, 0.35)
	}
	if len(layout.nameLines) > 0 {
		dc.SetFontFace(r.face(true, layout.nameSize))
		dc.SetHexColor(look.text)
		lineHeight := layout.nameSize * keyLineHeight
		firstY := layout.nameCenterY - float64(len(layout.nameLines)-1)*lineHeight/2
		for i, line := range layout.nameLines {
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

// Key layout, in 72 px units. The name always wins: it gets the largest
// of keyNameSizes that fits completely; if it does not fit next to the
// icon, the icon is left out; only then are long words split and, at the
// very end, the last line cut with "…". The second line stays one line.
const (
	keyPadding      = 6.0
	keyIconSize     = 18.0
	keyIconGap      = 3.0
	keyHearBarSpace = 8.0
	keyLineHeight   = 1.08
)

var (
	keyNameSizes         = []float64{18, 16, 15, 14, 13, 12, 11}
	keyNameSizesWithIcon = []float64{17, 16, 15, 14, 13} // below 13 the icon goes
	keyPlainNameSizes    = []float64{24, 22, 20, 18, 16, 15, 14, 13, 12, 11}
	keySubtitleSizes     = []float64{11, 10, 9}
)

type keyLayout struct {
	showIcon     bool
	nameSize     float64
	nameLines    []string
	nameCenterY  float64
	subtitle     string
	subtitleSize float64
	subtitleY    float64
}

// layoutKey places icon, name and second line; callers hold r.mu.
func (r *ButtonImageRenderer) layoutKey(dc *gg.Context, label, subtitle, icon string, hearBar bool, w, h, s float64) keyLayout {
	maxWidth := w - 2*keyPadding*s
	bottom := h - keyPadding*s
	if hearBar {
		bottom -= keyHearBarSpace * s
	}
	out := keyLayout{}

	if subtitle != "" {
		out.subtitleSize = keySubtitleSizes[len(keySubtitleSizes)-1] * s
		for _, size := range keySubtitleSizes {
			dc.SetFontFace(r.face(false, size*s))
			if width, _ := dc.MeasureString(subtitle); width <= maxWidth {
				out.subtitleSize = size * s
				break
			}
		}
		dc.SetFontFace(r.face(false, out.subtitleSize))
		out.subtitle = truncateToWidth(dc, subtitle, maxWidth)
		out.subtitleY = bottom - out.subtitleSize*0.5
		bottom = out.subtitleY - out.subtitleSize*0.5 - 2*s
	}

	words := strings.Fields(label)
	try := func(withIcon bool, sizes []float64) bool {
		top := keyPadding * s
		if withIcon {
			top += (keyIconSize + keyIconGap) * s
		}
		for _, unit := range sizes {
			size := unit * s
			maxLines := int((bottom - top) / (size * keyLineHeight))
			if maxLines > 3 {
				maxLines = 3
			}
			if maxLines < 1 {
				continue
			}
			dc.SetFontFace(r.face(true, size))
			if lines, ok := wrapWords(dc, words, maxWidth, maxLines); ok {
				lines = balanceTwoLines(dc, words, lines, maxWidth)
				out.showIcon = withIcon
				out.nameSize = size
				out.nameLines = lines
				out.nameCenterY = (top + bottom) / 2
				return true
			}
		}
		return false
	}

	switch {
	case len(words) == 0:
		out.showIcon = icon != ""
	case icon == "":
		if !try(false, keyPlainNameSizes) {
			r.layoutSplitName(dc, &out, label, maxWidth, keyPadding*s, bottom, s)
		}
	default:
		if !try(true, keyNameSizesWithIcon) && !try(false, keyNameSizes) {
			r.layoutSplitName(dc, &out, label, maxWidth, keyPadding*s, bottom, s)
		}
	}
	if len(words) == 0 && icon != "" {
		// Only an icon (and maybe a second line): center it a little lower.
		out.showIcon = true
	}
	return out
}

// layoutSplitName is the last resort for a name that does not fit even at
// the smallest size: long words are split with a hyphen, and what still
// does not fit is cut with "…".
func (r *ButtonImageRenderer) layoutSplitName(dc *gg.Context, out *keyLayout, label string, maxWidth, top, bottom, s float64) {
	size := keyNameSizes[len(keyNameSizes)-1] * s
	dc.SetFontFace(r.face(true, size))
	maxLines := int((bottom - top) / (size * keyLineHeight))
	if maxLines > 3 {
		maxLines = 3
	}
	if maxLines < 1 {
		maxLines = 1
	}
	var pieces []string
	for _, word := range strings.Fields(label) {
		pieces = append(pieces, splitWordToWidth(dc, word, maxWidth)...)
	}
	lines, ok := wrapWords(dc, pieces, maxWidth, maxLines)
	if !ok {
		lines = wrapButtonLines(dc, strings.Join(pieces, " "), maxWidth, maxLines)
		for i := range lines {
			lines[i] = truncateToWidth(dc, lines[i], maxWidth)
		}
	}
	out.showIcon = false
	out.nameSize = size
	out.nameLines = lines
	out.nameCenterY = (top + bottom) / 2
}

// splitWordToWidth breaks a word wider than maxWidth into pieces that end
// in "-" (the last one without).
func splitWordToWidth(dc *gg.Context, word string, maxWidth float64) []string {
	if width, _ := dc.MeasureString(word); width <= maxWidth {
		return []string{word}
	}
	runes := []rune(word)
	var pieces []string
	start := 0
	for start < len(runes) {
		end := len(runes)
		for end > start+1 {
			piece := string(runes[start:end])
			if end < len(runes) {
				piece += "-"
			}
			if width, _ := dc.MeasureString(piece); width <= maxWidth {
				break
			}
			end--
		}
		piece := string(runes[start:end])
		if end < len(runes) {
			piece += "-"
		}
		pieces = append(pieces, piece)
		start = end
	}
	return pieces
}

// truncateToWidth cuts text with "…" so it fits maxWidth.
func truncateToWidth(dc *gg.Context, text string, maxWidth float64) string {
	if width, _ := dc.MeasureString(text); width <= maxWidth {
		return text
	}
	runes := []rune(strings.TrimSuffix(strings.TrimSpace(text), "..."))
	for len(runes) > 0 {
		candidate := strings.TrimSpace(string(runes)) + "…"
		if width, _ := dc.MeasureString(candidate); width <= maxWidth {
			return candidate
		}
		runes = runes[:len(runes)-1]
	}
	return "…"
}

// balanceTwoLines re-splits a two-line name so both lines are about as
// wide ("Party / Line 1" rather than "Party Line / 1").
func balanceTwoLines(dc *gg.Context, words, lines []string, maxWidth float64) []string {
	if len(lines) != 2 || len(words) < 2 {
		return lines
	}
	best := lines
	bestWidest := math.MaxFloat64
	for cut := 1; cut < len(words); cut++ {
		first := strings.Join(words[:cut], " ")
		second := strings.Join(words[cut:], " ")
		w1, _ := dc.MeasureString(first)
		w2, _ := dc.MeasureString(second)
		if w1 > maxWidth || w2 > maxWidth {
			continue
		}
		if widest := math.Max(w1, w2); widest < bestWidest {
			best, bestWidest = []string{first, second}, widest
		}
	}
	return best
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
	"mic-plus":   {"R 5 3 6 11 3", "M2 11a6 6 0 0 0 12 0M8 17v4", "M15 8h7M18.5 4.5v7"},
	"mic-minus":  {"R 5 3 6 11 3", "M2 11a6 6 0 0 0 12 0M8 17v4", "M15 8h7"},
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
