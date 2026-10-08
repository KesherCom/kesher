package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAdminMuteAndKickUser(t *testing.T) {
	s := newCompanionTestServer(t)
	user, err := s.store.UpsertUser(context.Background(), "anna", "camera")
	if err != nil {
		t.Fatal(err)
	}
	session := s.sessions.Create(user)
	c := addPlaceClient(s, session.Token, user.ID, "anna", "camera", "place-1", time.Now())
	s.hub.SetVoiceState(session.Token, "always_on")

	rec := httptest.NewRecorder()
	s.handleAdminUserIntervention(rec, httptest.NewRequest(http.MethodPost, "/api/admin/users/"+user.ID+"/mute", nil), user.ID, "mute")
	if rec.Code != http.StatusOK {
		t.Fatalf("mute: %d %s", rec.Code, rec.Body.String())
	}
	if c.micEnabled || c.voiceMode != "ptt" {
		t.Fatalf("mic should be off on the server: mic=%v mode=%s", c.micEnabled, c.voiceMode)
	}
	gotMute := false
	for len(c.send) > 0 || len(c.sendPriority) > 0 {
		select {
		case msg := <-c.send:
			gotMute = gotMute || msg.Type == "admin_mute"
		case msg := <-c.sendPriority:
			gotMute = gotMute || msg.Type == "admin_mute"
		}
	}
	if !gotMute {
		t.Fatal("the client must be told to turn its microphone off")
	}

	rec = httptest.NewRecorder()
	s.handleAdminUserIntervention(rec, httptest.NewRequest(http.MethodPost, "/api/admin/users/"+user.ID+"/kick", nil), user.ID, "kick")
	if rec.Code != http.StatusOK {
		t.Fatalf("kick: %d", rec.Code)
	}
	if _, ok := s.sessions.Get(session.Token); ok {
		t.Fatal("kick must end the session")
	}

	rec = httptest.NewRecorder()
	s.handleAdminUserIntervention(rec, httptest.NewRequest(http.MethodPost, "/api/admin/users/"+user.ID+"/mute", nil), user.ID, "mute")
	if rec.Code != http.StatusConflict {
		t.Fatalf("muting someone offline: expected 409, got %d", rec.Code)
	}
}
