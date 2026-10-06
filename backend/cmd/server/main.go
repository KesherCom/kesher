package main

import (
	"log"
	"net/http"
	_ "net/http/pprof" // registers /debug/pprof on http.DefaultServeMux
	"os"
	"strings"

	"github.com/KesherCom/kesher/backend/internal/app"
)

func main() {
	cfg, err := app.LoadConfig()
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}
	srv, err := app.NewServer(cfg)
	if err != nil {
		log.Fatalf("failed to initialize server: %v", err)
	}
	// Optional profiling endpoint for load tests, e.g.
	// KESHER_PPROF_ADDR=127.0.0.1:6060. Off unless set; never expose it
	// publicly (the app's own routes use a separate mux).
	if addr := strings.TrimSpace(os.Getenv("KESHER_PPROF_ADDR")); addr != "" {
		go func() {
			log.Printf("pprof listening on %s", addr)
			if err := http.ListenAndServe(addr, nil); err != nil {
				log.Printf("pprof server stopped: %v", err)
			}
		}()
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("server stopped with error: %v", err)
	}
}
