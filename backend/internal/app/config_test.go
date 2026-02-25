package app

import (
	"os"
	"reflect"
	"testing"
)

func TestSplitCSV(t *testing.T) {
	got := splitCSV(" foh, stage ,,video-control ")
	want := []string{"foh", "stage", "video-control"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected split result: got %v want %v", got, want)
	}
}

func TestGetEnvIntFallbackOnInvalidValue(t *testing.T) {
	t.Setenv("TEST_ENV_INT", "not-a-number")
	if got := getEnvInt("TEST_ENV_INT", 42); got != 42 {
		t.Fatalf("expected fallback for invalid int, got %d", got)
	}
}

func TestGetAnyEnvPrefersFirstNonEmptyTrimmedValue(t *testing.T) {
	t.Setenv("TEST_ENV_PRIMARY", "   ")
	t.Setenv("TEST_ENV_SECONDARY", " token ")
	if got := getAnyEnv("TEST_ENV_PRIMARY", "TEST_ENV_SECONDARY"); got != "token" {
		t.Fatalf("unexpected env value: %q", got)
	}
}

func TestGetEnvUsesFallbackWhenUnset(t *testing.T) {
	const key = "TEST_ENV_UNSET"
	_ = os.Unsetenv(key)
	if got := getEnv(key, "fallback"); got != "fallback" {
		t.Fatalf("expected fallback, got %q", got)
	}
}
