package app

import (
	"context"
	"testing"
	"time"
)

// A layout with two main pages and a folder below the first:
//
//	page 0 (main):   key 0 next page, key 1 opens the folder, key 2 first page
//	page 1 (main):   key 0 previous page, key 1 next page
//	page 2 (folder of page 0): key 0 is Back (set by the server), key 1 next page
//
// The editor had page 1 open when it saved (selectedPage 1).
func pageTestLayout() StreamDeckSettings {
	keys := func(set map[int]StreamDeckButtonAction) []StreamDeckButtonConfig {
		buttons := make([]StreamDeckButtonConfig, StreamDeckButtonCount)
		for i := range buttons {
			buttons[i] = StreamDeckButtonConfig{Index: i}
			if a, ok := set[i]; ok {
				action := a
				buttons[i].Action = &action
			}
		}
		return buttons
	}
	zero := 0
	return StreamDeckSettings{
		Version:      1,
		GridColumns:  StreamDeckGridColumns,
		GridRows:     StreamDeckGridRows,
		SelectedPage: 1,
		Pages: []StreamDeckPageConfig{
			{Page: 0, Title: "Main", PageType: StreamDeckPageTypeManual, Buttons: keys(map[int]StreamDeckButtonAction{
				0: {Type: StreamDeckActionTypePageUp},
				1: {Type: StreamDeckActionTypePageJump, TargetPage: 2},
				2: {Type: StreamDeckActionTypePageHome},
			})},
			{Page: 1, Title: "Second", PageType: StreamDeckPageTypeManual, Buttons: keys(map[int]StreamDeckButtonAction{
				0: {Type: StreamDeckActionTypePageDown},
				1: {Type: StreamDeckActionTypePageUp},
			})},
			{Page: 2, Title: "Folder", PageType: StreamDeckPageTypeManual, ParentPage: &zero, Buttons: keys(map[int]StreamDeckButtonAction{
				1: {Type: StreamDeckActionTypePageUp},
			})},
		},
	}
}

