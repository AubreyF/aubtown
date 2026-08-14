import * as restate from "@restatedev/restate-sdk";
import {
  parseSignedCheckpointStorageReceipt,
  type SignedCheckpointStorageReceipt,
} from "../checkpoints/receipt.js";
import { canonicalJsonEqual } from "../security/canonical-json.js";

interface CheckpointCatalogState {
  receipt: SignedCheckpointStorageReceipt;
}

export const checkpointCatalog = restate.object({
  name: "CheckpointCatalog",
  options: { ingressPrivate: true },
  handlers: {
    record: async (
      ctx: restate.ObjectContext<CheckpointCatalogState>,
      rawReceipt: SignedCheckpointStorageReceipt,
    ): Promise<SignedCheckpointStorageReceipt> => {
      const receipt = parseSignedCheckpointStorageReceipt(rawReceipt);
      if (receipt.reference !== ctx.key) {
        throw new restate.TerminalError(
          "Checkpoint receipt does not match its content-addressed catalog key.",
        );
      }
      const current = await ctx.get("receipt");
      if (current !== null) {
        if (!canonicalJsonEqual(current, receipt)) {
          throw new restate.TerminalError(
            "Checkpoint catalog reference already contains a different receipt.",
          );
        }
        return current;
      }
      ctx.set("receipt", receipt);
      return receipt;
    },
    read: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext<CheckpointCatalogState>) => {
        return await ctx.get("receipt");
      },
    ),
  },
});
