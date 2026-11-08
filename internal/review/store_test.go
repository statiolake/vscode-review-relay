package review

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func intp(v int) *int { return &v }

func openTemp(t *testing.T) (*Store, string) {
	t.Helper()
	file := filepath.Join(t.TempDir(), "state.json")
	s, err := Open(file)
	if err != nil {
		t.Fatal(err)
	}
	return s, file
}

func TestAddReplyMovesThreadAndPersists(t *testing.T) {
	s, file := openTemp(t)
	root, err := s.Add(CommentInput{Location: Location{Path: "a.go", Line: 3}, Body: "  why?  ", Source: SourceHuman})
	if err != nil {
		t.Fatal(err)
	}
	if root.Body != "why?" || root.Author != "Human" || root.EndLine != 3 {
		t.Fatalf("unexpected root %+v", root)
	}
	reply, err := s.Reply(root.ID, CommentInput{Location: Location{Path: "b.go", Line: 7, EndLine: intp(9)}, Body: "moved"})
	if err != nil {
		t.Fatal(err)
	}
	if reply.ParentID != root.ID || reply.Author != "AI" || reply.Source != SourceAgent {
		t.Fatalf("unexpected reply %+v", reply)
	}
	// Replying to a reply attaches to the root.
	nested, err := s.Reply(reply.ID, CommentInput{Location: Location{Path: "b.go", Line: 7, EndLine: intp(9)}, Body: "again"})
	if err != nil {
		t.Fatal(err)
	}
	if nested.ParentID != root.ID {
		t.Fatalf("nested reply parent = %s, want root", nested.ParentID)
	}

	reopened, err := Open(file)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range reopened.Snapshot().Comments {
		if c.Path != "b.go" || c.Line != 7 || c.EndLine != 9 {
			t.Fatalf("thread not moved: %+v", c)
		}
	}
}

func TestRemoveRootRemovesThreadButReplyOnlyItself(t *testing.T) {
	s, _ := openTemp(t)
	loc := Location{Path: "a.go", Line: 0}
	root, _ := s.Add(CommentInput{Location: loc, Body: "r"})
	r1, _ := s.Reply(root.ID, CommentInput{Location: loc, Body: "1"})
	s.Reply(root.ID, CommentInput{Location: loc, Body: "2"})
	if remaining, err := s.Remove(r1.ID); err != nil || remaining != 2 {
		t.Fatalf("remove reply: remaining=%d err=%v", remaining, err)
	}
	if remaining, err := s.Remove(root.ID); err != nil || remaining != 0 {
		t.Fatalf("remove root: remaining=%d err=%v", remaining, err)
	}
	if _, err := s.Remove(root.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second remove: %v", err)
	}
}

func TestValidationErrors(t *testing.T) {
	s, _ := openTemp(t)
	cases := []CommentInput{
		{Location: Location{Path: "", Line: 0}, Body: "x"},
		{Location: Location{Path: "../etc/passwd", Line: 0}, Body: "x"},
		{Location: Location{Path: "/abs", Line: 0}, Body: "x"},
		{Location: Location{Path: "a", Line: -1}, Body: "x"},
		{Location: Location{Path: "a", Line: 5, EndLine: intp(4)}, Body: "x"},
		{Location: Location{Path: "a", Line: 0}, Body: "   "},
		{Location: Location{Path: "a", Line: 0}, Body: "x", Source: "robot"},
	}
	for _, input := range cases {
		_, err := s.Add(input)
		var ve *ValidationError
		if !errors.As(err, &ve) {
			t.Errorf("Add(%+v) = %v, want ValidationError", input, err)
		}
	}
	if _, err := s.Update("not-a-uuid", "x"); err == nil {
		t.Error("Update accepted an invalid id")
	}
}

func TestOpenRejectsCorruptState(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state.json")
	os.WriteFile(file, []byte(`{"comments":[{"id":"x"}],"overall":""}`), 0o600)
	if _, err := Open(file); err == nil || !strings.Contains(err.Error(), "corrupted") {
		t.Fatalf("Open = %v, want corruption error", err)
	}
}

func TestSubscribersRunAfterPersist(t *testing.T) {
	s, file := openTemp(t)
	calls := 0
	s.Subscribe(func() {
		calls++
		if _, err := os.Stat(file); err != nil {
			t.Errorf("listener ran before the state was written: %v", err)
		}
	})
	s.SetOverall("hello")
	s.ClearReview()
	if calls != 2 {
		t.Fatalf("calls = %d", calls)
	}
}

