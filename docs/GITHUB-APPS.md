# GitHub Apps

Freedworks uses two private GitHub Apps installed only on selected repositories. Splitting them prevents routine queue observation from inheriting source publication authority.

## Coordinator

The Coordinator App reads issues, repository contents, pull requests, checks, and Actions state. In Phase 2 it may apply lifecycle labels and update one machine-managed issue comment. It cannot push source, create branches, or open pull requests.

Permissions:

- Metadata: read
- Contents: read
- Issues: write
- Pull requests: read
- Checks: read
- Actions: read

Phase 1 uses polling and performs no writes. Webhook events remain disabled until a signed public ingress or private relay is approved.

## Draft Publisher

The Draft Publisher App receives a short-lived installation token only after qualification, authority, validation, review, exact-head, quota, and custody checks pass. It may push the bound branch and create or update its draft pull request. It cannot label or close issues, merge, release, deploy, or change workflow files during the pilot.

Permissions:

- Metadata: read
- Contents: write
- Pull requests: write

If a future task must modify `.github/workflows`, that class requires a separate approval before adding GitHub's Workflows permission. The initial App deliberately lacks it.

## Credential handling

The App private keys stay in the host credential store. Workers never receive them. The host mints installation tokens on demand, narrows each token to the selected repository and required permissions, and discards it after the operation. GitHub installation tokens currently expire after one hour.

References:

- [Choosing GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [Generating installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [GitHub App installation tokens for Git access](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys#github-app-installation-access-tokens)
