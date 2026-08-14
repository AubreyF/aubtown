package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const (
	brokerSchemaVersion = 1
	childTimeout        = 90 * time.Second
	maxChildOutput      = 1 * 1024 * 1024
	maxRequestBytes     = 1 * 1024 * 1024
)

var (
	profilePattern   = regexp.MustCompile(`^(?:freed-pilot|conformance-[a-z0-9][a-z0-9-]{2,63})$`)
	digestPattern    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	operationPattern = regexp.MustCompile(`^(?:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`)
	allowedActions   = map[string]bool{
		"claim-acquire":   true,
		"claim-heartbeat": true,
		"claim-transfer":  true,
		"claim-release":   true,
		"claim-show":      true,
		"claim-list":      true,
	}
	readActions = map[string]bool{
		"claim-show": true,
		"claim-list": true,
	}
)

type brokerConfig struct {
	SchemaVersion                  int    `json:"schemaVersion"`
	Profile                        string `json:"profile"`
	FreedRepositoryRoot            string `json:"freedRepositoryRoot"`
	StateRoot                      string `json:"stateRoot"`
	NodeExecutable                 string `json:"nodeExecutable"`
	NodeSHA256                     string `json:"nodeSha256"`
	AutomationActorsEntry          string `json:"automationActorsEntry"`
	AutomationActorsSHA256         string `json:"automationActorsSha256"`
	AutomationControlEntry         string `json:"automationControlEntry"`
	AutomationControlSHA256        string `json:"automationControlSha256"`
	AutomationControlLibrary       string `json:"automationControlLibrary"`
	AutomationControlLibrarySHA256 string `json:"automationControlLibrarySha256"`
	ActorReadinessLibrary          string `json:"actorReadinessLibrary"`
	ActorReadinessLibrarySHA256    string `json:"actorReadinessLibrarySha256"`
	KernelGuardLibrary             string `json:"kernelGuardLibrary"`
	KernelGuardLibrarySHA256       string `json:"kernelGuardLibrarySha256"`
	Actor                          string `json:"actor"`
	LeaseName                      string `json:"leaseName"`
}

type command struct {
	Path string
	Args []string
	Dir  string
	Env  []string
}

type commandResult struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
}

type commandRunner interface {
	Run(context.Context, command) (commandResult, error)
}

type processRunner struct{}

func (processRunner) Run(ctx context.Context, request command) (commandResult, error) {
	cmd := exec.CommandContext(ctx, request.Path, request.Args...)
	cmd.Dir = request.Dir
	cmd.Env = append([]string(nil), request.Env...)
	var stdout boundedBuffer
	var stderr boundedBuffer
	stdout.max = maxChildOutput
	stderr.max = maxChildOutput
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if stdout.exceeded || stderr.exceeded {
		return commandResult{}, errors.New("child command exceeded the output boundary")
	}
	result := commandResult{Stdout: stdout.Bytes(), Stderr: stderr.Bytes()}
	if err == nil {
		return result, nil
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		result.ExitCode = exitError.ExitCode()
		return result, nil
	}
	return commandResult{}, err
}

type boundedBuffer struct {
	bytes.Buffer
	max      int
	exceeded bool
}

func (buffer *boundedBuffer) Write(value []byte) (int, error) {
	originalLength := len(value)
	remaining := buffer.max - buffer.Len()
	if remaining <= 0 {
		buffer.exceeded = true
		return originalLength, nil
	}
	if len(value) > remaining {
		buffer.exceeded = true
		value = value[:remaining]
	}
	_, _ = buffer.Buffer.Write(value)
	return originalLength, nil
}

type leaseHandoff struct {
	SchemaVersion  int    `json:"schemaVersion"`
	Actor          string `json:"actor"`
	LeaseName      string `json:"leaseName"`
	LeaseOperation string `json:"leaseOperationId"`
	LeaseToken     string `json:"leaseToken"`
	LeaseTokenHash string `json:"leaseTokenSha256"`
	AcquiredAt     string `json:"acquiredAt"`
	ExpiresAt      string `json:"expiresAt"`
	TTLMillis      int64  `json:"ttlMs"`
}

type invocation struct {
	Profile string
	Action  string
	Request string
}

