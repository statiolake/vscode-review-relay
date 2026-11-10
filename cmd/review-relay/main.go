// Command review-relay is Review Relay's core: the review of a workspace
// (comment threads on lines of its files and an overall comment) kept by a
// loopback server, `attach` for the editor frontends, and the agent CLI.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/signal"
	"slices"
	"strings"
	"syscall"

	"github.com/statiolake/vscode-review-relay/internal/attach"
	"github.com/statiolake/vscode-review-relay/internal/cli"
	"github.com/statiolake/vscode-review-relay/internal/host"
)

// version is package.json's (test/manifest.test.ts checks it, and
// .github/workflows/bin-check.yml checks the committed core by it).
var version = "0.5.0"

const usage = `Usage: review-relay COMMAND

Review Relay's core, shipped with the VS Code extension and the Neovim
plugin. A review belongs to a workspace root (the top of the git work tree,
else the directory) and runs while an editor has it open.

Editor frontends:
  ` + attach.Usage + `

  review-relay serve [--workspace PATH]
  Run the review of PATH's workspace (default: the current directory) until
  interrupted, with no editor; prints its endpoint.

  review-relay version
  Print the version.

` + cli.Usage

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "review-relay:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	switch {
	case len(args) == 0 || slices.Contains([]string{"-h", "--help", "help"}, args[0]):
		fmt.Println(usage)
		return nil
	case len(args) == 1 && (args[0] == "version" || args[0] == "--version"):
		fmt.Println(version)
		return nil
	case args[0] == "attach":
		dir, rest, err := workspaceFlag(args[1:])
		if err != nil {
			return err
		}
		var opts attach.Options
		for _, a := range rest {
			if a != "--no-start" {
				return fmt.Errorf("attach: unexpected argument %q\n\n%s", a, attach.Usage)
			}
			opts.NoStart = true
		}
		return attach.Run(dir, opts, os.Stdin, os.Stdout)
	case args[0] == "serve":
		dir, rest, err := workspaceFlag(args[1:])
		if err != nil {
			return err
		}
		if len(rest) > 0 {
			return fmt.Errorf("serve: unexpected argument %q", rest[0])
		}
		return serve(dir)
	case isAgentCommand(args):
		return cli.Run(args, os.Stdout)
	}
	return fmt.Errorf("unknown command %q\n\n%s", args[0], usage)
}

// workspaceFlag takes --workspace PATH out of args; PATH defaults to the
// current directory.
func workspaceFlag(args []string) (dir string, rest []string, err error) {
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--workspace" && i+1 < len(args):
			dir = args[i+1]
			i++
		case strings.HasPrefix(args[i], "--workspace="):
			dir = strings.TrimPrefix(args[i], "--workspace=")
		default:
			rest = append(rest, args[i])
		}
	}
	if dir == "" {
		dir, err = os.Getwd()
	}
	return dir, rest, err
}

// isAgentCommand reports whether args, after the agent's global flags, start
// with an agent command.
func isAgentCommand(args []string) bool {
	for i := 0; i < len(args); i++ {
		a := strings.TrimLeft(args[i], "-")
		switch {
		case !strings.HasPrefix(args[i], "-"):
			return slices.Contains(cli.Commands, args[i])
		case a == "endpoint" || a == "workspace":
			i++ // skip the value
		case strings.HasPrefix(a, "endpoint=") || strings.HasPrefix(a, "workspace="):
		default:
			return false
		}
	}
	return false
}

func serve(dir string) error {
	root, err := host.Root(dir)
	if err != nil {
		return err
	}
	r, err := host.Start(root)
	if err != nil {
		return err
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	fmt.Printf("%s\t%s\n", r.Endpoint, r.Root)
	var fatal error
	select {
	case fatal = <-r.Failed():
	case <-signals:
	}
	return errors.Join(fatal, r.Close())
}
