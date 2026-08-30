package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type queuedRunner struct {
	testing  *testing.T
	results  []commandResult
	errors   []error
	commands []command
	timeouts []time.Duration
}

func (runner *queuedRunner) Run(ctx context.Context, request command) (commandResult, error) {
	runner.testing.Helper()
	runner.commands = append(runner.commands, request)
	deadline, ok := ctx.Deadline()
	if !ok {
		runner.testing.Fatal("child command has no bounded deadline")
	}
	runner.timeouts = append(runner.timeouts, time.Until(deadline))
	if len(runner.results) == 0 {
		runner.testing.Fatal("unexpected child command")
	}
	result := runner.results[0]
	runner.results = runner.results[1:]
	var err error
	if len(runner.errors) > 0 {
		err = runner.errors[0]
		runner.errors = runner.errors[1:]
	}
	return result, err
}

func testConfig() brokerConfig {
	return brokerConfig{
		SchemaVersion:                  1,
		Profile:                        "freed-pilot",
		FreedRepositoryRoot:            "/srv/freed",
		StateRoot:                      "/var/lib/freed/automation",
		NodeExecutable:                 "/opt/freed/node",
		NodeSHA256:                     strings.Repeat("a", 64),
		AutomationActorsEntry:          "/srv/freed/scripts/automation-actors.mjs",
		AutomationActorsSHA256:         strings.Repeat("b", 64),
		AutomationControlEntry:         "/srv/freed/scripts/automation-control.mjs",
		AutomationControlSHA256:        strings.Repeat("c", 64),
		AutomationControlLibrary:       "/srv/freed/scripts/lib/automation-control.mjs",
		AutomationControlLibrarySHA256: strings.Repeat("d", 64),
		ActorReadinessLibrary:          "/srv/freed/scripts/lib/automation-actor-readiness.mjs",
		ActorReadinessLibrarySHA256:    strings.Repeat("e", 64),
		KernelGuardLibrary:             "/srv/freed/scripts/lib/automation-kernel-guard-cutover.mjs",
		KernelGuardLibrarySHA256:       strings.Repeat("f", 64),
		Actor:                          "freed-nightly-runner",
		LeaseName:                      "nightly-writer",
	}
}

func handoffBytes(token string) []byte {
	digest := sha256.Sum256([]byte(token))
	value := leaseHandoff{
		SchemaVersion:  1,
		Actor:          "freed-nightly-runner",
		LeaseName:      "nightly-writer",
		LeaseOperation: "91503c1a-c5fa-4e18-a692-9016073b7ea7",
		LeaseToken:     token,
		LeaseTokenHash: hex.EncodeToString(digest[:]),
		AcquiredAt:     "2026-08-14T10:00:00.000Z",
		ExpiresAt:      "2026-08-14T10:30:00.000Z",
		TTLMillis:      30 * 60_000,
	}
	encoded, _ := json.Marshal(value)
	return encoded
}

func releaseBytes() []byte {
	return []byte(`{"ok":true,"schemaVersion":1,"action":"lease.release","result":{"released":true,"lease":{"name":"nightly-writer"}}}`)
}

func TestParseInvocationAcceptsOnlyClaimProtocol(t *testing.T) {
	parsed, err := parseInvocation([]string{
		"--profile", "freed-pilot", "task", "claim-acquire", "--request-json", `{"schemaVersion":1}`,
	})
	if err != nil || parsed.Action != "claim-acquire" {
		t.Fatalf("expected exact claim invocation, got %#v, %v", parsed, err)
	}
	defaultProfile, err := parseInvocation([]string{
		"task", "claim-list", "--request-json", `{"schemaVersion":1}`,
	})
	if err != nil || defaultProfile.Profile != "freed-pilot" {
		t.Fatalf("expected the one production profile, got %#v, %v", defaultProfile, err)
	}
	for _, args := range [][]string{
		{"--profile", "other", "task", "claim-acquire", "--request-json", `{}`},
		{"--profile", "freed-pilot", "task", "transition", "--request-json", `{}`},
		{"--profile", "freed-pilot", "task", "claim-list", "--request-json", `[]`},
	} {
		if _, err := parseInvocation(args); err == nil {
			t.Fatalf("expected invocation rejection for %#v", args)
		}
	}
}

func TestReadOperationUsesNoLeaseOrCredential(t *testing.T) {
	runner := &queuedRunner{
		testing: t,
		results: []commandResult{{Stdout: []byte(`{"action":"task.claim-list","result":{"schemaVersion":1,"claims":[]}}`)}},
	}
	invocation := invocation{Profile: "freed-pilot", Action: "claim-list", Request: `{"schemaVersion":1}`}
	result, err := executeBroker(context.Background(), runner, testConfig(), invocation)
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("read operation failed: %#v, %v", result, err)
	}
	if len(runner.commands) != 1 || len(runner.commands[0].Env) != 0 {
		t.Fatalf("read operation acquired authority: %#v", runner.commands)
	}
	joined := strings.Join(runner.commands[0].Args, " ")
	if strings.Contains(joined, "--actor") || strings.Contains(joined, "--lease-name") {
		t.Fatalf("read operation received mutation identity: %s", joined)
	}
}

