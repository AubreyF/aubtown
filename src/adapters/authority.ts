import type { AuthorityTask, QualificationReport } from "../domain/types.js";
import type {
  ExecutionAdmission,
  ExecutionAdmissionBinding,
} from "./execution-admission.js";

export interface AuthorityInspection {
  readonly task?: AuthorityTask;
  readonly active: boolean;
  readonly reason: string;
}

export type ExecutionClaimReleaseReason =
  | "prelaunch-denied"
  | "worker-completed"
  | "worker-failed"
  | "worker-interrupted"
  | "reconciled-unlaunched";

export interface AuthorityBridge {
  readonly id: string;
  inspect(report: QualificationReport): Promise<AuthorityInspection>;
  acquire(input: {
    readonly binding: ExecutionAdmissionBinding;
    readonly now: string;
  }): Promise<ExecutionAdmission>;
  release(input: {
    readonly admission: ExecutionAdmission;
    readonly reason: ExecutionClaimReleaseReason;
    readonly now: string;
  }): Promise<void>;
}