func main() {
	invocation, err := parseInvocation(os.Args[1:])
	if err != nil {
		writeBrokerError("invalid_argument", err.Error())
		os.Exit(2)
	}
	configRoot, err := defaultConfigRoot(runtime.GOOS)
	if err != nil {
		writeBrokerError("unsupported_host", err.Error())
		os.Exit(1)
	}
	configFile := filepath.Join(configRoot, invocation.Profile+".json")
	config, err := loadBrokerConfig(configFile, invocation.Profile, 0)
	if err != nil {
		writeBrokerError("invalid_profile", err.Error())
		os.Exit(1)
	}
	if err := verifyBrokerRuntime(config, 0); err != nil {
		writeBrokerError("runtime_not_trusted", err.Error())
		os.Exit(1)
	}
	result, err := executeBroker(context.Background(), processRunner{}, config, invocation)
	if err != nil {
		writeBrokerError("broker_internal", err.Error())
		os.Exit(1)
	}
	if result.ExitCode != 0 {
		if len(result.Stderr) == 0 {
			writeBrokerError("freed_command_failed", "Freed rejected the coordinator operation without structured error output.")
		} else {
			_, _ = os.Stderr.Write(result.Stderr)
		}
		os.Exit(1)
	}
	_, _ = os.Stdout.Write(result.Stdout)
}

