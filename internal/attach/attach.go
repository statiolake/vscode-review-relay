// Package attach is how an editor frontend (the VS Code extension, the
// Neovim plugin) talks to a review: `review-relay attach`, a child process
// that speaks JSON lines on its stdin and stdout.
//
// The review is a server (internal/server), one per workspace root, found
// through its descriptor (internal/session). attach connects to the one
// running for the workspace, or, when there is none, runs one in this
// process (internal/host) for as long as it is attached. It then carries the
// server's HTTP API and its event stream over the pipe, so a frontend needs
// no HTTP client, no discovery and no lifecycle of its own:
//
//	stdin   {"id":1,"method":"GET","path":"/v1/comments"}
//	        {"id":2,"method":"POST","path":"/v1/comments","body":{...}}
//	stdout  {"type":"attached","endpoint":"http://127.0.0.1:…","root":"/repo","owner":true,"session":{"root":"/repo"}}
//	        {"type":"response","id":1,"status":200,"body":{...}}
//	        {"type":"event","name":"state","data":{}}
//	        {"type":"event","name":"navigate","data":{"path":…,"line":…}}
//	        {"type":"error","message":"…"}          (then it exits)
//
// When the server goes away (the editor that ran it quit), attach connects
// again, to another server or to one it starts, and says so with a new
// "attached" and a "state" event: the frontend reads the review again and
// carries on. Closing stdin (or SIGINT/SIGTERM) detaches; a server this
// process ran stops then, its review already on disk.
package attach

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/statiolake/vscode-review-relay/internal/host"
	"github.com/statiolake/vscode-review-relay/internal/session"
)

// Request is one line of stdin: an HTTP request to the review's API.
type Request struct {
	ID     int64           `json:"id"`
	Method string          `json:"method"`
	Path   string          `json:"path"`
	Body   json.RawMessage `json:"body,omitempty"`
}

// Message is one line of stdout.
type Message struct {
	Type string `json:"type"` // attached | response | event | error

	// attached
	Endpoint string          `json:"endpoint,omitempty"`
	Root     string          `json:"root,omitempty"`
	Owner    bool            `json:"owner,omitempty"`
	Session  json.RawMessage `json:"session,omitempty"`

	// response
	ID     int64           `json:"id,omitempty"`
	Status int             `json:"status,omitempty"`
	Body   json.RawMessage `json:"body,omitempty"`

	// event
	Name string          `json:"name,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`

	// error
	Message string `json:"message,omitempty"`
}

// Usage describes the command.
const Usage = `review-relay attach [--workspace PATH] [--no-start]
  For editor frontends: JSON lines on stdin/stdout carrying the API of the
  review of PATH's workspace (default: the current directory), run in this
  process while attached when none runs.
  --no-start only uses a review already running, and ends with it.`

// Options are attach's flags.
type Options struct {
	// NoStart only uses a review already running: none is an error, and
	// so is its going away.
	NoStart bool
}

// Run attaches to the review of dir until in ends or a signal arrives.
func Run(dir string, opts Options, in io.Reader, out io.Writer) error {
	a := &attacher{noStart: opts.NoStart, enc: json.NewEncoder(out), api: &http.Client{Timeout: 30 * time.Second}}
	defer a.detach()
	root, err := host.Root(dir)
	if err == nil {
		a.root = root
		err = a.connect()
	}
	if err != nil {
		a.write(Message{Type: "error", Message: err.Error()})
		return err
	}

	requests := make(chan Request)
	ended := make(chan error, 1)
	go func() { ended <- read(in, requests) }()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)

	for {
		select {
		case req := <-requests:
			go a.forward(req)
		case err := <-ended:
			return err
		case <-signals:
			return nil
		case <-a.lostCh():
			if err := a.reconnect(); err != nil {
				a.write(Message{Type: "error", Message: err.Error()})
				return err
			}
		}
	}
}

func read(in io.Reader, requests chan<- Request) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64*1024), 4<<20)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var req Request
		if err := json.Unmarshal(line, &req); err != nil {
			return fmt.Errorf("attach: a request is not JSON: %w", err)
		}
		requests <- req
	}
	return scanner.Err()
}

type attacher struct {
	root    string
	noStart bool
	api     *http.Client

	wmu sync.Mutex
	enc *json.Encoder

	mu       sync.Mutex
	endpoint string
	own      *host.Review  // the review this process runs, if it does
	lost     chan struct{} // closed when the current connection is gone
	stream   io.Closer
}

