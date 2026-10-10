package app

import (
	"embed"
	"io/fs"
)

//go:embed all:embedded_web
var embeddedStaticFS embed.FS

func embeddedStaticAvailable() bool {
	_, err := fs.Stat(embeddedStaticFS, "embedded_web/index.html")
	return err == nil
}
