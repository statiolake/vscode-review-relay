package session

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func live(t *testing.T) string {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	t.Cleanup(ts.Close)
	return ts.URL
}

func TestOneLiveReviewPerRoot(t *testing.T) {
	Dir = t.TempDir()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	first := live(t)
	reg, err := Register(root, first)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Register(root, live(t)); err != ErrRunning {
		t.Fatalf("a second review of the root: %v", err)
	}
	if got, err := Lookup(root); err != nil || got != first {
		t.Fatalf("Lookup = %q, %v", got, err)
	}
	if _, err := Lookup(filepath.Join(root, "sub")); err == nil {
		t.Fatal("Lookup is exact, not by containment")
	}
	if got, gotRoot, err := Find(filepath.Join(root, "sub")); err != nil || got != first || gotRoot != root {
		t.Fatalf("Find = %q %q %v", got, gotRoot, err)
	}
	reg.Close()
	if _, err := Lookup(root); err == nil {
		t.Fatal("found a closed review")
	}
}

func TestADeadReviewIsReplaced(t *testing.T) {
	Dir = t.TempDir()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	if _, err := Register(root, dead.URL); err != nil {
		t.Fatal(err)
	}
	dead.Close() // killed: its descriptor stays behind
	next := live(t)
	if _, err := Register(root, next); err != nil {
		t.Fatalf("a dead review's descriptor blocks: %v", err)
	}
	if got, err := Lookup(root); err != nil || got != next {
		t.Fatalf("Lookup = %q, %v", got, err)
	}
	entries, _ := os.ReadDir(Dir)
	if len(entries) != 1 {
		t.Fatalf("left %d files", len(entries))
	}
}
