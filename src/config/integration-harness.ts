export function integrationHarnessEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "" || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new Error(
    "AUBTOWN_ENABLE_INTEGRATION_HARNESS must be exactly true or false.",
  );
}