func TestResolveAndReplyReopens(t *testing.T) {
	s, file := openTemp(t)
	loc := Location{Path: "a.go", Line: 0}
	root, _ := s.Add(CommentInput{Location: loc, Body: "r"})
	reply, _ := s.Reply(root.ID, CommentInput{Location: loc, Body: "1"})

	// Resolving through a reply marks the root.
	got, err := s.SetResolved(reply.ID, true)
	if err != nil || got.ID != root.ID || !got.Resolved {
		t.Fatalf("SetResolved = %+v, %v", got, err)
	}
	reopened, err := Open(file)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range reopened.Snapshot().Comments {
		if c.Resolved != (c.ID == root.ID) {
			t.Fatalf("resolved not persisted on the root only: %+v", c)
		}
	}

	if _, err := s.Reply(root.ID, CommentInput{Location: loc, Body: "2"}); err != nil {
		t.Fatal(err)
	}
	if c, _ := s.Find(root.ID); c.Resolved {
		t.Fatal("a reply did not reopen the thread")
	}
	if _, err := s.SetResolved("00000000-0000-4000-8000-000000000000", true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing id: %v", err)
	}
}

func TestOpenResolvedState(t *testing.T) {
	const root = `{"id":"00000000-0000-4000-8000-000000000001","path":"a","line":0,"endLine":0,"body":"b","author":"A","source":"human","createdAt":"2026-01-01T00:00:00Z"`
	const reply = `{"id":"00000000-0000-4000-8000-000000000002","parentId":"00000000-0000-4000-8000-000000000001","path":"a","line":0,"endLine":0,"body":"b","author":"A","source":"agent","createdAt":"2026-01-01T00:00:00Z"`
	file := filepath.Join(t.TempDir(), "state.json")
	// A state file from before resolving existed loads as unresolved.
	os.WriteFile(file, []byte(`{"comments":[`+root+`}],"overall":""}`), 0o600)
	s, err := Open(file)
	if err != nil || s.Snapshot().Comments[0].Resolved {
		t.Fatalf("old state: %v", err)
	}
	os.WriteFile(file, []byte(`{"comments":[`+root+`},`+reply+`,"resolved":true}],"overall":""}`), 0o600)
	if _, err := Open(file); err == nil || !strings.Contains(err.Error(), "root") {
		t.Fatalf("resolved reply accepted: %v", err)
	}
}

func TestMoveKeepsTheThreadAsItIs(t *testing.T) {
	s, _ := openTemp(t)
	root, _ := s.Add(CommentInput{Location: Location{Path: "a.go", Line: 1}, Body: "r"})
	reply, _ := s.Reply(root.ID, CommentInput{Location: Location{Path: "a.go", Line: 1}, Body: "1"})
	s.SetResolved(root.ID, true)
	moved, err := s.Move(reply.ID, Location{Path: "a.go", Line: 4, EndLine: intp(6)})
	if err != nil {
		t.Fatal(err)
	}
	if moved.ID != root.ID || !moved.Resolved || moved.Line != 4 || moved.EndLine != 6 {
		t.Fatalf("unexpected root after move %+v", moved)
	}
	if n := len(s.Snapshot().Comments); n != 2 {
		t.Fatalf("move added comments: %d", n)
	}
	if _, err := s.Move(newUUID(), Location{Path: "a.go", Line: 0}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("move of a missing thread: %v", err)
	}
}

func TestImportKeepsIdsAndSkipsKnownOnes(t *testing.T) {
	s, _ := openTemp(t)
	other, _ := openTemp(t)
	root, _ := other.Add(CommentInput{Location: Location{Path: "a.go", Line: 1}, Body: "r", Source: SourceHuman})
	other.Reply(root.ID, CommentInput{Location: Location{Path: "a.go", Line: 1}, Body: "1"})
	export := other.Snapshot().Comments
	if n, err := s.Import(export); err != nil || n != 2 {
		t.Fatalf("import: %d %v", n, err)
	}
	if n, err := s.Import(export); err != nil || n != 0 {
		t.Fatalf("second import: %d %v", n, err)
	}
	if got, _ := s.Find(root.ID); got.Author != "Human" {
		t.Fatalf("imported root %+v", got)
	}
	orphan := export[1]
	orphan.ID, orphan.ParentID = newUUID(), newUUID()
	if _, err := s.Import([]Comment{orphan}); err == nil {
		t.Fatal("an orphan reply was imported")
	}
}
