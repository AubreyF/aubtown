import * as restate from "@restatedev/restate-sdk";
import type { DispatchClaim, QualificationReport } from "../domain/types.js";

export interface FakeWorkerRequest {
  readonly claim: DispatchClaim;
  readonly qualification: QualificationReport;
}

export interface FakeWorkerReceipt {
  readonly schemaVersion: 1;
  readonly claimId: string;
  readonly custodyEpoch: number;
  readonly stages: readonly [
    "plan",
    "implement",
    "validate",
    "independent-review",
    "handoff",
  ];
  readonly publication: "none";
}

export const fakeWorker = restate.service({
  name: "FakeWorker",
  handlers: {
    run: async (
      _ctx: restate.Context,
      request: FakeWorkerRequest,
    ): Promise<FakeWorkerReceipt> => {
      if (!request.qualification.eligible) {
        throw new restate.TerminalError("Fake worker received an ineligible issue.");
      }
      if (request.claim.issueNumber !== request.qualification.issue.number) {
        throw new restate.TerminalError("Fake worker claim does not match issue.");
      }
      return {
        schemaVersion: 1,
        claimId: request.claim.claimId,
        custodyEpoch: request.claim.custodyEpoch,
        stages: [
          "plan",
          "implement",
          "validate",
          "independent-review",
          "handoff",
        ],
        publication: "none",
      };
    },
  },
});
