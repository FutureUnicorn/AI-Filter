/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true }
    },
    {
      name: "domain-does-not-depend-outward",
      severity: "error",
      from: { path: "^packages/domain" },
      to: { path: "^(apps|packages/(ai|config|contracts|db|ingestion|security))" }
    },
    {
      name: "packages-do-not-depend-on-apps",
      severity: "error",
      from: { path: "^packages" },
      to: { path: "^apps" }
    },
    {
      name: "production-does-not-import-test-or-eval-code",
      severity: "error",
      from: { path: "^(apps|packages)" },
      to: { path: "^(tests|evals)" }
    }
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: "(^|/)(dist|node_modules|\\.next)/",
    tsConfig: { fileName: "tsconfig.base.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      conditionNames: ["types", "import", "node", "default"],
      exportsFields: ["exports"]
    }
  }
};
