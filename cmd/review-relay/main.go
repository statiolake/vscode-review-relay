package main

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
)

const defaultEndpoint = "http://127.0.0.1:47658"

type client struct {
	endpoint string
	http     *http.Client
	out      io.Writer
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "review-relay:", err)
		os.Exit(1)
	}
}

func run(args []string, out io.Writer) error {
	root := flag.NewFlagSet("review-relay", flag.ContinueOnError)
	root.SetOutput(io.Discard)
	endpoint := root.String("endpoint", envOrDefault("REVIEW_RELAY_ENDPOINT", defaultEndpoint), "Review Relay API endpoint")
	if err := root.Parse(args); errors.Is(err, flag.ErrHelp) {
		fmt.Fprintln(out, usage())
		return nil
	} else if err != nil {
		return err
	}
	remaining := root.Args()
	if len(remaining) == 0 {
		return errors.New(usage())
	}
	c := client{endpoint: strings.TrimRight(*endpoint, "/"), http: &http.Client{Timeout: 5 * time.Second}, out: out}

	switch remaining[0] {
	case "health":
		return c.request(http.MethodGet, "/health", nil)
	case "comments":
		return runComments(c, remaining[1:])
	case "navigate":
		return runNavigate(c, remaining[1:])
	case "help", "--help", "-h":
		fmt.Fprintln(out, usage())
		return nil
	default:
		return fmt.Errorf("unknown command %q\n\n%s", remaining[0], usage())
	}
}

func runComments(c client, args []string) error {
	if len(args) == 0 {
		return errors.New("comments requires list, add, remove, or clear")
	}
	switch args[0] {
	case "list":
		flags := flag.NewFlagSet("comments list", flag.ContinueOnError)
		uri := flags.String("uri", "", "exact VS Code document URI")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		path := "/v1/comments"
		if *uri != "" {
			path += "?uri=" + url.QueryEscape(*uri)
		}
		return c.request(http.MethodGet, path, nil)
	case "add":
		flags := flag.NewFlagSet("comments add", flag.ContinueOnError)
		uri := flags.String("uri", "", "VS Code document URI")
		line := flags.Int("line", -1, "zero-based start line")
		endLine := flags.Int("end-line", -1, "zero-based inclusive end line")
		body := flags.String("body", "", "comment body")
		author := flags.String("author", "Agent", "comment author")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if *uri == "" || *line < 0 || *body == "" {
			return errors.New("comments add requires --uri, --line, and --body")
		}
		payload := map[string]any{"uri": *uri, "line": *line, "body": *body, "author": *author, "source": "agent"}
		if *endLine >= 0 {
			payload["endLine"] = *endLine
		}
		return c.request(http.MethodPost, "/v1/comments", payload)
	case "remove":
		if len(args) != 2 {
			return errors.New("comments remove requires a comment ID")
		}
		return c.request(http.MethodDelete, "/v1/comments/"+url.PathEscape(args[1]), nil)
	case "clear":
		return c.request(http.MethodDelete, "/v1/comments", nil)
	default:
		return fmt.Errorf("unknown comments command %q", args[0])
	}
}

func runNavigate(c client, args []string) error {
	flags := flag.NewFlagSet("navigate", flag.ContinueOnError)
	commentID := flags.String("comment", "", "comment ID")
	uri := flags.String("uri", "", "VS Code document URI")
	line := flags.Int("line", -1, "zero-based start line")
	endLine := flags.Int("end-line", -1, "zero-based inclusive end line")
	if err := flags.Parse(args); err != nil {
		return err
	}
	var payload map[string]any
	if *commentID != "" {
		if *uri != "" || *line >= 0 || *endLine >= 0 {
			return errors.New("navigate accepts either --comment or --uri and --line")
		}
		payload = map[string]any{"commentId": *commentID}
	} else {
		if *uri == "" || *line < 0 {
			return errors.New("navigate requires --comment or both --uri and --line")
		}
		payload = map[string]any{"uri": *uri, "line": *line}
		if *endLine >= 0 {
			payload["endLine"] = *endLine
		}
	}
	return c.request(http.MethodPost, "/v1/navigate", payload)
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
	request, err := http.NewRequest(method, c.endpoint+path, body)
	if err != nil {
		return err
	}
	if payload != nil {
		request.Header.Set("content-type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("API returned %s: %s", response.Status, strings.TrimSpace(string(responseBody)))
	}
	_, err = c.out.Write(responseBody)
	return err
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func usage() string {
	return `Usage: review-relay [--endpoint URL] COMMAND

Commands:
  health
  comments list [--uri URI]
  comments add --uri URI --line N [--end-line N] --body TEXT [--author NAME]
  comments remove COMMENT_ID
  comments clear
  navigate --comment COMMENT_ID
  navigate --uri URI --line N [--end-line N]`
}
