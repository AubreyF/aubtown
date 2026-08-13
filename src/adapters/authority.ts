import type { AuthorityTask, QualificationReport } from "../domain/types.js";

export interface AuthorityInspection {
  readonly task?: AuthorityTask;
  readonly active: boolean;
  readonly reason: string;
}

export interface ExecutionAuthorityLease {
  readonly actor: string;
  readonly leaseName: string;
  readonly token: string;
  readonly expiresAt: string;
}

export interface AuthorityBridge {
  readonly id: string;
  inspect(report: QualificationReport): Promise<AuthorityInspection>;
  acquire(report: QualificationReport, workerId: string): Promise<ExecutionAuthorityLease>;
  release(lease: ExecutionAuthorityLease): Promise<void>;
}
