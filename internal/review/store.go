package review

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

// ErrNotFound is returned when a referenced comment does not exist.
var ErrNotFound = errors.New("comment not found")

// Store is the single owner of a workspace's review state. Every mutation is
// validated, written to disk, and then announced to subscribers.
type Store struct {
	file string

	mu        sync.Mutex
	state     State
	listeners []func()
}

// Open loads the state stored in file, or starts empty if it does not exist.
// A file that exists but fails validation is an error: the caller decides
// whether to discard it, never this package.
func Open(file string) (*Store, error) {
	s := &Store{file: file, state: State{Comments: []Comment{}}}
	encoded, err := os.ReadFile(file)
	if errors.Is(err, fs.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	var state State
	if err := json.Unmarshal(encoded, &state); err != nil {
		return nil, fmt.Errorf("%s is corrupted: %w", file, err)
	}
	if state.Comments == nil {
		state.Comments = []Comment{}
	}
	if err := state.Validate(); err != nil {
		return nil, fmt.Errorf("%s is corrupted: %w", file, err)
	}
	s.state = state
	return s, nil
}

// Snapshot returns a copy of the current state.
func (s *Store) Snapshot() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return State{Comments: slices.Clone(s.state.Comments), Overall: s.state.Overall}
}

// Find returns the comment with the given id.
func (s *Store) Find(id string) (Comment, error) {
	if err := ValidateID(id); err != nil {
		return Comment{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	i := slices.IndexFunc(s.state.Comments, func(x Comment) bool { return x.ID == id })
	if i < 0 {
		return Comment{}, ErrNotFound
	}
	return s.state.Comments[i], nil
}

// Subscribe registers fn to run after every change.
func (s *Store) Subscribe(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listeners = append(s.listeners, fn)
}

// Add creates a new thread.
func (s *Store) Add(input CommentInput) (Comment, error) {
	c, err := newComment(input)
	if err != nil {
		return Comment{}, err
	}
	return c, s.mutate(func(state *State) error {
		state.Comments = append(state.Comments, c)
		return nil
	})
}

// Reply appends to the thread containing id, moves the whole thread to the
// reply's location, and reopens the thread if it was resolved.
func (s *Store) Reply(id string, input CommentInput) (Comment, error) {
	if err := ValidateID(id); err != nil {
		return Comment{}, err
	}
	c, err := newComment(input)
	if err != nil {
		return Comment{}, err
	}
	return c, s.mutate(func(state *State) error {
		i := slices.IndexFunc(state.Comments, func(x Comment) bool { return x.ID == id })
		if i < 0 {
			return ErrNotFound
		}
		root := state.Comments[i].ID
		if parent := state.Comments[i].ParentID; parent != "" {
			root = parent
		}
		c.ParentID = root
		for j := range state.Comments {
			if x := &state.Comments[j]; x.ID == root || x.ParentID == root {
				x.Path, x.Line, x.EndLine = c.Path, c.Line, c.EndLine
				if x.ID == root {
					x.Resolved = false
				}
			}
		}
		state.Comments = append(state.Comments, c)
		return nil
	})
}

// Move puts the thread containing id at loc, as an editor does when the
// lines above it change: unlike Reply it adds nothing and reopens nothing.
// It returns the thread's root.
func (s *Store) Move(id string, loc Location) (Comment, error) {
	if err := ValidateID(id); err != nil {
		return Comment{}, err
	}
	line, end, err := loc.Normalize()
	if err != nil {
		return Comment{}, err
	}
	var root Comment
	return root, s.mutate(func(state *State) error {
		i := slices.IndexFunc(state.Comments, func(x Comment) bool { return x.ID == id })
		if i < 0 {
			return ErrNotFound
		}
		rootID := state.Comments[i].ID
		if parent := state.Comments[i].ParentID; parent != "" {
			rootID = parent
		}
		for j := range state.Comments {
			if x := &state.Comments[j]; x.ID == rootID || x.ParentID == rootID {
				x.Path, x.Line, x.EndLine = loc.Path, line, end
				if x.ID == rootID {
					root = *x
				}
			}
		}
		return nil
	})
}

// Import adds comments written elsewhere (another store's export), keeping
// their ids, authors and times. A comment whose id is already here is
// skipped, so importing the same export twice adds nothing. The result
// must be a valid state, or nothing is imported. It returns how many were
// added.
func (s *Store) Import(comments []Comment) (int, error) {
	var added int
	err := s.mutate(func(state *State) error {
		known := map[string]bool{}
		for _, c := range state.Comments {
			known[c.ID] = true
		}
		for _, c := range comments {
			if known[c.ID] {
				continue
			}
			known[c.ID] = true
			state.Comments = append(state.Comments, c)
			added++
		}
		if err := state.Validate(); err != nil {
			return err
		}
		return nil
	})
	return added, err
}

// SetResolved resolves or reopens the thread containing id and returns the
// thread's root.
func (s *Store) SetResolved(id string, resolved bool) (Comment, error) {
	if err := ValidateID(id); err != nil {
		return Comment{}, err
	}
	var root Comment
	err := s.mutate(func(state *State) error {
		i := slices.IndexFunc(state.Comments, func(x Comment) bool { return x.ID == id })
		if i < 0 {
			return ErrNotFound
		}
		if parent := state.Comments[i].ParentID; parent != "" {
			i = slices.IndexFunc(state.Comments, func(x Comment) bool { return x.ID == parent })
		}
		state.Comments[i].Resolved = resolved
		root = state.Comments[i]
		return nil
	})
	return root, err
}

// Update replaces a comment's body.
func (s *Store) Update(id, body string) (Comment, error) {
	if err := ValidateID(id); err != nil {
		return Comment{}, err
	}
	body, err := NormalizeBody(body)
	if err != nil {
		return Comment{}, err
	}
	var updated Comment
	return updated, s.mutate(func(state *State) error {
		i := slices.IndexFunc(state.Comments, func(x Comment) bool { return x.ID == id })
		if i < 0 {
			return ErrNotFound
		}
		state.Comments[i].Body = body
		updated = state.Comments[i]
		return nil
	})
}

// Remove deletes a comment. Removing a root removes its whole thread; removing
// a reply keeps the rest of the thread. It returns the remaining count.
func (s *Store) Remove(id string) (int, error) {
	if err := ValidateID(id); err != nil {
		return 0, err
	}
	var remaining int
	return remaining, s.mutate(func(state *State) error {
		before := len(state.Comments)
		state.Comments = slices.DeleteFunc(state.Comments, func(x Comment) bool {
			return x.ID == id || x.ParentID == id
		})
		if len(state.Comments) == before {
			return ErrNotFound
		}
		remaining = len(state.Comments)
		return nil
	})
}

// Clear deletes every comment and returns how many were removed.
func (s *Store) Clear() (int, error) {
	var removed int
	return removed, s.mutate(func(state *State) error {
		removed = len(state.Comments)
		state.Comments = []Comment{}
		return nil
	})
}

// SetOverall replaces the overall comment.
func (s *Store) SetOverall(overall string) error {
	if err := ValidateOverall(overall); err != nil {
		return err
	}
	return s.mutate(func(state *State) error {
		state.Overall = overall
		return nil
	})
}

// ClearReview deletes every comment and the overall comment.
func (s *Store) ClearReview() error {
	return s.mutate(func(state *State) error {
		state.Comments = []Comment{}
		state.Overall = ""
		return nil
	})
}

// mutate applies fn to a copy of the state, then validates, persists and
// publishes it. The in-memory state only changes once it is on disk.
func (s *Store) mutate(fn func(*State) error) error {
	s.mu.Lock()
	next := State{Comments: slices.Clone(s.state.Comments), Overall: s.state.Overall}
	if err := fn(&next); err != nil {
		s.mu.Unlock()
		return err
	}
	if err := next.Validate(); err != nil {
		s.mu.Unlock()
		panic(fmt.Sprintf("review state invariant broken by a mutation: %v", err))
	}
	if err := WriteJSONFile(s.file, next); err != nil {
		s.mu.Unlock()
		return err
	}
	s.state = next
	listeners := slices.Clone(s.listeners)
	s.mu.Unlock()
	for _, fn := range listeners {
		fn()
	}
	return nil
}

func newComment(input CommentInput) (Comment, error) {
	line, end, err := input.Normalize()
	if err != nil {
		return Comment{}, err
	}
	body, err := NormalizeBody(input.Body)
	if err != nil {
		return Comment{}, err
	}
	source, err := normalizeSource(input.Source)
	if err != nil {
		return Comment{}, err
	}
	author, err := normalizeAuthor(input.Author, source)
	if err != nil {
		return Comment{}, err
	}
	return Comment{
		ID:        newUUID(),
		Path:      input.Path,
		Line:      line,
		EndLine:   end,
		Body:      body,
		Author:    author,
		Source:    source,
		CreatedAt: time.Now().UTC().Truncate(time.Millisecond),
	}, nil
}

func newUUID() string {
	var b [16]byte
	rand.Read(b[:]) // crypto/rand.Read never returns an error
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// WriteJSONFile atomically replaces file with value encoded as JSON.
func WriteJSONFile(file string, value any) error {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, append(encoded, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}