func parseInvocation(args []string) (invocation, error) {
	var value invocation
	switch {
	case len(args) == 4 && args[0] == "task" && args[2] == "--request-json":
		value = invocation{Profile: "freed-pilot", Action: args[1], Request: args[3]}
	case len(args) == 6 && args[0] == "--profile" && args[2] == "task" && args[4] == "--request-json":
		value = invocation{Profile: args[1], Action: args[3], Request: args[5]}
	default:
		return invocation{}, errors.New("usage: factory-coordinator --profile <profile> task <claim-operation> --request-json <json>")
	}
	if !profilePattern.MatchString(value.Profile) {
		return invocation{}, errors.New("profile is outside the Freed pilot allowlist")
	}
	if !allowedActions[value.Action] {
		return invocation{}, errors.New("claim operation is not allowed")
	}
	if len(value.Request) < 2 || len(value.Request) > maxRequestBytes {
		return invocation{}, errors.New("request JSON exceeds the broker boundary")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal([]byte(value.Request), &object); err != nil || object == nil {
		return invocation{}, errors.New("request must be one JSON object")
	}
	return value, nil
}

func defaultConfigRoot(goos string) (string, error) {
	switch goos {
	case "darwin":
		return "/Library/Application Support/AubTown/freed-broker-profiles", nil
	case "linux":
		return "/etc/aubtown/freed-broker-profiles", nil
	default:
		return "", fmt.Errorf("factory coordinator is unavailable on %s", goos)
	}
}

func loadBrokerConfig(file, profile string, requiredUID int) (brokerConfig, error) {
	bytes, err := readProtectedFile(file, 64*1024, requiredUID, false)
	if err != nil {
		return brokerConfig{}, fmt.Errorf("broker profile is not protected: %w", err)
	}
	decoder := json.NewDecoder(bytesReader(bytes))
	decoder.DisallowUnknownFields()
	var config brokerConfig
	if err := decoder.Decode(&config); err != nil {
		return brokerConfig{}, fmt.Errorf("broker profile is invalid: %w", err)
	}
	if err := requireJSONEnd(decoder); err != nil {
		return brokerConfig{}, err
	}
	if err := validateBrokerConfig(config, profile); err != nil {
		return brokerConfig{}, err
	}
	return config, nil
}

func validateBrokerConfig(config brokerConfig, profile string) error {
	if config.SchemaVersion != brokerSchemaVersion || config.Profile != profile || !profilePattern.MatchString(config.Profile) {
		return errors.New("broker profile identity is invalid")
	}
	if config.Actor != "freed-nightly-runner" || config.LeaseName != "nightly-writer" {
		return errors.New("broker profile does not use the reviewed Freed coordinator authority")
	}
	paths := []string{
		config.FreedRepositoryRoot,
		config.StateRoot,
		config.NodeExecutable,
		config.AutomationActorsEntry,
		config.AutomationControlEntry,
		config.AutomationControlLibrary,
		config.ActorReadinessLibrary,
		config.KernelGuardLibrary,
	}
	for _, value := range paths {
		if !filepath.IsAbs(value) || filepath.Clean(value) != value {
			return errors.New("broker profile paths must be canonical and absolute")
		}
	}
	digests := []string{
		config.NodeSHA256,
		config.AutomationActorsSHA256,
		config.AutomationControlSHA256,
		config.AutomationControlLibrarySHA256,
		config.ActorReadinessLibrarySHA256,
		config.KernelGuardLibrarySHA256,
	}
	for _, digest := range digests {
		if !digestPattern.MatchString(digest) {
			return errors.New("broker profile digests must be lowercase SHA-256 values")
		}
	}
	return nil
}

func verifyBrokerRuntime(config brokerConfig, requiredUID int) error {
	artifacts := []struct {
		path       string
		digest     string
		executable bool
	}{
		{config.NodeExecutable, config.NodeSHA256, true},
		{config.AutomationActorsEntry, config.AutomationActorsSHA256, false},
		{config.AutomationControlEntry, config.AutomationControlSHA256, false},
		{config.AutomationControlLibrary, config.AutomationControlLibrarySHA256, false},
		{config.ActorReadinessLibrary, config.ActorReadinessLibrarySHA256, false},
		{config.KernelGuardLibrary, config.KernelGuardLibrarySHA256, false},
	}
	for _, artifact := range artifacts {
		content, err := readProtectedFile(artifact.path, 16*1024*1024, requiredUID, artifact.executable)
		if err != nil {
			return fmt.Errorf("runtime artifact %s is unsafe: %w", filepath.Base(artifact.path), err)
		}
		digest := sha256.Sum256(content)
		if hex.EncodeToString(digest[:]) != artifact.digest {
			return fmt.Errorf("runtime artifact %s changed", filepath.Base(artifact.path))
		}
	}
	if err := requirePhysicalDirectory(config.FreedRepositoryRoot); err != nil {
		return fmt.Errorf("Freed repository root is unsafe: %w", err)
	}
	if err := requirePhysicalDirectory(config.StateRoot); err != nil {
		return fmt.Errorf("Freed state root is unsafe: %w", err)
	}
	return nil
}

func executeBroker(ctx context.Context, runner commandRunner, config brokerConfig, invocation invocation) (commandResult, error) {
	if readActions[invocation.Action] {
		return runFreedTaskCommand(ctx, runner, config, invocation, ""), nil
	}
	acquireContext, cancelAcquire := context.WithTimeout(ctx, childTimeout)
	acquired, err := runner.Run(acquireContext, command{
		Path: config.NodeExecutable,
		Args: []string{
			config.AutomationActorsEntry,
			"acquire",
			"--actor", config.Actor,
			"--state-root", config.StateRoot,
		},
		Dir: config.FreedRepositoryRoot,
		Env: []string{},
	})
	cancelAcquire()
	if err != nil {
		return commandResult{}, fmt.Errorf("trusted launcher failed: %w", err)
	}
	if acquired.ExitCode != 0 {
		return commandResult{Stderr: acquired.Stderr, ExitCode: 1}, nil
	}
	handoff, err := parseLeaseHandoff(acquired.Stdout, config)
	if err != nil {
		return commandResult{}, err
	}
	operation := runFreedTaskCommand(ctx, runner, config, invocation, handoff.LeaseToken)
	release := releaseCoordinatorLease(ctx, runner, config, handoff.LeaseToken)
	if release != nil {
		return commandResult{}, release
	}
	return operation, nil
}

func runFreedTaskCommand(ctx context.Context, runner commandRunner, config brokerConfig, invocation invocation, leaseToken string) commandResult {
	args := []string{
		config.AutomationControlEntry,
		"task", invocation.Action,
		"--state-root", config.StateRoot,
		"--request-json", invocation.Request,
	}
	environment := []string{}
	if leaseToken != "" {
		args = append(args, "--actor", config.Actor, "--lease-name", config.LeaseName)
		environment = []string{"FREED_AUTOMATION_LEASE_TOKEN=" + leaseToken}
	}
	commandContext, cancel := context.WithTimeout(ctx, childTimeout)
	defer cancel()
	result, err := runner.Run(commandContext, command{
		Path: config.NodeExecutable,
		Args: args,
		Dir:  config.FreedRepositoryRoot,
		Env:  environment,
	})
	if err != nil {
		return commandResult{Stderr: []byte(fmt.Sprintf("broker child failed: %s", err)), ExitCode: 1}
	}
	return result
}

func releaseCoordinatorLease(ctx context.Context, runner commandRunner, config brokerConfig, token string) error {
	operationID, err := randomUUID()
	if err != nil {
		return err
	}
	for attempt := 0; attempt < 2; attempt++ {
		releaseContext, cancel := context.WithTimeout(ctx, childTimeout)
		result, runErr := runner.Run(releaseContext, command{
			Path: config.NodeExecutable,
			Args: []string{
				config.AutomationControlEntry,
				"lease", "release",
				"--state-root", config.StateRoot,
				"--name", config.LeaseName,
			},
			Dir: config.FreedRepositoryRoot,
			Env: []string{
				"FREED_AUTOMATION_LEASE_OPERATION_ID=" + operationID,
				"FREED_AUTOMATION_LEASE_TOKEN=" + token,
			},
		})
		cancel()
		if runErr == nil && result.ExitCode == 0 && validReleaseReceipt(result.Stdout, config.LeaseName) {
			return nil
		}
	}
	return errors.New("coordinator lease release failed after exact bounded retries")
}

func parseLeaseHandoff(value []byte, config brokerConfig) (leaseHandoff, error) {
	decoder := json.NewDecoder(bytesReader(value))
	decoder.DisallowUnknownFields()
	var handoff leaseHandoff
	if err := decoder.Decode(&handoff); err != nil {
		return leaseHandoff{}, errors.New("trusted launcher returned an invalid handoff")
	}
	if err := requireJSONEnd(decoder); err != nil {
		return leaseHandoff{}, errors.New("trusted launcher returned trailing data")
	}
	acquiredAt, acquiredErr := time.Parse(time.RFC3339Nano, handoff.AcquiredAt)
	expiresAt, expiresErr := time.Parse(time.RFC3339Nano, handoff.ExpiresAt)
	tokenDigest := sha256.Sum256([]byte(handoff.LeaseToken))
	if handoff.SchemaVersion != 1 || handoff.Actor != config.Actor || handoff.LeaseName != config.LeaseName ||
		!operationPattern.MatchString(handoff.LeaseOperation) ||
		len(handoff.LeaseToken) < 32 || len(handoff.LeaseToken) > 4096 ||
		hex.EncodeToString(tokenDigest[:]) != handoff.LeaseTokenHash ||
		acquiredErr != nil || expiresErr != nil || !expiresAt.After(acquiredAt) ||
		handoff.TTLMillis != int64(30*time.Minute/time.Millisecond) ||
		expiresAt.Sub(acquiredAt) != time.Duration(handoff.TTLMillis)*time.Millisecond {
		return leaseHandoff{}, errors.New("trusted launcher handoff does not match coordinator authority")
	}
	return handoff, nil
}

func validReleaseReceipt(value []byte, leaseName string) bool {
	var receipt struct {
		OK            bool   `json:"ok"`
		SchemaVersion int    `json:"schemaVersion"`
		Action        string `json:"action"`
		Result        struct {
			Released bool `json:"released"`
			Lease    struct {
				Name string `json:"name"`
			} `json:"lease"`
		} `json:"result"`
	}
	if json.Unmarshal(value, &receipt) != nil {
		return false
	}
	return receipt.OK && receipt.SchemaVersion == 1 && receipt.Action == "lease.release" && receipt.Result.Released && receipt.Result.Lease.Name == leaseName
}

func randomUUID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}