func TestMutationKeepsLeaseTokenOutOfArgumentsAndOutput(t *testing.T) {
	token := "test-lease-token-test-lease-token-00"
	operationOutput := []byte(`{"action":"task.claim-acquire","result":{"schemaVersion":1}}`)
	runner := &queuedRunner{
		testing: t,
		results: []commandResult{
			{Stdout: handoffBytes(token)},
			{Stdout: operationOutput},
			{Stdout: releaseBytes()},
		},
	}
	invocation := invocation{Profile: "freed-pilot", Action: "claim-acquire", Request: `{"schemaVersion":1}`}
	result, err := executeBroker(context.Background(), runner, testConfig(), invocation)
	if err != nil || result.ExitCode != 0 || string(result.Stdout) != string(operationOutput) {
		t.Fatalf("mutation failed: %#v, %v", result, err)
	}
	if len(runner.commands) != 3 {
		t.Fatalf("expected acquire, mutation, release, got %d calls", len(runner.commands))
	}
	if runner.timeouts[0] < 379*time.Second {
		t.Fatalf("trusted launcher received only %s, below its 370 second lifecycle contract", runner.timeouts[0])
	}
	if runner.timeouts[1] < 179*time.Second || runner.timeouts[1] > controlCommandTimeout {
		t.Fatalf("mutation received unexpected timeout %s", runner.timeouts[1])
	}
	if runner.timeouts[2] < 89*time.Second || runner.timeouts[2] > leaseReleaseTimeout {
		t.Fatalf("lease release received unexpected timeout %s", runner.timeouts[2])
	}
	for _, request := range runner.commands {
		if strings.Contains(strings.Join(request.Args, "\n"), token) {
			t.Fatal("lease token entered child arguments")
		}
	}
	if len(runner.commands[0].Env) != 0 {
		t.Fatal("trusted launcher inherited an environment")
	}
	if strings.Join(runner.commands[1].Env, "\n") != "FREED_AUTOMATION_LEASE_TOKEN="+token {
		t.Fatalf("mutation did not receive only the lease token: %#v", runner.commands[1].Env)
	}
	releaseEnv := strings.Join(runner.commands[2].Env, "\n")
	if !strings.Contains(releaseEnv, "FREED_AUTOMATION_LEASE_OPERATION_ID=") || !strings.Contains(releaseEnv, "FREED_AUTOMATION_LEASE_TOKEN="+token) {
		t.Fatalf("release lacks exact authority environment: %q", releaseEnv)
	}
	if strings.Contains(string(result.Stdout), token) || strings.Contains(string(result.Stderr), token) {
		t.Fatal("broker returned the coordinator lease token")
	}
}

func TestRejectedMutationStillReleasesLease(t *testing.T) {
	token := "test-lease-token-test-lease-token-00"
	runner := &queuedRunner{
		testing: t,
		results: []commandResult{
			{Stdout: handoffBytes(token)},
			{Stderr: []byte(`{"schemaVersion":1,"error":{"code":"claim_already_exists"}}`), ExitCode: 1},
			{Stdout: releaseBytes()},
		},
	}
	result, err := executeBroker(context.Background(), runner, testConfig(), invocation{
		Profile: "freed-pilot", Action: "claim-acquire", Request: `{"schemaVersion":1}`,
	})
	if err != nil || result.ExitCode != 1 || len(runner.commands) != 3 {
		t.Fatalf("rejected mutation did not preserve error and cleanup: %#v, %v", result, err)
	}
	if !strings.Contains(string(result.Stderr), "claim_already_exists") {
		t.Fatalf("rejected mutation lost structured Freed error: %s", result.Stderr)
	}
}

func TestStructuredFreedErrorOutputAcceptsStdout(t *testing.T) {
	output := []byte(`{"schemaVersion":1,"error":{"code":"operation_replay_conflict","message":"request changed"}}`)
	result := commandResult{Stdout: output, ExitCode: 1}
	if got := structuredFreedErrorOutput(result); string(got) != string(output) {
		t.Fatalf("structured stdout error was lost: %q", got)
	}
}

func TestStructuredFreedErrorOutputRejectsNonErrorStdout(t *testing.T) {
	result := commandResult{Stdout: []byte(`{"schemaVersion":1,"ok":false}`), ExitCode: 1}
	if got := structuredFreedErrorOutput(result); got != nil {
		t.Fatalf("non-error stdout was exposed: %q", got)
	}
}

