package main

import (
	"log"

	"github.com/KesherCom/kesher/backend/internal/app"
)

func main() {
	cfg := app.LoadConfig()
	srv, err := app.NewServer(cfg)
	if err != nil {
		log.Fatalf("failed to initialize server: %v", err)
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("server stopped with error: %v", err)
	}
}
