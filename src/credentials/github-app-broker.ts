import {
  createAppAuth,
  type InstallationAccessTokenAuthentication,
} from "@octokit/auth-app";
import type { PublicationPlan } from "../publication/policy.js";

export interface PrivateKeyProvider {
  resolve(reference: string): Promise<string>;
}

export interface GitHubAppIdentity {
  readonly appId: number | string;
  readonly installationId: number;
  readonly privateKeyReference: string;
  readonly selectedRepositories: readonly string[];
}

export interface InstallationTokenReceipt {
  readonly token: string;
  readonly expiresAt: string;
  readonly repository: string;
  readonly permissions: Readonly<Record<string, string>>;
}

type InstallationAuthenticator = (input: {
  readonly appId: number | string;
  readonly installationId: number;
  readonly privateKey: string;
  readonly repositoryName: string;
  readonly permissions: Record<string, string>;
}) => Promise<InstallationAccessTokenAuthentication>;

const defaultAuthenticator: InstallationAuthenticator = async (input) => {
  const auth = createAppAuth({
    appId: input.appId,
    installationId: input.installationId,
    privateKey: input.privateKey,
  });
  return await auth({
    type: "installation",
    installationId: input.installationId,
    repositoryNames: [input.repositoryName],
    permissions: input.permissions,
  });
};

const COORDINATOR_READ_PERMISSIONS = {
  metadata: "read",
  contents: "read",
  issues: "read",
  pull_requests: "read",
  checks: "read",
  actions: "read",
} as const;

const COORDINATOR_PROJECTION_PERMISSIONS = {
  ...COORDINATOR_READ_PERMISSIONS,
  issues: "write",
} as const;

const DRAFT_PUBLISHER_PERMISSIONS = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
} as const;

export class GitHubAppBroker {
  constructor(
    private readonly coordinator: GitHubAppIdentity,
    private readonly publisher: GitHubAppIdentity,
    private readonly keys: PrivateKeyProvider,
    private readonly authenticate: InstallationAuthenticator = defaultAuthenticator,
  ) {}

  async mintCoordinatorRead(repository: string): Promise<InstallationTokenReceipt> {
    return await this.#mint(
      this.coordinator,
      repository,
      COORDINATOR_READ_PERMISSIONS,
    );
  }

  async mintCoordinatorProjection(input: {
    readonly repository: string;
    readonly projectionApproved: boolean;
  }): Promise<InstallationTokenReceipt> {
    if (!input.projectionApproved) {
      throw new Error("Lifecycle projection token requires explicit phase approval.");
    }
    return await this.#mint(
      this.coordinator,
      input.repository,
      COORDINATOR_PROJECTION_PERMISSIONS,
    );
  }

  async mintDraftPublisher(input: {
    readonly repository: string;
    readonly plan: PublicationPlan;
  }): Promise<InstallationTokenReceipt> {
    if (
      !input.plan.allowed ||
      (input.plan.action !== "create-draft" && input.plan.action !== "update-draft")
    ) {
      throw new Error("Draft Publisher token requires an admitted draft publication plan.");
    }
    return await this.#mint(
      this.publisher,
      input.repository,
      DRAFT_PUBLISHER_PERMISSIONS,
    );
  }

  async #mint(
    identity: GitHubAppIdentity,
    repository: string,
    permissions: Record<string, string>,
  ): Promise<InstallationTokenReceipt> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
      throw new Error("GitHub repository must use owner/name form.");
    }
    if (!identity.selectedRepositories.includes(repository)) {
      throw new Error(`GitHub App is not enrolled for ${repository}.`);
    }
    const privateKey = await this.keys.resolve(identity.privateKeyReference);
    if (!privateKey.includes("PRIVATE KEY")) {
      throw new Error("GitHub App private key provider returned invalid key material.");
    }
    const repositoryName = repository.split("/")[1]!;
    const authentication = await this.authenticate({
      appId: identity.appId,
      installationId: identity.installationId,
      privateKey,
      repositoryName,
      permissions,
    });
    if (Date.parse(authentication.expiresAt) <= Date.now()) {
      throw new Error("GitHub App returned an already expired installation token.");
    }
    return {
      token: authentication.token,
      expiresAt: authentication.expiresAt,
      repository,
      permissions: { ...permissions },
    };
  }
}
