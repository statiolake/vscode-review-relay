package attach

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/statiolake/vscode-review-relay/internal/session"
)

type peer struct {
	in   *io.PipeWriter
	out  chan Message
	done chan error
}

func start(t *testing.T, dir string) *peer {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	p := &peer{in: inW, out: make(chan Message, 64), done: make(chan error, 1)}
	go func() {
		err := Run(dir, Options{}, inR, outW)
		outW.Close()
		p.done <- err
	}()
	go func() {
		scanner := bufio.NewScanner(outR)
		for scanner.Scan() {
			var m Message
			if err := json.Unmarshal(scanner.Bytes(), &m); err != nil {
				t.Errorf("not JSON: %q", scanner.Text())
				continue
			}
			p.out <- m
		}
		close(p.out)
	}()
	t.Cleanup(func() { inW.Close() })
	return p
}

// next waits for a message of the given type, skipping others.
func (p *peer) next(t *testing.T, typ string) Message {
	t.Helper()
	timeout := time.After(15 * time.Second)
	for {
		select {
		case m, ok := <-p.out:
			if !ok {
				t.Fatalf("stdout closed while waiting for %s", typ)
			}
			if m.Type == "error" {
				t.Fatalf("attach failed: %s", m.Message)
			}
			if m.Type == typ {
				return m
			}
		case <-timeout:
			t.Fatalf("no %s message", typ)
		}
	}
}

func (p *peer) send(t *testing.T, req Request) {
	t.Helper()
	line, _ := json.Marshal(req)
	if _, err := p.in.Write(append(line, '\n')); err != nil {
		t.Fatal(err)
	}
}

func TestAttachStartsSharesAndTakesOverTheReview(t *testing.T) {
	session.Dir = t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\n"), 0o644)

	first := start(t, dir)
	hello := first.next(t, "attached")
	if !hello.Owner || hello.Endpoint == "" {
		t.Fatalf("the first attach should run the review: %+v", hello)
	}

	second := start(t, dir)
	if m := second.next(t, "attached"); m.Owner || m.Endpoint != hello.Endpoint {
		t.Fatalf("the second attach should use the running review: %+v", m)
	}

	first.send(t, Request{ID: 7, Method: "POST", Path: "/v1/comments",
		Body: json.RawMessage(`{"path":"a.txt","line":1,"body":"why?","source":"human"}`)})
	if r := first.next(t, "response"); r.ID != 7 || r.Status != 201 {
		t.Fatalf("add: %+v %s", r, r.Body)
	}
	if ev := second.next(t, "event"); ev.Name != "state" {
		t.Fatalf("the other frontend was not told: %+v", ev)
	}

	// The first one leaves, taking its server; the second runs the next.
	first.in.Close()
	if err := <-first.done; err != nil {
		t.Fatal(err)
	}
	again := second.next(t, "attached")
	if !again.Owner || again.Endpoint == hello.Endpoint {
		t.Fatalf("the second attach should have taken over: %+v", again)
	}
	second.send(t, Request{ID: 8, Method: "GET", Path: "/v1/comments"})
	r := second.next(t, "response")
	var state struct {
		Comments []struct{ Body string } `json:"comments"`
	}
	json.Unmarshal(r.Body, &state)
	if r.Status != 200 || len(state.Comments) != 1 || state.Comments[0].Body != "why?" {
		t.Fatalf("the review did not survive the takeover: %d %s", r.Status, r.Body)
	}
}

func TestNoStartOnlyUsesARunningReview(t *testing.T) {
	session.Dir = t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	dir := t.TempDir()
	var out strings.Builder
	if err := Run(dir, Options{NoStart: true}, strings.NewReader(""), &out); err == nil {
		t.Fatal("attached with no review running")
	}
	if !strings.Contains(out.String(), `"type":"error"`) {
		t.Fatalf("no error line: %q", out.String())
	}
}

func TestAttachUsesTheWorkTreeRootAndRejectsNoDirectory(t *testing.T) {
	session.Dir = t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	repo, _ := filepath.EvalSymlinks(t.TempDir())
	os.Mkdir(filepath.Join(repo, ".git"), 0o755)
	sub := filepath.Join(repo, "sub")
	os.Mkdir(sub, 0o755)

	p := start(t, sub)
	if m := p.next(t, "attached"); m.Root != repo || string(m.Session) != `{"root":"`+repo+`"}` {
		t.Fatalf("attached: %+v %s", m, m.Session)
	}

	var out strings.Builder
	if err := Run(filepath.Join(repo, "missing"), Options{}, strings.NewReader(""), &out); err == nil || !strings.Contains(out.String(), `"type":"error"`) {
		t.Fatalf("attached to a missing directory: %v %q", err, out.String())
	}
}
