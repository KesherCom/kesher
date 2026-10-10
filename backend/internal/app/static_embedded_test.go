package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNoWebUIPointsToTheDevServer(t *testing.T) {
	rec := httptest.NewRecorder()
	handleNoWebUI(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "make dev-web") {
		t.Fatalf("page: got %d %q", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	handleNoWebUI(rec, httptest.NewRequest(http.MethodGet, "/api/unknown", nil))
	if rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), "make dev-web") {
		t.Fatalf("api: got %d %q", rec.Code, rec.Body.String())
	}
}
