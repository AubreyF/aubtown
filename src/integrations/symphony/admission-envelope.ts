import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  assertExecutionAdmission,
  executionAdmissionBindingSchema,
  executionAdmissionSchema,
  type ExecutionAdmission,
  type ExecutionAdmissionBinding,
} from "../../adapters/execution-admission.js";
import { accountUsageSnapshotSchema } from "../../domain/schemas.js";
import type { AccountUsageSnapshot } from "../../domain/types.js";
import { decideQuota } from "../../policy/quota.js";
import { canonicalJson } from "../../security/canonical-json.js";
import {
  admitSymphonyPrelaunch,
  denySymphonyPrelaunch,
  type SymphonyPrelaunchRequest,
  type SymphonyPrelaunchResponse,
} from "./prelaunch.js";

const MAX_ENVELOPE_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const CLAIM_MAX_AGE_SECONDS = 120;

export interface SymphonyAdmissionEnvelope {
  readonly schemaVersion: 1;
  readonly preparedAt: string;
  readonly selectedHost: {
    readonly id: string;
    readonly lane: "linux" | "macos";
  };
  readonly usage: AccountUsageSnapshot;
  readonly binding: ExecutionAdmissionBinding;
  readonly admission: ExecutionAdmission;
}

const hostIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export const symphonyAdmissionEnvelopeSchema: z.ZodType<SymphonyAdmissionEnvelope> =
  z.object({
    schemaVersion: z.literal(1),
    preparedAt: z.iso.datetime(),
    selectedHost: z.object({
      id: z.string().regex(hostIdPattern),
      lane: z.enum(["linux", "macos"]),
    }),
    usage: accountUsageSnapshotSchema,
    binding: executionAdmissionBindingSchema,
    admission: executionAdmissionSchema,
  }).strict();

export interface SymphonyPrelaunchReceipt {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly issueId: string;
  readonly workerHost: string;
  readonly authorityClaimId: string;
  readonly custodyEpoch: number;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly receiptId: string;
  readonly envelopeDigest: string;
  readonly admittedAt: string;
}

const receiptSchema: z.ZodType<SymphonyPrelaunchReceipt> = z.object({
  schemaVersion: z.literal(1),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  issueId: z.string().regex(/^[1-9][0-9]*$/u),
  workerHost: z.string().regex(hostIdPattern),
  authorityClaimId: z.string().min(1),
  custodyEpoch: z.number().int().positive(),
  taskId: z.string().min(1),
  taskRevision: z.number().int().positive(),
  receiptId: z.string().regex(/^prelaunch:[0-9a-f]{64}$/u),
  envelopeDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  admittedAt: z.iso.datetime(),
}).strict();

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryName(binding: ExecutionAdmissionBinding): string {
  return `${binding.qualification.repository.owner}/${binding.qualification.repository.name}`;
}

function sameRepository(
  left: ExecutionAdmissionBinding["qualification"]["repository"],
  right: ExecutionAdmissionBinding["claim"]["repository"],
): boolean {
  return (
    left.owner === right.owner &&
    left.name === right.name &&
    left.defaultBranch === right.defaultBranch
  );
}

function exactIssueBinding(binding: ExecutionAdmissionBinding): boolean {
  const issue = binding.qualification.issue;
  return (
    binding.claim.issueNumber === issue.number &&
    binding.authorityTask.githubIssue.number === issue.number &&
    binding.authorityTask.githubIssue.url === issue.url &&
    sameRepository(binding.qualification.repository, binding.claim.repository)
  );
}

function denyForQuota(
  request: SymphonyPrelaunchRequest,
  reason: ReturnType<typeof decideQuota>["reason"],
): SymphonyPrelaunchResponse {
  return denySymphonyPrelaunch(request, `quota-${reason}`);
}

function assertProtectedFile(
  stats: Awaited<ReturnType<typeof lstat>>,
  label: string,
): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size < 1 ||
    stats.size > MAX_ENVELOPE_BYTES ||
    (Number(stats.mode) & 0o022) !== 0
  ) {
    throw new Error(`${label} must be a protected physical file.`);
  }
}

