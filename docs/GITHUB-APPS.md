# GitHub Apps

AubTown uses two private GitHub Apps installed only on selected repositories. Splitting them prevents routine queue observation from inheriting source publication authority.

## Registration handoff

Generate the exact private registration URLs without changing GitHub:

```sh
npm run github-app:registration -- coordinator
npm run github-app:registration -- draft-publisher
```

Each command validates its checked-in policy, converts permission names to GitHub's registration parameters, disables webhooks and user OAuth, and prints a deterministic policy digest. Use the returned URL only after owner approval. After registration, install each App with `Only select repositories` and select `freed-project/freed` for the pilot. Repository selection occurs during installation, not registration.

Generate one Coordinator private key for the Linux control host. Generate a separate Draft Publisher private key for each enrolled custody host so one host key can be revoked without copying authentication state from another host. Record the App ID, installation ID, App slug, bot login, selected repository, and registration digest outside the repository. Private keys never enter Git, issue state, checkpoints, logs, or worker environments.

## Coordinator

The Coordinator App reads issues, repository contents, pull requests, checks, and Actions state. In Phase 2 it may apply lifecycle labels and update one machine-managed issue comment. It cannot push source, create branches, or open pull requests.

Permissions:

- Metadata: read
- Contents: read
- Issues: write
- Pull requests: read
- Checks: read
- Actions: read

GitHub's Issues write permission also covers broader issue mutation. GitHub does not expose a narrower label-and-one-comment permission. AubTown therefore mints a write token only behind the explicit lifecycle projection gate and keeps the default scheduler token read-only.

Phase 1 uses polling and performs no writes. Webhook events remain disabled until a signed public ingress or private relay is approved.

## Draft Publisher

The Draft Publisher App receives a short-lived installation token only after qualification, authority, validation, review, exact-head, quota, and custody checks pass. The admitted plan binds the selected repository, checkpoint-backed work product, branch, head, and observed draft pull request when updating. The host passes the token to Git through a private askpass helper, uses an exact force-with-lease, verifies the remote head, and reconciles crash retries before creating or updating one draft. It cannot label or close issues, merge, release, deploy, or change workflow files during the pilot.

Permissions:

- Metadata: read
- Contents: write
- Pull requests: write

If a future task must modify `.github/workflows`, that class requires a separate approval before adding GitHub's Workflows permission. The initial App deliberately lacks it.

GitHub's Contents write permission is also broader than draft-branch publication. AubTown narrows it with the admitted publication plan, repository-scoped token, root-owned forced-command gateway, exact worktree and head checks, force-with-lease, and branch protection that grants neither App bypass authority. Do not add administration, deployments, environments, secrets, workflows, or Actions write permission.

## Credential handling

The App private keys stay in the host credential store. Workers never receive them. The host mints installation tokens on demand, narrows each token to the selected repository and required permissions, and discards it after the operation. Tokens never appear in Git arguments or remote URLs. GitHub installation tokens currently expire after one hour.

For the native MVP, `aubtown-github-token.service` mints a repository-scoped Coordinator read token at startup and every 35 minutes. It atomically installs the token as a mode-0600 file under the coordinator state directory. The reviewed Symphony patch reads that file for each request, so refresh does not require a restart. The service logs only the repository, expiry, permission receipt, and destination path. It never logs the token.

The Draft Publisher still mints a separate token only for an admitted draft publication operation. Its private key and token do not pass through the Symphony tracker configuration.

References:

- [Choosing GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [Generating installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [GitHub App installation tokens for Git access](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys#github-app-installation-access-tokens)
