package server

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/statiolake/vscode-review-relay/internal/review"
)

func newTestServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("one\ntwo\nthree\n"), 0o644)
	store, err := review.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	s := New(root, store, "/path/to/review-relay")
	ts := httptest.NewUnstartedServer(nil)
	ts.Start()
	s.SetAddr(ts.Listener.Addr().String())
	ts.Config.Handler = s.Handler()
	t.Cleanup(ts.Close)
	return ts, root
}

func do(t *testing.T, ts *httptest.Server, method, path, body string, header map[string]string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestGuardRejectsBrowsersAndForeignHosts(t *testing.T) {
	ts, _ := newTestServer(t)
	// No page is served here, so every Origin is foreign, even its own.
	for _, origin := range []string{"https://evil.example", ts.URL} {
		if code, _ := do(t, ts, "GET", "/v1/comments", "", map[string]string{"Origin": origin}); code != 403 {
			t.Fatalf("origin %s: %d", origin, code)
		}
	}
	if code, _ := do(t, ts, "GET", "/v1/comments", "", nil); code != 200 {
		t.Fatalf("no origin: %d", code)
	}
	req, _ := http.NewRequest("GET", ts.URL+"/health", nil)
	req.Host = "attacker.example:80"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("foreign host: %d", resp.StatusCode)
	}
}

func TestSessionOverallAndInstructions(t *testing.T) {
	ts, root := newTestServer(t)
	if code, out := do(t, ts, "GET", "/v1/session", "", nil); code != 200 || out["root"] != root {
		t.Fatalf("session: %d %v", code, out)
	}
	if code, _ := do(t, ts, "PUT", "/v1/overall", `{"overall":"looks good"}`, nil); code != 200 {
		t.Fatalf("overall: %d", code)
	}
	do(t, ts, "POST", "/v1/comments", `{"path":"a.txt","line":0,"body":"hi"}`, nil)
	if _, out := do(t, ts, "GET", "/v1/comments", "", nil); out["overall"] != "looks good" || len(out["comments"].([]any)) != 1 {
		t.Fatalf("state: %v", out)
	}
	if code, _ := do(t, ts, "DELETE", "/v1/review", "", nil); code != 200 {
		t.Fatalf("clear review: %d", code)
	}
	if _, out := do(t, ts, "GET", "/v1/comments", "", nil); out["overall"] != "" || len(out["comments"].([]any)) != 0 {
		t.Fatalf("after clearing: %v", out)
	}
	_, out := do(t, ts, "GET", "/v1/instructions", "", nil)
	text, _ := out["text"].(string)
	if !strings.Contains(text, `"/path/to/review-relay" --workspace "`+root+`"`) || !strings.Contains(text, ts.URL) {
		t.Fatalf("instructions: %q", text)
	}
	// What only the standalone viewer had is not here.
	for _, path := range []string{"/v1/files", "/v1/view?path=a.txt", "/"} {
		if code, _ := do(t, ts, "GET", path, "", nil); code != 404 {
			t.Errorf("GET %s: %d, want 404", path, code)
		}
	}
}

