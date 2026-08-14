import {
  denySymphonyPrelaunch,
  parseSymphonyPrelaunchRequest,
} from "../integrations/symphony/prelaunch.js";

const request = parseSymphonyPrelaunchRequest(process.argv.slice(2));

// This command is installed before the writer is enabled so the reviewed Symphony boundary can
// be tested in its real deployment shape. The Freed bridge replaces this denial only after its
// task-scoped claim commands and final reread are implemented and verified.
process.stdout.write(
  `${JSON.stringify(
    denySymphonyPrelaunch(request, "freed-authority-bridge-unavailable"),
  )}\n`,
);