func TestStreamDeckPageNavigation(t *testing.T) {
	ctx := context.Background()
	s := newCompanionTestServer(t)
	addPlaceClient(s, "token-anna", "u-anna", "anna", "camera", "place-1", time.Now())
	deck, err := s.store.TouchStreamDeck(ctx, "Nav deck", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.store.UpdateStreamDeck(ctx, deck.ID, deck.Name, "place-1", "anna"); err != nil {
		t.Fatal(err)
	}
	layout := pageTestLayout()
	if _, err := s.store.SetStreamDeckLayout(ctx, deck.ID, &layout); err != nil {
		t.Fatal(err)
	}
	key := deckKey(deck.ID)
	press := func(index int) {
		t.Helper()
		for _, phase := range []string{"down", "up"} {
			res := s.executeCompanionButtonPress(ctx, key, "anna", CompanionCommand{Command: "press_button", ButtonIndex: index, State: phase})
			if !res.OK {
				t.Fatalf("press key %d %s: %s", index, phase, res.Error)
			}
		}
	}
	expect := func(step string, want int) {
		t.Helper()
		if got := s.currentCompanionPage(ctx, key); got != want {
			t.Fatalf("%s: deck shows page %d, want %d", step, got, want)
		}
	}

	expect("start: the first main page, not the page open in the editor", 0)
	press(0)
	expect("next page", 1)
	press(1)
	expect("next page on the last main page stays (no folders in between)", 1)
	press(0)
	expect("previous page", 0)
	press(1)
	expect("folder key", 2)
	press(1)
	expect("next page inside a folder stays in the folder (it has no siblings)", 2)
	press(0)
	expect("Back", 0)

	// Saving the layout (the editor autosaves) keeps the deck where it is.
	press(0)
	expect("next page again", 1)
	if _, err := s.store.SetStreamDeckLayout(ctx, deck.ID, &layout); err != nil {
		t.Fatal(err)
	}
	s.refreshDeckLayout(deck.ID)
	expect("after a layout save", 1)

	// A page that no longer exists sends the deck to the first main page.
	layout.Pages = layout.Pages[:1]
	layout.SelectedPage = 0
	if _, err := s.store.SetStreamDeckLayout(ctx, deck.ID, &layout); err != nil {
		t.Fatal(err)
	}
	s.refreshDeckLayout(deck.ID)
	expect("after its page was removed", 0)

	// Someone else logs in at the place: start from the first page.
	s.setCompanionCurrentPage(key, 2)
	s.refreshDeck(deck.ID)
	expect("new login at the place", 0)
}

// A page that fills itself (all roles) always has a way out on key 1.
func TestAutoPagesHaveAWayOut(t *testing.T) {
	ctx := context.Background()
	s := newCompanionTestServer(t)
	addPlaceClient(s, "token-anna", "u-anna", "anna", "camera", "place-1", time.Now())
	deck, err := s.store.TouchStreamDeck(ctx, "Roles deck", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.store.UpdateStreamDeck(ctx, deck.ID, deck.Name, "place-1", "anna"); err != nil {
		t.Fatal(err)
	}
	key := deckKey(deck.ID)
	empty := func() []StreamDeckButtonConfig {
		b := make([]StreamDeckButtonConfig, StreamDeckButtonCount)
		for i := range b {
			b[i] = StreamDeckButtonConfig{Index: i}
		}
		return b
	}
	main := empty()
	main[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypePageUp}
	save := func(pages ...StreamDeckPageConfig) {
		t.Helper()
		layout := StreamDeckSettings{Version: 1, GridColumns: StreamDeckGridColumns, GridRows: StreamDeckGridRows, Pages: pages}
		if _, err := s.store.SetStreamDeckLayout(ctx, deck.ID, &layout); err != nil {
			t.Fatal(err)
		}
		s.refreshDeck(deck.ID)
	}
	key1 := func() string {
		t.Helper()
		settings, _ := s.companionLayout(ctx, key)
		settings = s.companionResolvedSettings(ctx, s.companionTargetRole(ctx, key), settings)
		page := s.resolveCompanionRuntimePage(ctx, s.companionTargetRole(ctx, key), settings, s.currentCompanionPage(ctx, key)).Page
		if page.Buttons[0].Action == nil {
			return ""
		}
		return string(page.Buttons[0].Action.Type)
	}
	press := func(index int) {
		t.Helper()
		for _, phase := range []string{"down", "up"} {
			if res := s.executeCompanionButtonPress(ctx, key, "anna", CompanionCommand{Command: "press_button", ButtonIndex: index, State: phase}); !res.OK {
				t.Fatalf("press %d: %s", index, res.Error)
			}
		}
	}

	// All roles as the second main page: key 1 goes back.
	save(
		StreamDeckPageConfig{Page: 0, PageType: StreamDeckPageTypeManual, Buttons: main},
		StreamDeckPageConfig{Page: 1, PageType: StreamDeckPageTypeAllRoles, Buttons: empty()},
	)
	press(0)
	if got := s.currentCompanionPage(ctx, key); got != 1 {
		t.Fatalf("next page: got %d", got)
	}
	if got := key1(); got != string(StreamDeckActionTypePageBack) {
		t.Fatalf("all roles page key 1 = %q, want page_back", got)
	}
	press(0)
	if got := s.currentCompanionPage(ctx, key); got != 0 {
		t.Fatalf("Back from all roles: got page %d, want 0", got)
	}

	// All roles as the first page: key 1 goes on to the next page.
	save(
		StreamDeckPageConfig{Page: 0, PageType: StreamDeckPageTypeAllRoles, Buttons: empty()},
		StreamDeckPageConfig{Page: 1, PageType: StreamDeckPageTypeManual, Buttons: empty()},
	)
	if got := key1(); got != string(StreamDeckActionTypePageUp) {
		t.Fatalf("first page all roles key 1 = %q, want page_up", got)
	}
	press(0)
	if got := s.currentCompanionPage(ctx, key); got != 1 {
		t.Fatalf("from the first all roles page: got %d, want 1", got)
	}
}
