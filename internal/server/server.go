// Package server is a review's loopback HTTP server: one API under /v1/ for
// every client — the editor frontends (through `review-relay attach`) and
// agents (through the CLI). It serves comments and nothing else: no files,
// no diffs, no page.
package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/statiolake/vscode-review-relay/internal/review"
)

const maxRequestBytes = 2 << 20

// Server wires a workspace's review store to HTTP. Construct it with New,
// then call Listen.
type Server struct {
	root    string
	store   *review.Store
	cliPath string

	addr string       // host:port once listening
	http *http.Server // set by Listen

	mu      sync.Mutex
	clients map[chan event]struct{}
}

type event struct {
	name string
	data any
}

// New creates the server of the review of root. cliPath is the executable
// agents should run.
func New(root string, store *review.Store, cliPath string) *Server {
	s := &Server{root: root, store: store, cliPath: cliPath, clients: map[chan event]struct{}{}}
	store.Subscribe(func() { s.broadcast(event{name: "state", data: struct{}{}}) })
	return s
}

// Listen binds a random loopback port and returns the endpoint URL and a
// function that serves until the listener fails.
func (s *Server) Listen() (endpoint string, serve func() error, err error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	s.addr = ln.Addr().String()
	s.http = &http.Server{Handler: s.Handler()}
	return "http://" + s.addr, func() error { return s.http.Serve(ln) }, nil
}

// Close stops serving and drops every connection, event streams included;
// serve then returns http.ErrServerClosed.
func (s *Server) Close() error {
	if s.http == nil {
		return nil
	}
	return s.http.Close()
}

// Endpoint is the base URL; valid after Listen.
func (s *Server) Endpoint() string { return "http://" + s.addr }

// Handler routes every request. Tests may call it after setting the address
// with SetAddr instead of Listen.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handle(func(*http.Request) (int, any, error) {
		return http.StatusOK, map[string]any{"ok": true, "root": s.root}, nil
	}))
	mux.HandleFunc("GET /v1/session", s.handle(func(*http.Request) (int, any, error) {
		return http.StatusOK, map[string]any{"root": s.root}, nil
	}))
	mux.HandleFunc("GET /v1/comments", s.handle(s.listComments))
	mux.HandleFunc("POST /v1/comments", s.handle(s.addComment))
	mux.HandleFunc("DELETE /v1/comments", s.handle(s.clearComments))
	mux.HandleFunc("POST /v1/comments/{id}/replies", s.handle(s.replyComment))
	mux.HandleFunc("PATCH /v1/comments/{id}", s.handle(s.updateComment))
	mux.HandleFunc("PUT /v1/comments/{id}/resolved", s.handle(s.resolveComment))
	mux.HandleFunc("PUT /v1/comments/{id}/location", s.handle(s.moveComment))
	mux.HandleFunc("DELETE /v1/comments/{id}", s.handle(s.removeComment))
	mux.HandleFunc("POST /v1/import", s.handle(s.importComments))
	mux.HandleFunc("PUT /v1/overall", s.handle(s.setOverall))
	mux.HandleFunc("DELETE /v1/review", s.handle(s.clearReview))
	mux.HandleFunc("POST /v1/navigate", s.handle(s.navigate))
	mux.HandleFunc("GET /v1/instructions", s.handle(s.instructions))
	mux.HandleFunc("GET /v1/events", s.events)
	return s.guard(mux)
}

// SetAddr fixes the host:port the guard accepts, for tests using Handler.
func (s *Server) SetAddr(addr string) { s.addr = addr }

// guard only lets through requests addressed to this server by name (which
// defeats DNS rebinding) and not from a browser page: no page is served
// here, so any Origin is foreign.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != s.addr {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "Unexpected Host header."})
			return
		}
		if r.Header.Get("Origin") != "" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "Browser-origin requests are not allowed."})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// httpError carries a status code for an error the client caused.
type httpError struct {
	status int
	err    error
}

func (e httpError) Error() string { return e.err.Error() }

func badRequest(err error) error { return httpError{http.StatusBadRequest, err} }