export function resolveSymphonyAdmissionEnvelopePath(
  root: string,
  issueId: string,
): string {
  if (!path.isAbsolute(root) || !/^[1-9][0-9]*$/u.test(issueId)) {
    throw new Error("Symphony admission envelope root and issue ID are invalid.");
  }
  return path.join(root, `issue-${issueId}.json`);
}

export async function loadSymphonyAdmissionEnvelope(
  root: string,
  issueId: string,
): Promise<SymphonyAdmissionEnvelope> {
  const file = resolveSymphonyAdmissionEnvelopePath(root, issueId);
  if ((await realpath(file)) !== file) {
    throw new Error("Symphony admission envelope path cannot contain symbolic links.");
  }
  const stats = await lstat(file);
  assertProtectedFile(stats, "Symphony admission envelope");
  return symphonyAdmissionEnvelopeSchema.parse(
    JSON.parse(await readFile(file, "utf8")),
  );
}

export function evaluateSymphonyAdmission(input: {
  readonly request: SymphonyPrelaunchRequest;
  readonly envelope: SymphonyAdmissionEnvelope;
  readonly now: string;
}): SymphonyPrelaunchResponse | SymphonyPrelaunchReceipt {
  const envelope = symphonyAdmissionEnvelopeSchema.parse(input.envelope);
  const binding = envelope.binding;
  const qualification = binding.qualification;
  const issue = qualification.issue;
  const nowMs = Date.parse(input.now);
  const preparedAtMs = Date.parse(envelope.preparedAt);
  const claimedAtMs = Date.parse(binding.claim.claimedAt);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(preparedAtMs) ||
    !Number.isFinite(claimedAtMs) ||
    preparedAtMs > nowMs ||
    claimedAtMs > nowMs ||
    nowMs - claimedAtMs > CLAIM_MAX_AGE_SECONDS * 1_000
  ) {
    return denySymphonyPrelaunch(input.request, "admission-envelope-time-invalid");
  }
  if (
    input.request.issueId !== issue.number.toLocaleString("en-US", { useGrouping: false }) ||
    input.request.workerHost !== envelope.selectedHost.id ||
    binding.claim.hostId !== envelope.selectedHost.id ||
    !exactIssueBinding(binding)
  ) {
    return denySymphonyPrelaunch(input.request, "admission-binding-mismatch");
  }
  if (
    issue.state !== "open" ||
    !issue.labels.includes("debt") ||
    !issue.labels.includes("factory:ready") ||
    !qualification.eligible ||
    qualification.workLane !== "runtime-neutral" ||
    qualification.evidence.behavioral !== false ||
    binding.authorityTask.behavioral ||
    binding.authorityTask.state !== "approved_for_pr" ||
    !["pr-only", "merge-safe"].includes(binding.authorityTask.executionAuthority) ||
    binding.authorityTask.providerAuthority !== "forbidden"
  ) {
    return denySymphonyPrelaunch(input.request, "pilot-policy-blocked");
  }
  if (
    qualification.hostLane === "macos" &&
    envelope.selectedHost.lane !== "macos"
  ) {
    return denySymphonyPrelaunch(input.request, "host-lane-mismatch");
  }
  if (envelope.usage.accountId !== binding.accountId) {
    return denySymphonyPrelaunch(input.request, "quota-account-mismatch");
  }
  const quota = decideQuota({ snapshot: envelope.usage, now: input.now });
  if (quota.action !== "admit" && quota.action !== "throttle") {
    return denyForQuota(input.request, quota.reason);
  }
  try {
    assertExecutionAdmission({ admission: envelope.admission, binding, now: input.now });
  } catch {
    return denySymphonyPrelaunch(input.request, "authority-admission-invalid");
  }
  const envelopeDigest = sha256(canonicalJson(envelope));
  const receiptId = `prelaunch:${sha256(
    canonicalJson({
      request: input.request,
      authorityClaimId: envelope.admission.authorityClaimId,
      bindingDigest: envelope.admission.bindingDigest,
      envelopeDigest,
    }),
  )}`;
  return receiptSchema.parse({
    schemaVersion: 1,
    repository: repositoryName(binding),
    issueId: input.request.issueId,
    workerHost: input.request.workerHost,
    authorityClaimId: envelope.admission.authorityClaimId,
    custodyEpoch: binding.claim.custodyEpoch,
    taskId: envelope.admission.taskId,
    taskRevision: envelope.admission.taskRevision,
    receiptId,
    envelopeDigest,
    admittedAt: input.now,
  });
}