func TestReleaseFailureMasksSuccessfulMutation(t *testing.T) {
	token := "test-lease-token-test-lease-token-00"
	runner := &queuedRunner{
		testing: t,
		results: []commandResult{
			{Stdout: handoffBytes(token)},
			{Stdout: []byte(`{"action":"task.claim-heartbeat","result":{}}`)},
			{ExitCode: 1},
			{ExitCode: 1},
		},
		errors: []error{nil, nil, nil, nil},
	}
	_, err := executeBroker(context.Background(), runner, testConfig(), invocation{
		Profile: "freed-pilot", Action: "claim-heartbeat", Request: `{"schemaVersion":1}`,
	})
	if err == nil || !strings.Contains(err.Error(), "release failed") {
		t.Fatalf("expected fail-closed release error, got %v", err)
	}
	if len(runner.commands) != 4 {
		t.Fatalf("expected two bounded release attempts, got %d calls", len(runner.commands))
	}
	firstOperation := strings.Split(runner.commands[2].Env[0], "=")[1]
	secondOperation := strings.Split(runner.commands[3].Env[0], "=")[1]
	if firstOperation != secondOperation {
		t.Fatal("release response-loss retry changed its operation identity")
	}
}

func TestRunnerFailureDoesNotInventFreedOutput(t *testing.T) {
	runner := &queuedRunner{
		testing: t,
		results: []commandResult{{}},
		errors:  []error{errors.New("exec unavailable")},
	}
	_, err := executeBroker(context.Background(), runner, testConfig(), invocation{
		Profile: "freed-pilot", Action: "claim-acquire", Request: `{"schemaVersion":1}`,
	})
	if err == nil || !strings.Contains(err.Error(), "trusted launcher failed") {
		t.Fatalf("expected trusted launcher failure, got %v", err)
	}
}

func TestLauncherDenialPreservesStructuredStdout(t *testing.T) {
	output := []byte(`{"schemaVersion":1,"error":{"code":"lease_transaction_pending","message":"retry later"}}`)
	runner := &queuedRunner{
		testing: t,
		results: []commandResult{{Stdout: output, ExitCode: 1}},
	}
	result, err := executeBroker(context.Background(), runner, testConfig(), invocation{
		Profile: "freed-pilot", Action: "claim-acquire", Request: `{"schemaVersion":1}`,
	})
	if err != nil || result.ExitCode != 1 || string(structuredFreedErrorOutput(result)) != string(output) {
		t.Fatalf("launcher denial lost structured output: %#v, %v", result, err)
	}
}

func TestProtectedProfilePinsEveryRuntimeArtifact(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	freedRoot := filepath.Join(root, "freed")
	stateRoot := filepath.Join(root, "state")
	if err := os.Mkdir(freedRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(stateRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	writeArtifact := func(name string, mode os.FileMode) (string, string) {
		t.Helper()
		file := filepath.Join(root, name)
		content := []byte("artifact:" + name + "\n")
		if err := os.WriteFile(file, content, mode); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(content)
		return file, hex.EncodeToString(digest[:])
	}
	writeLargeArtifact := func(name string, mode os.FileMode, size int) (string, string) {
		t.Helper()
		file := filepath.Join(root, name)
		content := make([]byte, size)
		content[0] = 1
		if err := os.WriteFile(file, content, mode); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(content)
		return file, hex.EncodeToString(digest[:])
	}
	config := testConfig()
	config.FreedRepositoryRoot = freedRoot
	config.StateRoot = stateRoot
	config.NodeExecutable, config.NodeSHA256 = writeLargeArtifact(
		"node",
		0o700,
		maxControlArtifactBytes+1,
	)
	config.AutomationActorsEntry, config.AutomationActorsSHA256 = writeArtifact("actors.mjs", 0o600)
	config.AutomationControlEntry, config.AutomationControlSHA256 = writeArtifact("control.mjs", 0o600)
	config.AutomationControlLibrary, config.AutomationControlLibrarySHA256 = writeArtifact("control-library.mjs", 0o600)
	config.ActorReadinessLibrary, config.ActorReadinessLibrarySHA256 = writeArtifact("readiness.mjs", 0o600)
	config.KernelGuardLibrary, config.KernelGuardLibrarySHA256 = writeArtifact("kernel.mjs", 0o600)
	profileBytes, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	profile := filepath.Join(root, "freed-pilot.json")
	if err := os.WriteFile(profile, profileBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadBrokerConfig(profile, "freed-pilot", os.Getuid())
	if err != nil {
		t.Fatalf("protected profile did not load: %v", err)
	}
	if err := verifyBrokerRuntime(loaded, os.Getuid()); err != nil {
		t.Fatalf("pinned runtime did not verify: %v", err)
	}
	if err := os.WriteFile(config.AutomationControlEntry, []byte("changed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := verifyBrokerRuntime(loaded, os.Getuid()); err == nil || !strings.Contains(err.Error(), "changed") {
		t.Fatalf("expected checksum drift rejection, got %v", err)
	}
	symlink := filepath.Join(root, "profile-link.json")
	if err := os.Symlink(profile, symlink); err != nil {
		t.Fatal(err)
	}
	if _, err := loadBrokerConfig(symlink, "freed-pilot", os.Getuid()); err == nil {
		t.Fatal("broker accepted a symbolic profile")
	}
}