// handle adapts a handler returning (status, value, error) and is the single
// place errors become responses: httpError keeps its status, model validation
// errors are 400, ErrNotFound is 404, and anything else is a 500.
func (s *Server) handle(fn func(*http.Request) (int, any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status, value, err := fn(r)
		if err != nil {
			var he httpError
			var ve *review.ValidationError
			switch {
			case errors.As(err, &he):
				status = he.status
			case errors.As(err, &ve):
				status = http.StatusBadRequest
			case errors.Is(err, review.ErrNotFound):
				status = http.StatusNotFound
			default:
				status = http.StatusInternalServerError
			}
			value = map[string]string{"error": err.Error()}
		}
		writeJSON(w, status, value)
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value) // a failed write only means the client went away
}

func readJSON(r *http.Request, into any) error {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return httpError{http.StatusUnsupportedMediaType, errors.New("Content-Type must be application/json")}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBytes+1))
	if err != nil {
		return err
	}
	if len(body) > maxRequestBytes {
		return badRequest(errors.New("request body is too large"))
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return badRequest(fmt.Errorf("invalid JSON: %w", err))
	}
	return nil
}

// listComments returns the state, optionally narrowed to one path and to
// threads that are (?resolved=true) or are not (?resolved=false) resolved.
func (s *Server) listComments(r *http.Request) (int, any, error) {
	state := s.store.Snapshot()
	query := r.URL.Query()
	p := query.Get("path")
	var wantResolved *bool
	switch v := query.Get("resolved"); v {
	case "":
	case "true", "false":
		b := v == "true"
		wantResolved = &b
	default:
		return 0, nil, badRequest(errors.New(`resolved must be "true" or "false"`))
	}
	resolved := map[string]bool{}
	for _, c := range state.Comments {
		if c.ParentID == "" {
			resolved[c.ID] = c.Resolved
		}
	}
	filtered := []review.Comment{}
	for _, c := range state.Comments {
		root := c.ID
		if c.ParentID != "" {
			root = c.ParentID
		}
		if (p == "" || c.Path == p) && (wantResolved == nil || resolved[root] == *wantResolved) {
			filtered = append(filtered, c)
		}
	}
	state.Comments = filtered
	return http.StatusOK, state, nil
}

func (s *Server) addComment(r *http.Request) (int, any, error) {
	var input review.CommentInput
	if err := readJSON(r, &input); err != nil {
		return 0, nil, err
	}
	c, err := s.store.Add(input)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, map[string]any{"comment": c}, nil
}

func (s *Server) replyComment(r *http.Request) (int, any, error) {
	var input review.CommentInput
	if err := readJSON(r, &input); err != nil {
		return 0, nil, err
	}
	c, err := s.store.Reply(r.PathValue("id"), input)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, map[string]any{"comment": c}, nil
}

func (s *Server) updateComment(r *http.Request) (int, any, error) {
	var input struct {
		Body string `json:"body"`
	}
	if err := readJSON(r, &input); err != nil {
		return 0, nil, err
	}
	c, err := s.store.Update(r.PathValue("id"), input.Body)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, map[string]any{"comment": c}, nil
}

func (s *Server) resolveComment(r *http.Request) (int, any, error) {
	var input struct {
		Resolved *bool `json:"resolved"`
	}
	if err := readJSON(r, &input); err != nil {
		return 0, nil, err
	}
	if input.Resolved == nil {
		return 0, nil, badRequest(errors.New("resolved is required"))
	}
	root, err := s.store.SetResolved(r.PathValue("id"), *input.Resolved)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, map[string]any{"comment": root}, nil
}

// moveComment puts a thread at a new location without replying: an editor
// reports where its lines went after an edit.
func (s *Server) moveComment(r *http.Request) (int, any, error) {
	var input review.Location
	if err := readJSON(r, &input); err != nil {
		return 0, nil, err
	}
	root, err := s.store.Move(r.PathValue("id"), input)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, map[string]any{"comment": root}, nil
}

// importComments adds comments exported from another store (the VS Code
// extension's workspace state, from before it had this core), ids kept.
func (s *Server) importComments(r *http.Request) (int, any, error) {
	var input struct {
		Comments []review.Comment `json:"comments"`
	}
	if err := readJSON(r, &input); err != nil {
		return 0, nil, err
	}
	added, err := s.store.Import(input.Comments)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, map[string]any{"imported": added}, nil
}