function receiptPath(root: string, receipt: SymphonyPrelaunchReceipt): string {
  const repositoryDigest = sha256(receipt.repository).slice(0, 16);
  const claimDigest = sha256(receipt.authorityClaimId).slice(0, 32);
  return path.join(
    root,
    `repo-${repositoryDigest}-issue-${receipt.issueId}-claim-${claimDigest}.json`,
  );
}

async function admitPrivateDirectory(root: string, label: string): Promise<void> {
  if (!path.isAbsolute(root)) {
    throw new Error(`${label} must be absolute.`);
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await realpath(root)) !== root) {
    throw new Error(`${label} cannot contain symbolic links.`);
  }
  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
    throw new Error(`${label} must be a private directory.`);
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export class SymphonyAdmissionEnvelopeStore {
  constructor(private readonly root: string) {}

  async publish(envelope: SymphonyAdmissionEnvelope): Promise<string> {
    const parsed = symphonyAdmissionEnvelopeSchema.parse(envelope);
    const issueId = parsed.binding.qualification.issue.number.toLocaleString(
      "en-US",
      { useGrouping: false },
    );
    if (!exactIssueBinding(parsed.binding)) {
      throw new Error("Symphony admission envelope does not bind one exact issue.");
    }
    await admitPrivateDirectory(
      this.root,
      "Symphony admission envelope root",
    );
    const file = resolveSymphonyAdmissionEnvelopePath(this.root, issueId);
    const staging = `${file}.staging-${randomUUID()}`;
    const handle = await open(staging, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(staging, file);
      await syncDirectory(this.root);
    } catch (error) {
      await unlink(staging).catch((cleanupError: NodeJS.ErrnoException) => {
        if (cleanupError.code !== "ENOENT") {
          throw cleanupError;
        }
      });
      throw error;
    }
    const admitted = await loadSymphonyAdmissionEnvelope(this.root, issueId);
    if (!Buffer.from(canonicalJson(admitted)).equals(canonicalJson(parsed))) {
      throw new Error("Symphony admission envelope readback changed after publication.");
    }
    return file;
  }
}

export class SymphonyPrelaunchReceiptStore {
  constructor(private readonly root: string) {}

  async reserve(receipt: SymphonyPrelaunchReceipt): Promise<boolean> {
    const parsed = receiptSchema.parse(receipt);
    await admitPrivateDirectory(
      this.root,
      "Symphony prelaunch receipt root",
    );
    const file = receiptPath(this.root, parsed);
    const bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    const staging = `${file}.staging-${randomUUID()}`;
    const handle = await open(staging, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(staging, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const stats = await lstat(file);
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.size < 1 ||
        stats.size > MAX_RECEIPT_BYTES ||
        (stats.mode & 0o022) !== 0 ||
        (await realpath(file)) !== file
      ) {
        throw new Error("Existing prelaunch receipt is not a protected physical file.");
      }
      const existing = receiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
      if (Buffer.from(canonicalJson(existing)).equals(canonicalJson(parsed))) {
        return false;
      }
      throw new Error("Existing prelaunch receipt conflicts with the exact claim.");
    } finally {
      await unlink(staging).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }
    await syncDirectory(this.root);
    return true;
  }
}

export async function authorizeSymphonyPrelaunch(input: {
  readonly request: SymphonyPrelaunchRequest;
  readonly envelope: SymphonyAdmissionEnvelope;
  readonly receiptStore: SymphonyPrelaunchReceiptStore;
  readonly now: string;
}): Promise<SymphonyPrelaunchResponse> {
  const evaluated = evaluateSymphonyAdmission(input);
  if ("decision" in evaluated) {
    return evaluated;
  }
  if (!(await input.receiptStore.reserve(evaluated))) {
    return denySymphonyPrelaunch(input.request, "dispatch-already-admitted");
  }
  return admitSymphonyPrelaunch(input.request, evaluated.receiptId);
}
