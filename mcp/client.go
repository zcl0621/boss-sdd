package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"time"
)

const (
	appPath = "/Applications/BossSDD.app"
	// Must match BoardKit.defaultBoardPort.
	defaultPort = 18888
)

// board talks to the Plan SDD app's loopback API. The app owns the store and all
// the scheduling invariants; this process only translates MCP calls into requests.
type board struct {
	base   string
	client *http.Client
}

func newBoard() *board {
	port := defaultPort
	if raw := os.Getenv("BOSS_SDD_PORT"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			port = parsed
		}
	}
	return &board{
		base:   fmt.Sprintf("http://127.0.0.1:%d", port),
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

type apiError struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// call sends one request, launching the board app and retrying if nothing is listening.
func (b *board) call(ctx context.Context, method, path string, body, out any) error {
	if err := b.send(ctx, method, path, body, out); err == nil || !isRefused(err) {
		return err
	}
	if err := launchApp(); err != nil {
		return fmt.Errorf("看板未运行，且无法启动 %s：%w", appPath, err)
	}
	deadline := time.Now().Add(12 * time.Second)
	for {
		time.Sleep(400 * time.Millisecond)
		err := b.send(ctx, method, path, body, out)
		if err == nil || !isRefused(err) {
			return err
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("看板已启动但 %s 仍无响应：%w", b.base, err)
		}
	}
}

func (b *board) send(ctx context.Context, method, path string, body, out any) error {
	var reader *bytes.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	} else {
		reader = bytes.NewReader(nil)
	}
	request, err := http.NewRequestWithContext(ctx, method, b.base+path, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := b.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	decoder := json.NewDecoder(response.Body)
	if response.StatusCode >= 400 {
		var failure apiError
		if decoder.Decode(&failure) == nil && failure.Error.Message != "" {
			return fmt.Errorf("%s", failure.Error.Message)
		}
		return fmt.Errorf("看板返回 HTTP %d", response.StatusCode)
	}
	if out == nil {
		return nil
	}
	return decoder.Decode(out)
}

func isRefused(err error) bool {
	var opError *net.OpError
	if errors.As(err, &opError) {
		return true
	}
	var syscallError *net.OpError
	return errors.As(err, &syscallError)
}

func launchApp() error {
	if _, err := os.Stat(appPath); err != nil {
		return err
	}
	return exec.Command("/usr/bin/open", "-g", "-a", appPath).Run()
}
