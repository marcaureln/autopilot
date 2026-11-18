// Type-only imports count (tsPreCompilationDeps), so a cycle through types is also a finding.
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    { name: "core-not-to-commands", severity: "error", from: { path: "^src/core" }, to: { path: "^src/commands" } },
    // Core reaches harnesses through the registry in src/harness/harness.ts.
    { name: "core-not-to-adapters", severity: "error", from: { path: "^src/core" }, to: { path: "^src/harness/(claude|opencode)\\.ts$" } },
  ],
  options: { tsPreCompilationDeps: true, tsConfig: { fileName: "tsconfig.json" } },
};