func TestCommentLifecycleAndErrors(t *testing.T) {
	ts, _ := newTestServer(t)
	code, out := do(t, ts, "POST", "/v1/comments", `{"path":"a.txt","line":1,"body":"hi"}`, nil)
	if code != 201 {
		t.Fatalf("add: %d %v", code, out)
	}
	id := out["comment"].(map[string]any)["id"].(string)

	if code, out := do(t, ts, "POST", "/v1/comments/"+id+"/replies", `{"path":"a.txt","line":2,"body":"re"}`, nil); code != 201 {
		t.Fatalf("reply: %d %v", code, out)
	}
	if code, _ := do(t, ts, "PATCH", "/v1/comments/"+id, `{"body":"edited"}`, nil); code != 200 {
		t.Fatalf("edit: %d", code)
	}
	cases := []struct {
		method, path, body string
		want               int
	}{
		{"POST", "/v1/comments", `{"path":"../x","line":0,"body":"b"}`, 400},
		{"POST", "/v1/comments", `{"path":"a.txt","line":0,"body":""}`, 400},
		{"POST", "/v1/comments", `{"path":"a.txt","line":0,"body":"b","extra":1}`, 400},
		{"POST", "/v1/comments/00000000-0000-4000-8000-000000000000/replies", `{"path":"a.txt","line":0,"body":"b"}`, 404},
		{"DELETE", "/v1/comments/nope", "", 400},
		{"POST", "/v1/navigate", `{"path":"a.txt","line":9}`, 400},
		{"POST", "/v1/navigate", `{"path":"a.txt","line":0}`, 503}, // no editor connected
		{"POST", "/v1/navigate", `{"path":"missing.txt","line":0}`, 400},
		{"POST", "/v1/navigate", `{"path":"../outside","line":0}`, 400},
	}
	for _, c := range cases {
		if code, out := do(t, ts, c.method, c.path, c.body, nil); code != c.want {
			t.Errorf("%s %s %s: %d %v, want %d", c.method, c.path, c.body, code, out, c.want)
		} else if out["error"] == "" {
			t.Errorf("%s %s: no error message", c.method, c.path)
		}
	}
	if code, out := do(t, ts, "PUT", "/v1/comments/"+id+"/resolved", `{"resolved":true}`, nil); code != 200 || out["comment"].(map[string]any)["resolved"] != true {
		t.Fatalf("resolve: %d %v", code, out)
	}
	if _, out := do(t, ts, "GET", "/v1/comments?resolved=false", "", nil); len(out["comments"].([]any)) != 0 {
		t.Fatalf("unresolved filter kept a resolved thread: %v", out)
	}
	if _, out := do(t, ts, "GET", "/v1/comments?resolved=true", "", nil); len(out["comments"].([]any)) != 2 {
		t.Fatalf("resolved filter: %v", out)
	}
	for _, c := range []struct {
		body string
		want int
	}{{`{}`, 400}, {`{"resolved":"yes"}`, 400}} {
		if code, _ := do(t, ts, "PUT", "/v1/comments/"+id+"/resolved", c.body, nil); code != c.want {
			t.Errorf("resolve %s: %d, want %d", c.body, code, c.want)
		}
	}
	if code, _ := do(t, ts, "GET", "/v1/comments?resolved=maybe", "", nil); code != 400 {
		t.Errorf("bad resolved filter: %d", code)
	}
	if code, _ := do(t, ts, "PUT", "/v1/comments/00000000-0000-4000-8000-000000000000/resolved", `{"resolved":true}`, nil); code != 404 {
		t.Errorf("resolve missing: %d", code)
	}
	if code, out := do(t, ts, "PUT", "/v1/comments/"+id+"/resolved", `{"resolved":false}`, nil); code != 200 || out["comment"].(map[string]any)["resolved"] != nil {
		t.Fatalf("unresolve: %d %v", code, out)
	}

	code, out = do(t, ts, "GET", "/v1/comments?path=a.txt", "", nil)
	comments := out["comments"].([]any)
	if code != 200 || len(comments) != 2 || comments[0].(map[string]any)["line"].(float64) != 2 {
		t.Fatalf("list: %d %v", code, out)
	}
	if code, out := do(t, ts, "DELETE", "/v1/comments/"+id, "", nil); code != 200 || out["remainingComments"].(float64) != 0 {
		t.Fatalf("delete: %d %v", code, out)
	}
}

func TestNavigateReachesConnectedEditors(t *testing.T) {
	ts, _ := newTestServer(t)
	resp, err := http.Get(ts.URL + "/v1/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	lines := make(chan string)
	go func() {
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
	}()
	// The events handler registers the client before flushing headers, so
	// the editor counts as connected once the response arrived.
	if code, out := do(t, ts, "POST", "/v1/navigate", `{"path":"a.txt","line":1,"endLine":2}`, nil); code != 200 {
		t.Fatalf("navigate: %d %v", code, out)
	}
	deadline := time.After(2 * time.Second)
	for {
		select {
		case line := <-lines:
			if strings.HasPrefix(line, "data: ") && strings.Contains(line, `"endLine":2`) {
				return
			}
		case <-deadline:
			t.Fatal("navigate event not received")
		}
	}
}

func TestMoveAndImport(t *testing.T) {
	ts, _ := newTestServer(t)
	_, out := do(t, ts, "POST", "/v1/comments", `{"path":"a.txt","line":0,"body":"hi","source":"human"}`, nil)
	id := out["comment"].(map[string]any)["id"].(string)
	code, out := do(t, ts, "PUT", "/v1/comments/"+id+"/location", `{"path":"a.txt","line":1,"endLine":2}`, nil)
	if moved := out["comment"].(map[string]any); code != 200 || moved["line"] != 1.0 || moved["endLine"] != 2.0 {
		t.Fatalf("move: %d %v", code, out)
	}
	_, list := do(t, ts, "GET", "/v1/comments", "", nil)
	if n := len(list["comments"].([]any)); n != 1 {
		t.Fatalf("move added a comment: %d", n)
	}

	imported := `{"comments":[{"id":"11111111-1111-4111-8111-111111111111","path":"a.txt","line":0,"endLine":0,
		"body":"old","author":"Human","source":"human","createdAt":"2026-01-02T03:04:05Z","resolved":true}]}`
	if code, out := do(t, ts, "POST", "/v1/import", imported, nil); code != 200 || out["imported"] != 1.0 {
		t.Fatalf("import: %d %v", code, out)
	}
	if code, out := do(t, ts, "POST", "/v1/import", imported, nil); code != 200 || out["imported"] != 0.0 {
		t.Fatalf("import again: %d %v", code, out)
	}
	if code, _ := do(t, ts, "POST", "/v1/import", `{"comments":[{"id":"x"}]}`, nil); code != 400 {
		t.Fatalf("a malformed import: %d", code)
	}
}