func (a *attacher) write(m Message) {
	a.wmu.Lock()
	defer a.wmu.Unlock()
	a.enc.Encode(m) // a broken stdout ends us through stdin soon enough
}

func (a *attacher) lostCh() <-chan struct{} {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.lost
}

// connect finds the review's server or starts one, follows its events and
// announces it.
func (a *attacher) connect() error {
	endpoint, err := session.Lookup(a.root)
	var own *host.Review
	if err != nil && a.noStart {
		return err
	}
	if err != nil {
		own, err = host.Start(a.root)
		switch {
		case errors.Is(err, session.ErrRunning):
			// Another frontend started it a moment ago.
			if endpoint, err = session.Lookup(a.root); err != nil {
				return err
			}
		case err != nil:
			return err
		default:
			endpoint = own.Endpoint
		}
	}
	lost := make(chan struct{})
	stream, err := a.follow(endpoint, lost)
	if err != nil {
		if own != nil {
			own.Close()
		}
		return err
	}
	a.mu.Lock()
	a.endpoint, a.own, a.lost, a.stream = endpoint, own, lost, stream
	a.mu.Unlock()
	if own != nil {
		go func() {
			if err, failed := <-own.Failed(); failed {
				fmt.Fprintln(os.Stderr, "review-relay attach:", err)
				stream.Close() // ends the stream, which reports the loss
			}
		}()
	}

	sessionBody, _, err := a.call(http.MethodGet, "/v1/session", nil)
	if err != nil {
		return err
	}
	a.write(Message{Type: "attached", Endpoint: endpoint, Root: a.root, Owner: own != nil, Session: sessionBody})
	return nil
}

// reconnect replaces a connection that is gone.
func (a *attacher) reconnect() error {
	a.detach()
	var err error
	tries := 25
	if a.noStart {
		tries = 3 // the next review may be coming up; none is not ours to start
	}
	for try := 0; try < tries; try++ {
		// Spread out the frontends that lost the same server, so one
		// starts the next and the others find it.
		time.Sleep(time.Duration(100+rand.IntN(300)) * time.Millisecond)
		if err = a.connect(); err == nil {
			a.write(Message{Type: "event", Name: "state", Data: json.RawMessage("{}")})
			return nil
		}
	}
	return fmt.Errorf("the review went away and could not be reached again: %w", err)
}

// detach drops the connection and stops the review this process ran.
func (a *attacher) detach() {
	a.mu.Lock()
	own, stream := a.own, a.stream
	a.own, a.stream, a.endpoint = nil, nil, ""
	a.mu.Unlock()
	if stream != nil {
		stream.Close()
	}
	if own != nil {
		own.Close()
	}
}

// follow opens the server's event stream and relays it; lost is closed when
// the stream ends.
func (a *attacher) follow(endpoint string, lost chan struct{}) (io.Closer, error) {
	resp, err := http.Get(endpoint + "/v1/events")
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("the review's event stream answered %s", resp.Status)
	}
	go func() {
		defer close(lost)
		defer resp.Body.Close()
		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 64*1024), 4<<20)
		var name string
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: ") && name != "":
				a.write(Message{Type: "event", Name: name, Data: json.RawMessage(strings.TrimPrefix(line, "data: "))})
				name = ""
			}
		}
	}()
	return resp.Body, nil
}

func (a *attacher) call(method, path string, body json.RawMessage) (json.RawMessage, int, error) {
	a.mu.Lock()
	endpoint := a.endpoint
	a.mu.Unlock()
	if endpoint == "" {
		return nil, 0, errors.New("not connected to the review (it is being reached again)")
	}
	if !strings.HasPrefix(path, "/") {
		return nil, 0, fmt.Errorf("path %q must start with /", path)
	}
	var reader io.Reader
	if len(body) > 0 {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, endpoint+path, reader)
	if err != nil {
		return nil, 0, err
	}
	if reader != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.api.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, 0, err
	}
	data = bytes.TrimSpace(data)
	if !json.Valid(data) {
		data, _ = json.Marshal(map[string]string{"error": string(data)})
	}
	return data, resp.StatusCode, nil
}

// forward answers one request; a request that cannot reach the server is
// answered 503, and the lost connection is reported (and replaced) apart.
func (a *attacher) forward(req Request) {
	body, status, err := a.call(req.Method, req.Path, req.Body)
	if err != nil {
		body, _ = json.Marshal(map[string]string{"error": err.Error()})
		status = http.StatusServiceUnavailable
	}
	a.write(Message{Type: "response", ID: req.ID, Status: status, Body: body})
}
