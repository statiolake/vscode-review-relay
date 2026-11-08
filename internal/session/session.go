// Package session is how a review is found: each running review server
// writes a descriptor naming its workspace root and its loopback endpoint.
// The agent CLI finds the review containing its directory; `attach` finds
// the review of exactly its root. One descriptor per root (named after it,
// created exclusively) keeps a root to one server.
package session

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Dir is where descriptors live. Tests override it.
var Dir = filepath.Join(os.TempDir(), "vscode-review-relay", "sessions")

const version = 1

type descriptor struct {
	Version  int    `json:"version"`
	Endpoint string `json:"endpoint"`
	Root     string `json:"root"`
}

// ErrRunning is returned by Register when a live review already serves root.
var ErrRunning = errors.New("a review is already running for this workspace")

// Registration is this process's descriptor file.
type Registration struct{ file string }

func fileOf(root string) string {
	sum := sha256.Sum256([]byte(root))
	return filepath.Join(Dir, hex.EncodeToString(sum[:8])+".json")
}

// Register publishes endpoint as the review of root. It fails with
// ErrRunning if a live review already has root; a descriptor left behind by
// a review that was killed is replaced.
func Register(root, endpoint string) (*Registration, error) {
	if err := os.MkdirAll(Dir, 0o700); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(descriptor{Version: version, Endpoint: endpoint, Root: root})
	if err != nil {
		return nil, err
	}
	file := fileOf(root)
	// Written aside, then linked into place: a descriptor is never seen half
	// written, and linking fails if another review got there first.
	tmp, err := os.CreateTemp(Dir, ".new-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	_, err = tmp.Write(append(encoded, '\n'))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, err
	}
	for try := 0; try < 2; try++ {
		err := os.Link(tmp.Name(), file)
		if err == nil {
			return &Registration{file: file}, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if d, ok := read(file); ok && healthy(d.Endpoint) {
			return nil, ErrRunning
		}
		os.Remove(file) // stale: its review is gone
	}
	return nil, ErrRunning
}

// Close removes the descriptor.
func (r *Registration) Close() error { return os.Remove(r.file) }

func read(file string) (descriptor, bool) {
	encoded, err := os.ReadFile(file)
	if err != nil {
		return descriptor{}, false
	}
	var d descriptor
	if json.Unmarshal(encoded, &d) != nil || d.Version != version || !isLoopback(d.Endpoint) {
		return descriptor{}, false
	}
	return d, true
}

// Lookup returns the endpoint of the live review of exactly root.
func Lookup(root string) (string, error) {
	d, ok := read(fileOf(root))
	if !ok || d.Root != root || !healthy(d.Endpoint) {
		return "", fmt.Errorf("no review is running for %s", root)
	}
	return d.Endpoint, nil
}

// Find returns the endpoint of the live review whose root is the deepest one
// containing dir. Descriptors of reviews that no longer answer are skipped:
// they are left behind when a review is killed.
func Find(dir string) (endpoint, root string, err error) {
	requested, err := Canonical(dir)
	if err != nil {
		return "", "", fmt.Errorf("resolve %q: %w", dir, err)
	}
	entries, err := os.ReadDir(Dir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", "", err
	}
	var best *descriptor
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		d, ok := read(filepath.Join(Dir, entry.Name()))
		if !ok || !contains(d.Root, requested) || (best != nil && len(d.Root) <= len(best.Root)) || !healthy(d.Endpoint) {
			continue
		}
		best = &d
	}
	if best == nil {
		return "", "", fmt.Errorf("no review is running for %q; open the workspace in VS Code or Neovim (:ReviewRelay), or run `review-relay serve` in it", requested)
	}
	return best.Endpoint, best.Root, nil
}

// Canonical is p absolute, cleaned and with symlinks resolved (as far as it
// exists).
func Canonical(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	return filepath.Clean(abs), nil
}

func contains(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func isLoopback(endpoint string) bool {
	u, err := url.Parse(endpoint)
	return err == nil && u.Scheme == "http" && u.Hostname() == "127.0.0.1" && u.Port() != ""
}

// healthy reports whether endpoint answers. A review that is gone refuses
// the connection at once; a busy machine can take a while to answer, so the
// wait is generous rather than tight.
func healthy(endpoint string) bool {
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Get(strings.TrimRight(endpoint, "/") + "/health")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}
