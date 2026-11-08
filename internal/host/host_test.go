package host

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/statiolake/vscode-review-relay/internal/review"
	"github.com/statiolake/vscode-review-relay/internal/session"
)

func TestRootIsTheWorkTreeOrTheDirectory(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	repo := filepath.Join(base, "repo")
	deep := filepath.Join(repo, "a", "b")
	os.MkdirAll(deep, 0o755)
	os.Mkdir(filepath.Join(repo, ".git"), 0o755)
	worktree := filepath.Join(base, "wt")
	os.Mkdir(worktree, 0o755)
	os.WriteFile(filepath.Join(worktree, ".git"), []byte("gitdir: elsewhere\n"), 0o644)
	plain := filepath.Join(base, "plain")
	os.Mkdir(plain, 0o755)
	link := filepath.Join(base, "link")
	os.Symlink(deep, link)

	for dir, want := range map[string]string{deep: repo, repo: repo, worktree: worktree, plain: plain, link: repo} {
		if got, err := Root(dir); err != nil || got != want {
			t.Errorf("Root(%s) = %q, %v; want %q", dir, got, err, want)
		}
	}
	if _, err := Root(filepath.Join(base, "missing")); err == nil {
		t.Error("a missing directory has a root")
	}
	os.WriteFile(filepath.Join(base, "file"), nil, 0o644)
	if _, err := Root(filepath.Join(base, "file")); err == nil {
		t.Error("a file has a root")
	}
}

func useTempConfig(t *testing.T) string {
	t.Helper()
	session.Dir = t.TempDir()
	config := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", config) // Linux
	t.Setenv("HOME", config)            // macOS: ~/Library/Application Support
	dir, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestStartCopiesTheStandaloneReviewOnce(t *testing.T) {
	config := useTempConfig(t)
	root := t.TempDir()
	legacy, _ := legacyStateFile(root)
	old, _ := review.Open(legacy)
	if _, err := old.Add(review.CommentInput{Location: review.Location{Path: "a.txt", Line: 0}, Body: "kept", Source: review.SourceHuman}); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(legacy, filepath.Join(config, "review-relay")) {
		t.Fatalf("legacy file %s", legacy)
	}

	r, err := Start(root)
	if err != nil {
		t.Fatal(err)
	}
	r.Close()
	dir, _ := DataDir(root)
	store, err := review.Open(filepath.Join(dir, "state.json"))
	if err != nil || len(store.Snapshot().Comments) != 1 || store.Snapshot().Comments[0].Body != "kept" {
		t.Fatalf("not copied: %v %+v", err, store)
	}
	if _, err := os.Stat(legacy); err != nil {
		t.Fatalf("the standalone viewer's file went: %v", err)
	}

	// From then on the two are apart: a later change there is not taken.
	old.Add(review.CommentInput{Location: review.Location{Path: "a.txt", Line: 1}, Body: "later", Source: review.SourceHuman})
	if _, err := store.Clear(); err != nil {
		t.Fatal(err)
	}
	r, err = Start(root)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	store, _ = review.Open(filepath.Join(dir, "state.json"))
	if n := len(store.Snapshot().Comments); n != 0 {
		t.Fatalf("copied again: %d comments", n)
	}
}

func TestStartIgnoresACorruptedStandaloneReview(t *testing.T) {
	useTempConfig(t)
	root := t.TempDir()
	legacy, _ := legacyStateFile(root)
	os.MkdirAll(filepath.Dir(legacy), 0o700)
	os.WriteFile(legacy, []byte("{nope"), 0o600)
	r, err := Start(root)
	if err != nil {
		t.Fatal(err)
	}
	r.Close()
}

func TestStartRefusesASecondReviewAndACorruptedOne(t *testing.T) {
	useTempConfig(t)
	root := t.TempDir()
	r, err := Start(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Start(root); err != session.ErrRunning {
		t.Fatalf("second review: %v", err)
	}
	r.Close()

	dir, _ := DataDir(root)
	os.WriteFile(filepath.Join(dir, "state.json"), []byte("{nope"), 0o600)
	if _, err := Start(root); err == nil || !strings.Contains(err.Error(), "move the file away") {
		t.Fatalf("a corrupted review: %v", err)
	}
}
