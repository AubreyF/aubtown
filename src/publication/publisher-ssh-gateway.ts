import type { CommandRunner } from "../adapters/command-runner.js";
import { publishDraftLocally } from "./local-draft-publisher.js";
import {
  probePublisherReadiness,
  type PublisherReadinessReport,
} from "./publisher-readiness.js";
import type { DraftPublicationReceipt } from "./draft-publisher.js";

const publishCommand = /^publish ([A-Za-z0-9_-]{1,2097152})$/u;

export type PublisherSshGatewayResult =
  | PublisherReadinessReport
  | DraftPublicationReceipt;

export async function runPublisherSshGateway(input: {
  readonly originalCommand: string | undefined;
  readonly runtimeFile: string;
  readonly publisherFile: string;
  readonly gatewayFile: string;
  readonly authorizedKeysFile: string;
  readonly runner: CommandRunner;
  readonly checkedAt: string;
  readonly requiredArtifactUid?: number;
  readonly processUid?: number;
  readonly probe?: typeof probePublisherReadiness;
  readonly publish?: typeof publishDraftLocally;
}): Promise<PublisherSshGatewayResult> {
  const probe = input.probe ?? probePublisherReadiness;
  const publish = input.publish ?? publishDraftLocally;
  if (input.originalCommand === "probe") {
    return await probe({
      runtimeFile: input.runtimeFile,
      publisherFile: input.publisherFile,
      gatewayFile: input.gatewayFile,
      authorizedKeysFile: input.authorizedKeysFile,
      runner: input.runner,
      checkedAt: input.checkedAt,
      ...(input.requiredArtifactUid === undefined
        ? {}
        : { requiredArtifactUid: input.requiredArtifactUid }),
      ...(input.processUid === undefined ? {} : { processUid: input.processUid }),
    });
  }
  const match =
    input.originalCommand === undefined
      ? null
      : publishCommand.exec(input.originalCommand);
  if (match === null) {
    throw new Error("Publisher SSH command is outside the forced-command allowlist.");
  }
  await probe({
    runtimeFile: input.runtimeFile,
    publisherFile: input.publisherFile,
    gatewayFile: input.gatewayFile,
    authorizedKeysFile: input.authorizedKeysFile,
    runner: input.runner,
    checkedAt: input.checkedAt,
    ...(input.requiredArtifactUid === undefined
      ? {}
      : { requiredArtifactUid: input.requiredArtifactUid }),
    ...(input.processUid === undefined ? {} : { processUid: input.processUid }),
  });
  return await publish({
    runtimeFile: input.runtimeFile,
    payload: match[1]!,
    runner: input.runner,
  });
}