func (s *Server) removeComment(r *http.Request) (int, any, error) {
	remaining, err := s.store.Remove(r.PathValue("id"))
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, map[string]any{"removed": true, "remainingComments": remaining}, nil
}

func (s *Server) clearComments(*http.Request) (int, any, error) {
	removed, err := s.store.Clear()
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, map[string]any{"removed": removed, "remainingComments": 0}, nil
}

func (s *Server) setOverall(r *http.Request) (int, any, error) {
	var input struct {
		Overall string `json:"overall"`
	}
	if err := readJSON(r, &input); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, map[string]any{}, s.store.SetOverall(input.Overall)
}

// clearReview deletes every comment and the overall comment.
func (s *Server) clearReview(*http.Request) (int, any, error) {
	return http.StatusOK, map[string]any{}, s.store.ClearReview()
}

// navigateTarget is where an editor goes.
type navigateTarget struct {
	Path      string `json:"path"`
	Line      int    `json:"line"`
	EndLine   int    `json:"endLine"`
	CommentID string `json:"commentId,omitempty"`
}

func (s *Server) navigate(r *http.Request) (int, any, error) {
	var input struct {
		CommentID string `json:"commentId,omitempty"`
		review.Location
	}
	if err := readJSON(r, &input); err != nil {
		return 0, nil, err
	}
	var target navigateTarget
	if input.CommentID != "" {
		if input.Path != "" || input.Line != 0 || input.EndLine != nil {
			return 0, nil, badRequest(errors.New("give either commentId or path and line, not both"))
		}
		c, err := s.store.Find(input.CommentID)
		if err != nil {
			return 0, nil, err
		}
		target = navigateTarget{Path: c.Path, Line: c.Line, EndLine: c.EndLine, CommentID: c.ID}
	} else {
		line, end, err := input.Normalize()
		if err != nil {
			return 0, nil, err
		}
		lines, err := s.lineCount(input.Path)
		if err != nil {
			return 0, nil, badRequest(err)
		}
		if end >= lines {
			return 0, nil, badRequest(fmt.Errorf("navigation range is outside the file (%d lines)", lines))
		}
		target = navigateTarget{Path: input.Path, Line: line, EndLine: end}
	}
	if !s.broadcast(event{name: "navigate", data: target}) {
		return 0, nil, httpError{http.StatusServiceUnavailable, errors.New("no editor is connected to this review")}
	}
	return http.StatusOK, map[string]any{"navigated": target}, nil
}

// lineCount counts p's lines as editors number them (a trailing newline
// starts no line), reading it from inside the root only.
func (s *Server) lineCount(p string) (int, error) {
	root, err := os.OpenRoot(s.root)
	if err != nil {
		return 0, err
	}
	defer root.Close()
	content, err := fs.ReadFile(root.FS(), filepath.ToSlash(p))
	if errors.Is(err, fs.ErrNotExist) {
		return 0, fmt.Errorf("%s does not exist in the workspace", p)
	}
	if err != nil {
		return 0, err
	}
	n := bytes.Count(content, []byte{'\n'})
	if len(content) > 0 && content[len(content)-1] != '\n' {
		n++
	}
	return max(n, 1), nil
}

func (s *Server) instructions(*http.Request) (int, any, error) {
	return http.StatusOK, map[string]string{"text": AgentInstructions(s.Endpoint(), s.cliPath, s.root)}, nil
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher := w.(http.Flusher) // net/http's ResponseWriter always supports it
	ch := make(chan event, 16)
	s.mu.Lock()
	s.clients[ch] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.clients, ch)
		s.mu.Unlock()
	}()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev := <-ch:
			data, err := json.Marshal(ev.data)
			if err != nil {
				panic(err) // events carry plain structs
			}
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.name, data); err != nil {
				return // client went away; its context ends this stream
			}
			flusher.Flush()
		}
	}
}

// broadcast sends ev to every connected client and reports whether any was.
func (s *Server) broadcast(ev event) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.clients {
		select {
		case ch <- ev:
		default:
			// The client is far behind; it reads the state again on any
			// event, so dropping one only matters for navigation.
		}
	}
	return len(s.clients) > 0
}
