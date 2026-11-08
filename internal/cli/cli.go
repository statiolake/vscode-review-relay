// Package cli implements the agent-facing commands, which talk to the running
// review of a workspace over its loopback HTTP API.
package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/statiolake/vscode-review-relay/internal/session"
)

// Commands are the first arguments that select CLI mode.
var Commands = []string{"health", "comments", "navigate"}

// Usage describes the agent commands.
const Usage = `Agent commands (talk to the running review):
  review-relay [--workspace PATH | --endpoint URL] COMMAND

  The review is found from PATH (default: the current directory): the one
  whose workspace root is the deepest containing it.
  --endpoint or REVIEW_RELAY_ENDPOINT skips discovery.

  health
  comments list [--path PATH] [--unresolved]
  comments add --path PATH --line N [--end-line N] --body TEXT [--author NAME]
  comments reply COMMENT_ID --path PATH --line N [--end-line N] --body TEXT [--author NAME]
  comments resolve COMMENT_ID
  comments unresolve COMMENT_ID
  comments remove COMMENT_ID
  comments clear
  navigate --comment COMMENT_ID
  navigate --path PATH --line N [--end-line N]

  PATH is relative to the workspace root; line numbers are zero-based.`

type client struct {
	endpoint string
	http     *http.Client
	out      io.Writer
}

// Run executes one agent command. args start with the global flags.
func Run(args []string, out io.Writer) error {
	root := flag.NewFlagSet("review-relay", flag.ContinueOnError)
	root.SetOutput(io.Discard)
	endpoint := root.String("endpoint", os.Getenv("REVIEW_RELAY_ENDPOINT"), "")
	workspace := root.String("workspace", "", "")
	if err := root.Parse(args); err != nil {
		return err
	}
	rest := root.Args()
	if len(rest) == 0 {
		return errors.New(Usage)
	}
	resolved := *endpoint
	if resolved == "" {
		dir := *workspace
		if dir == "" {
			var err error
			if dir, err = os.Getwd(); err != nil {
				return err
			}
		}
		var err error
		if resolved, _, err = session.Find(dir); err != nil {
			return err
		}
	}
	c := client{endpoint: strings.TrimRight(resolved, "/"), http: &http.Client{Timeout: 5 * time.Second}, out: out}
	switch rest[0] {
	case "health":
		return c.request(http.MethodGet, "/health", nil)
	case "comments":
		return c.comments(rest[1:])
	case "navigate":
		return c.navigate(rest[1:])
	}
	return fmt.Errorf("unknown command %q\n\n%s", rest[0], Usage)
}

func (c client) comments(args []string) error {
	if len(args) == 0 {
		return errors.New("comments requires list, add, reply, resolve, unresolve, remove, or clear")
	}
	switch args[0] {
	case "list":
		flags := newFlags("comments list")
		p := flags.String("path", "", "")
		unresolved := flags.Bool("unresolved", false, "")
		if err := parse(flags, args[1:]); err != nil {
			return err
		}
		query := url.Values{}
		if *p != "" {
			query.Set("path", *p)
		}
		if *unresolved {
			query.Set("resolved", "false")
		}
		suffix := ""
		if len(query) > 0 {
			suffix = "?" + query.Encode()
		}
		return c.request(http.MethodGet, "/v1/comments"+suffix, nil)
	case "add":
		flags := newFlags("comments add")
		payload := locationFlags(flags, true)
		if err := parse(flags, args[1:]); err != nil {
			return err
		}
		body, err := payload()
		if err != nil {
			return fmt.Errorf("comments add: %w", err)
		}
		return c.request(http.MethodPost, "/v1/comments", body)
	case "reply":
		if len(args) < 2 || strings.HasPrefix(args[1], "-") {
			return errors.New("comments reply requires a comment ID, --path, --line, and --body")
		}
		flags := newFlags("comments reply")
		payload := locationFlags(flags, true)
		if err := parse(flags, args[2:]); err != nil {
			return err
		}
		body, err := payload()
		if err != nil {
			return fmt.Errorf("comments reply: %w", err)
		}
		return c.request(http.MethodPost, "/v1/comments/"+url.PathEscape(args[1])+"/replies", body)
	case "resolve", "unresolve":
		if len(args) != 2 {
			return fmt.Errorf("comments %s requires a comment ID", args[0])
		}
		return c.request(http.MethodPut, "/v1/comments/"+url.PathEscape(args[1])+"/resolved", map[string]any{"resolved": args[0] == "resolve"})
	case "remove":
		if len(args) != 2 {
			return errors.New("comments remove requires a comment ID")
		}
		return c.request(http.MethodDelete, "/v1/comments/"+url.PathEscape(args[1]), nil)
	case "clear":
		if len(args) != 1 {
			return errors.New("comments clear takes no arguments")
		}
		return c.request(http.MethodDelete, "/v1/comments", nil)
	}
	return fmt.Errorf("unknown comments command %q", args[0])
}

func (c client) navigate(args []string) error {
	flags := newFlags("navigate")
	commentID := flags.String("comment", "", "")
	payload := locationFlags(flags, false)
	if err := parse(flags, args); err != nil {
		return err
	}
	if *commentID != "" {
		set := 0
		flags.Visit(func(*flag.Flag) { set++ })
		if set != 1 {
			return errors.New("navigate accepts either --comment or --path and --line")
		}
		return c.request(http.MethodPost, "/v1/navigate", map[string]any{"commentId": *commentID})
	}
	body, err := payload()
	if err != nil {
		return fmt.Errorf("navigate requires --comment or --path and --line: %w", err)
	}
	return c.request(http.MethodPost, "/v1/navigate", body)
}

// locationFlags defines --path/--line/--end-line (and --body/--author when
// withBody) and returns a function building the JSON payload after parsing.
func locationFlags(flags *flag.FlagSet, withBody bool) func() (map[string]any, error) {
	p := flags.String("path", "", "")
	line := flags.Int("line", -1, "")
	endLine := flags.Int("end-line", -1, "")
	var body, author *string
	if withBody {
		body = flags.String("body", "", "")
		author = flags.String("author", "Agent", "")
	}
	return func() (map[string]any, error) {
		if *p == "" || *line < 0 || (withBody && *body == "") {
			if withBody {
				return nil, errors.New("--path, --line, and --body are required")
			}
			return nil, errors.New("--path and --line are required")
		}
		payload := map[string]any{"path": *p, "line": *line}
		if *endLine >= 0 {
			payload["endLine"] = *endLine
		}
		if withBody {
			payload["body"], payload["author"], payload["source"] = *body, *author, "agent"
		}
		return payload, nil
	}
}

func newFlags(name string) *flag.FlagSet {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	return flags
}

func parse(flags *flag.FlagSet, args []string) error {
	if err := flags.Parse(args); err != nil {
		return fmt.Errorf("%s: %w", flags.Name(), err)
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("%s: unexpected argument %q", flags.Name(), flags.Arg(0))
	}
	return nil
}

func (c client) request(method, path string, payload any) error {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, c.endpoint+path, body)
	if err != nil {
		return err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("API returned %s: %s", resp.Status, strings.TrimSpace(string(respBody)))
	}
	_, err = c.out.Write(respBody)
	return err
}
