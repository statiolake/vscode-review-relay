// Package host runs a review: a workspace's stored comments behind its
// loopback server, published so that agents and editors find it.
package host

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"

	"github.com/statiolake/vscode-review-relay/internal/review"
	"github.com/statiolake/vscode-review-relay/internal/server"
	"github.com/statiolake/vscode-review-relay/internal/session"
)

// Root is the workspace root a review of dir belongs to: the top of the
// work tree containing dir (the nearest directory holding a .git entry, a
// linked worktree's or a submodule's included), else dir itself. Symlinks
// are resolved, so every way of naming a directory names one review.
func Root(dir string) (string, error) {
	abs, err := session.Canonical(dir)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s is not a directory", abs)
	}
	for d := abs; ; {
		if _, err := os.Lstat(filepath.Join(d, ".git")); err == nil {
			return d, nil
		}
		parent := filepath.Dir(d)
		if parent == d {
			return abs, nil
		}
		d = parent
	}
}

// DataDir is where root's review is stored, outside the workspace so that
// it never ends up in a commit.
func DataDir(root string) (string, error) {
	config, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(config, "vscode-review-relay", "workspaces", key(root)), nil
}

// legacyStateFile is where root's review was kept while the editors used
// standalone review-relay's server (the same key under review-relay's
// directory, which the standalone viewer keeps using).
func legacyStateFile(root string) (string, error) {
	config, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(config, "review-relay", "workspaces", key(root), "state.json"), nil
}

func key(root string) string {
	sum := sha256.Sum256([]byte(root))
	return hex.EncodeToString(sum[:8])
}

// openStore opens root's stored review. A workspace with none yet takes a
// copy of the one standalone review-relay kept for it, if any: the editors'
// comments lived there before this core. It is copied, not moved, since the
// standalone viewer may still show it; from then on the two are apart.
func openStore(root string) (*review.Store, error) {
	dir, err := DataDir(root)
	if err != nil {
		return nil, err
	}
	file := filepath.Join(dir, "state.json")
	if _, err := os.Stat(file); errors.Is(err, fs.ErrNotExist) {
		if legacy, err := legacyStateFile(root); err == nil {
			if old, err := review.Open(legacy); err == nil {
				if err := review.WriteJSONFile(file, old.Snapshot()); err != nil {
					return nil, err
				}
			}
			// An unreadable or corrupted legacy file is left alone: the
			// review starts empty rather than refusing to start.
		}
	}
	store, err := review.Open(file)
	if err != nil {
		return nil, fmt.Errorf("%w\nmove the file away to start with an empty review", err)
	}
	return store, nil
}

// Review is one running review.
type Review struct {
	Root     string
	Endpoint string

	srv    *server.Server
	reg    *session.Registration
	served chan error
}

// Start serves root's stored review and publishes it. It fails with
// session.ErrRunning when another process already serves root.
func Start(root string) (*Review, error) {
	store, err := openStore(root)
	if err != nil {
		return nil, err
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	srv := server.New(root, store, exe)
	endpoint, serve, err := srv.Listen()
	if err != nil {
		return nil, err
	}
	reg, err := session.Register(root, endpoint)
	if err != nil {
		srv.Close()
		return nil, err
	}
	r := &Review{Root: root, Endpoint: endpoint, srv: srv, reg: reg, served: make(chan error, 1)}
	go func() {
		err := serve()
		if !errors.Is(err, http.ErrServerClosed) {
			r.served <- fmt.Errorf("server stopped: %w", err)
		}
		close(r.served)
	}()
	return r, nil
}

// Failed yields the error that stopped the server, if it stops on its own;
// it is closed without a value once Close stops it.
func (r *Review) Failed() <-chan error { return r.served }

// Close unpublishes the review and stops its server. Its comments are
// already on disk, so the next review of root has them.
func (r *Review) Close() error {
	return errors.Join(r.reg.Close(), r.srv.Close())
}
