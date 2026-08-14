import { GitHubAppBroker } from "../credentials/github-app-broker.js";
import { FilePrivateKeyProvider } from "../credentials/file-private-key-provider.js";
import { writeInstallationTokenFile } from "../credentials/token-file.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function positiveInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

const repository = required("GITHUB_REPO");
const privateKeyFile = required("AUBTOWN_GITHUB_APP_PRIVATE_KEY_FILE");
const tokenFile = required("GITHUB_TOKEN_FILE");
const identity = {
  appId: required("AUBTOWN_GITHUB_APP_ID"),
  installationId: positiveInteger("AUBTOWN_GITHUB_INSTALLATION_ID"),
  privateKeyReference: privateKeyFile,
  selectedRepositories: [repository],
};
const broker = new GitHubAppBroker(
  identity,
  undefined,
  new FilePrivateKeyProvider(),
);
const receipt = await broker.mintCoordinatorRead(repository);
if (Date.parse(receipt.expiresAt) - Date.now() < 10 * 60 * 1_000) {
  throw new Error("GitHub App token lifetime is shorter than ten minutes.");
}
await writeInstallationTokenFile({
  destination: tokenFile,
  token: receipt.token,
});
process.stdout.write(
  `${JSON.stringify({
    repository: receipt.repository,
    expiresAt: receipt.expiresAt,
    permissions: receipt.permissions,
    tokenFile,
  })}\n`,
);