func readProtectedFile(file string, maxBytes int64, requiredUID int, executable bool) ([]byte, error) {
	if !filepath.IsAbs(file) || filepath.Clean(file) != file {
		return nil, errors.New("path is not canonical and absolute")
	}
	real, err := filepath.EvalSymlinks(file)
	if err != nil || real != file {
		return nil, errors.New("path contains a symbolic link")
	}
	info, err := os.Lstat(file)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 || info.Size() > maxBytes || info.Mode().Perm()&0o022 != 0 {
		return nil, errors.New("file type, size, or mode is unsafe")
	}
	if executable && info.Mode().Perm()&0o100 == 0 {
		return nil, errors.New("executable is not owner-executable")
	}
	if requiredUID >= 0 {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || int(stat.Uid) != requiredUID {
			return nil, errors.New("file owner is not trusted")
		}
	}
	return os.ReadFile(file)
}

func requirePhysicalDirectory(directory string) error {
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
		return errors.New("directory is not canonical and absolute")
	}
	real, err := filepath.EvalSymlinks(directory)
	if err != nil || real != directory {
		return errors.New("directory contains a symbolic link")
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("path is not a physical directory")
	}
	return nil
}

func requireJSONEnd(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("JSON document contains trailing data")
	}
	return nil
}

func bytesReader(value []byte) *bytes.Reader {
	return bytes.NewReader(value)
}

func writeBrokerError(code, message string) {
	message = strings.TrimSpace(message)
	if message == "" {
		message = "factory coordinator failed closed"
	}
	_ = json.NewEncoder(os.Stderr).Encode(map[string]any{
		"schemaVersion": 1,
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}
