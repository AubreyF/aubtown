import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../security/canonical-json.js";
import { loadProtectedJsonFile } from "../security/protected-json.js";

const common = {
  schemaVersion: z.literal(1),
  description: z.string().min(1).max(200),
  homepageUrl: z.url().startsWith("https://"),
  repositorySelection: z.literal("selected"),
  public: z.literal(false),
  webhookActive: z.literal(false),
  requestOauthOnInstall: z.literal(false),
};

const coordinatorPolicySchema = z.object({
  ...common,
  name: z.literal("FreedTown Coordinator"),
  permissions: z.object({
    metadata: z.literal("read"),
    contents: z.literal("read"),
    issues: z.literal("write"),
    pullRequests: z.literal("read"),
    checks: z.literal("read"),
    actions: z.literal("read"),
  }).strict(),
  pilotEvents: z.array(z.never()).length(0),
  phase2Events: z.array(z.enum([
    "issues",
    "issue_comment",
    "pull_request",
    "check_run",
    "check_suite",
  ])).length(5),
}).strict();

const draftPublisherPolicySchema = z.object({
  ...common,
  name: z.literal("FreedTown Draft Publisher"),
  permissions: z.object({
    metadata: z.literal("read"),
    contents: z.literal("write"),
    pullRequests: z.literal("write"),
  }).strict(),
  events: z.array(z.never()).length(0),
  publicationCeiling: z.literal("draft-pr"),
  workflowFilesAllowed: z.literal(false),
}).strict();

export const githubAppPolicySchema = z.union([
  coordinatorPolicySchema,
  draftPublisherPolicySchema,
]);

export type GitHubAppPolicy = z.infer<typeof githubAppPolicySchema>;

const permissionNames = {
  metadata: "metadata",
  contents: "contents",
  issues: "issues",
  pullRequests: "pull_requests",
  checks: "checks",
  actions: "actions",
} as const;

export async function loadGitHubAppPolicy(file: string): Promise<GitHubAppPolicy> {
  return githubAppPolicySchema.parse(
    await loadProtectedJsonFile({
      file,
      label: "GitHub App policy",
      maxBytes: 64 * 1_024,
    }),
  );
}

export function renderGitHubAppRegistration(policy: GitHubAppPolicy): {
  readonly role: "coordinator" | "draft-publisher";
  readonly name: string;
  readonly registrationUrl: string;
  readonly registrationSha256: string;
  readonly repositorySelection: "selected";
  readonly initialRepositories: readonly ["freed-project/freed"];
  readonly permissions: Readonly<Record<string, "read" | "write">>;
  readonly webhookActive: false;
  readonly requestOauthOnInstall: false;
} {
  const permissions = Object.fromEntries(
    Object.entries(policy.permissions).map(([name, value]) => [
      permissionNames[name as keyof typeof permissionNames],
      value,
    ]),
  ) as Record<string, "read" | "write">;
  const parameters = new URLSearchParams({
    name: policy.name,
    description: policy.description,
    url: policy.homepageUrl,
    public: "false",
    webhook_active: "false",
    request_oauth_on_install: "false",
  });
  for (const [name, value] of Object.entries(permissions).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    parameters.set(name, value);
  }
  parameters.sort();
  const role: "coordinator" | "draft-publisher" =
    policy.name === "FreedTown Coordinator" ? "coordinator" : "draft-publisher";
  const registration = {
    role,
    name: policy.name,
    registrationUrl: `https://github.com/settings/apps/new?${parameters.toString()}`,
    repositorySelection: "selected" as const,
    initialRepositories: ["freed-project/freed"] as const,
    permissions,
    webhookActive: false as const,
    requestOauthOnInstall: false as const,
  };
  return {
    ...registration,
    registrationSha256: createHash("sha256")
      .update(canonicalJson(registration))
      .digest("hex"),
  };
}
