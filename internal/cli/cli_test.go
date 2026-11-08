package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/statiolake/vscode-review-relay/internal/session"
)

type recorded struct {
	method, path string
	body         map[string]any
}

func fakeViewer(t *testing.T) (*httptest.Server, *[]recorded) {
	t.Helper()
	var calls []recorded
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &body)
		if r.URL.Path != "/health" {
			calls = append(calls, recorded{r.Method, r.URL.RequestURI(), body})
		}
		if strings.Contains(r.URL.Path, "missing") {
			w.WriteHeader(404)
			io.WriteString(w, `{"error":"comment not found"}`)
			return
		}
		io.WriteString(w, `{"ok":true}`)
	}))
	t.Cleanup(ts.Close)
	return ts, &calls
}

func TestCommandsBuildRequests(t *testing.T) {
	ts, calls := fakeViewer(t)
	run := func(args ...string) error {
		return Run(append([]string{"--endpoint", ts.URL}, args...), io.Discard)
	}
	if err := run("comments", "add", "--path", "a.go", "--line", "3", "--end-line", "4", "--body", "hi"); err != nil {
		t.Fatal(err)
	}
	if err := run("comments", "reply", "ID", "--path", "a.go", "--line", "3", "--body", "re"); err != nil {
		t.Fatal(err)
	}
	if err := run("comments", "list", "--path", "a b.go"); err != nil {
		t.Fatal(err)
	}
	if err := run("navigate", "--comment", "ID"); err != nil {
		t.Fatal(err)
	}
	if err := run("comments", "resolve", "ID"); err != nil {
		t.Fatal(err)
	}
	if err := run("comments", "unresolve", "ID"); err != nil {
		t.Fatal(err)
	}
	if err := run("comments", "list", "--unresolved", "--path", "a.go"); err != nil {
		t.Fatal(err)
	}
	got := *calls
	if got[0].path != "/v1/comments" || got[0].body["endLine"] != float64(4) || got[0].body["source"] != "agent" {
		t.Errorf("add: %+v", got[0])
	}
	if got[1].path != "/v1/comments/ID/replies" || got[1].body["line"] != float64(3) {
		t.Errorf("reply: %+v", got[1])
	}
	if got[2].path != "/v1/comments?path=a+b.go" {
		t.Errorf("list: %+v", got[2])
	}
	if got[3].body["commentId"] != "ID" {
		t.Errorf("navigate: %+v", got[3])
	}
	if got[4].method != "PUT" || got[4].path != "/v1/comments/ID/resolved" || got[4].body["resolved"] != true {
		t.Errorf("resolve: %+v", got[4])
	}
	if got[5].path != "/v1/comments/ID/resolved" || got[5].body["resolved"] != false {
		t.Errorf("unresolve: %+v", got[5])
	}
	if got[6].path != "/v1/comments?path=a.go&resolved=false" {
		t.Errorf("list --unresolved: %+v", got[6])
	}

	for _, bad := range [][]string{
		{"comments", "add", "--path", "a"},
		{"comments", "reply", "--path", "a", "--line", "1", "--body", "x"},
		{"navigate", "--comment", "ID", "--line", "2"},
		{"navigate"},
		{"comments", "list", "stray"},
		{"comments", "resolve"},
		{"comments", "unresolve", "ID", "extra"},
		{"bogus"},
	} {
		if err := run(bad...); err == nil {
			t.Errorf("%v accepted", bad)
		}
	}
	if err := run("comments", "remove", "missing"); err == nil || !strings.Contains(err.Error(), "comment not found") {
		t.Errorf("API error not surfaced: %v", err)
	}
}

func TestDiscoveryPicksDeepestRoot(t *testing.T) {
	session.Dir = t.TempDir()
	outer, outerCalls := fakeViewer(t)
	inner, innerCalls := fakeViewer(t)
	root := t.TempDir()
	root, _ = filepath.EvalSymlinks(root)
	sub := filepath.Join(root, "sub")
	os.Mkdir(sub, 0o755)
	session.Register(root, outer.URL)
	session.Register(sub, inner.URL)

	var out bytes.Buffer
	if err := Run([]string{"--workspace", filepath.Join(sub), "comments", "list"}, &out); err != nil {
		t.Fatal(err)
	}
	if len(*innerCalls) != 1 || len(*outerCalls) != 0 {
		t.Fatalf("inner=%d outer=%d", len(*innerCalls), len(*outerCalls))
	}
	if err := Run([]string{"--workspace", t.TempDir(), "health"}, io.Discard); err == nil {
		t.Fatal("discovery outside every root succeeded")
	}
}
