package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestNavigateByComment(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/navigate" || r.Method != http.MethodPost {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"navigated":true}`))
	}))
	defer server.Close()

	var out bytes.Buffer
	if err := run([]string{"--endpoint", server.URL, "navigate", "--comment", "comment-1"}, &out); err != nil {
		t.Fatal(err)
	}
	if received["commentId"] != "comment-1" {
		t.Fatalf("unexpected payload: %#v", received)
	}
	if out.String() != `{"navigated":true}` {
		t.Fatalf("unexpected output: %s", out.String())
	}
}

func TestAddComment(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"comment":{"id":"1"}}`))
	}))
	defer server.Close()

	if err := run([]string{"--endpoint", server.URL, "comments", "add", "--uri", "file:///app.ts", "--line", "3", "--body", "Check this"}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if received["source"] != "agent" || received["line"] != float64(3) {
		t.Fatalf("unexpected payload: %#v", received)
	}
}

func TestHelpExitsSuccessfully(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"--help"}, &out); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(out.Bytes(), []byte("comments add")) {
		t.Fatalf("unexpected help: %s", out.String())
	}
}

func TestDiscoversSessionFromWorkspace(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		_, _ = w.Write([]byte(`{"comments":[]}`))
	}))
	defer server.Close()

	workspace := t.TempDir()
	nested := filepath.Join(workspace, "src")
	if err := os.Mkdir(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	previousSessionsPath := sessionsPath
	sessionsPath = directory
	t.Cleanup(func() { sessionsPath = previousSessionsPath })
	descriptor, _ := json.Marshal(sessionDescriptor{Version: 1, ID: "one", Endpoint: server.URL, WorkspaceFolders: []string{workspace}})
	if err := os.WriteFile(filepath.Join(directory, "one.json"), descriptor, 0o600); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	if err := run([]string{"--workspace", nested, "comments", "list"}, &out); err != nil {
		t.Fatal(err)
	}
	if out.String() != `{"comments":[]}` {
		t.Fatalf("unexpected output: %s", out.String())
	}
}

func TestDiscoveryRejectsAmbiguousSessions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"ok":true}`)) }))
	defer server.Close()
	directory := t.TempDir()
	previousSessionsPath := sessionsPath
	sessionsPath = directory
	t.Cleanup(func() { sessionsPath = previousSessionsPath })
	workspace := t.TempDir()
	for _, id := range []string{"one", "two"} {
		descriptor, _ := json.Marshal(sessionDescriptor{Version: 1, ID: id, Endpoint: server.URL + "/" + id, WorkspaceFolders: []string{workspace}})
		if err := os.WriteFile(filepath.Join(directory, id+".json"), descriptor, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := discoverEndpoint(workspace); err == nil {
		t.Fatal("expected ambiguous discovery to fail")
	}
}
