// Package review is the review: inline comment threads on lines of a
// workspace's files and the overall comment, the rules they keep, and their
// on-disk persistence. Nothing here knows about diffs or editors.
package review

import (
	"fmt"
	"io/fs"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	MaxPathLength    = 16 * 1024
	MaxBodyLength    = 64 * 1024
	MaxAuthorLength  = 256
	MaxOverallLength = 1024 * 1024
)

// Source tells who wrote a comment.
type Source string

const (
	SourceHuman Source = "human"
	SourceAgent Source = "agent"
)

// Comment is one entry of a thread. A thread is a root comment (no ParentID)
// followed by its replies in creation order; replies are never nested. Every
// comment of a thread shares the thread's location.
//
// Path is slash-separated and relative to the workspace root. Line and EndLine
// are zero-based and inclusive.
//
// Resolved marks a thread the user is done with. It lives on the root only;
// a new reply reopens the thread. State files written before it existed load
// as unresolved.
type Comment struct {
	ID        string    `json:"id"`
	ParentID  string    `json:"parentId,omitempty"`
	Path      string    `json:"path"`
	Line      int       `json:"line"`
	EndLine   int       `json:"endLine"`
	Body      string    `json:"body"`
	Author    string    `json:"author"`
	Source    Source    `json:"source"`
	CreatedAt time.Time `json:"createdAt"`
	Resolved  bool      `json:"resolved,omitempty"`
}

// State is everything persisted for one workspace.
type State struct {
	Comments []Comment `json:"comments"`
	Overall  string    `json:"overall"`
}

// Location is a line range in a workspace file.
type Location struct {
	Path    string `json:"path"`
	Line    int    `json:"line"`
	EndLine *int   `json:"endLine,omitempty"`
}

// CommentInput creates a thread, or a reply that moves its thread to Location.
type CommentInput struct {
	Location
	Body   string `json:"body"`
	Author string `json:"author,omitempty"`
	Source Source `json:"source,omitempty"`
}

// ValidationError reports input that breaks a rule of the model. Callers use
// it to tell bad input apart from failures such as disk errors.
type ValidationError struct{ msg string }

func (e *ValidationError) Error() string { return e.msg }

func invalid(format string, args ...any) error {
	return &ValidationError{msg: fmt.Sprintf(format, args...)}
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ValidateID checks that id has the shape of the IDs this package issues.
func ValidateID(id string) error {
	if !uuidPattern.MatchString(id) {
		return invalid("invalid comment id %q", id)
	}
	return nil
}

// ValidatePath checks that p names a file inside the workspace.
func ValidatePath(p string) error {
	if p == "" {
		return invalid("path is required")
	}
	if len(p) > MaxPathLength {
		return invalid("path must not exceed %d bytes", MaxPathLength)
	}
	if !fs.ValidPath(p) || p == "." || strings.Contains(p, `\`) {
		return invalid("path %q must be slash-separated and relative to the workspace root", p)
	}
	return nil
}

// Normalize validates a location and fills in EndLine, returning start and end.
func (l Location) Normalize() (start, end int, err error) {
	if err := ValidatePath(l.Path); err != nil {
		return 0, 0, err
	}
	if l.Line < 0 {
		return 0, 0, invalid("line must be a non-negative integer")
	}
	end = l.Line
	if l.EndLine != nil {
		end = *l.EndLine
	}
	if end < l.Line {
		return 0, 0, invalid("endLine must be greater than or equal to line")
	}
	return l.Line, end, nil
}

// NormalizeBody trims body and checks its length.
func NormalizeBody(body string) (string, error) {
	body = strings.TrimSpace(body)
	if body == "" {
		return "", invalid("body is required")
	}
	if utf8.RuneCountInString(body) > MaxBodyLength {
		return "", invalid("body must not exceed %d characters", MaxBodyLength)
	}
	return body, nil
}

func normalizeAuthor(author string, source Source) (string, error) {
	author = strings.TrimSpace(author)
	if author == "" {
		if source == SourceHuman {
			return "Human", nil
		}
		return "AI", nil
	}
	if utf8.RuneCountInString(author) > MaxAuthorLength {
		return "", invalid("author must not exceed %d characters", MaxAuthorLength)
	}
	return author, nil
}

func normalizeSource(source Source) (Source, error) {
	switch source {
	case "":
		return SourceAgent, nil
	case SourceHuman, SourceAgent:
		return source, nil
	}
	return "", invalid("source must be %q or %q", SourceHuman, SourceAgent)
}

// ValidateOverall checks the overall comment's length.
func ValidateOverall(overall string) error {
	if utf8.RuneCountInString(overall) > MaxOverallLength {
		return invalid("overall must not exceed %d characters", MaxOverallLength)
	}
	return nil
}

// Validate checks every invariant of a state. A state that fails it was not
// produced by this package and must not be used.
func (s State) Validate() error {
	if err := ValidateOverall(s.Overall); err != nil {
		return err
	}
	byID := make(map[string]Comment, len(s.Comments))
	for i, c := range s.Comments {
		if err := c.validate(); err != nil {
			return invalid("comments[%d]: %v", i, err)
		}
		if _, dup := byID[c.ID]; dup {
			return invalid("comments[%d]: duplicate comment id %s", i, c.ID)
		}
		byID[c.ID] = c
	}
	for i, c := range s.Comments {
		if c.ParentID == "" {
			continue
		}
		parent, ok := byID[c.ParentID]
		if !ok {
			return invalid("comments[%d]: parent comment not found: %s", i, c.ParentID)
		}
		if parent.ParentID != "" {
			return invalid("comments[%d]: parent %s is itself a reply", i, c.ParentID)
		}
		if c.Resolved {
			return invalid("comments[%d]: only a thread's root can be resolved", i)
		}
		if parent.Path != c.Path || parent.Line != c.Line || parent.EndLine != c.EndLine {
			return invalid("comments[%d]: a reply must have the same location as its parent", i)
		}
	}
	return nil
}

func (c Comment) validate() error {
	if err := ValidateID(c.ID); err != nil {
		return err
	}
	if c.ParentID != "" {
		if err := ValidateID(c.ParentID); err != nil {
			return invalid("parentId: %v", err)
		}
	}
	if _, _, err := (Location{Path: c.Path, Line: c.Line, EndLine: &c.EndLine}).Normalize(); err != nil {
		return err
	}
	if body, err := NormalizeBody(c.Body); err != nil {
		return err
	} else if body != c.Body {
		return invalid("body must not contain leading or trailing whitespace")
	}
	if c.Author == "" || c.Author != strings.TrimSpace(c.Author) || utf8.RuneCountInString(c.Author) > MaxAuthorLength {
		return invalid("author must be non-empty, trimmed, and at most 256 characters")
	}
	if c.Source != SourceHuman && c.Source != SourceAgent {
		return invalid("invalid source %q", c.Source)
	}
	if c.CreatedAt.IsZero() {
		return invalid("createdAt is required")
	}
	return nil
}
