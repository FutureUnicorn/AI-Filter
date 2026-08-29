import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const workspaceAreas = [
  "apps/web",
  "apps/worker",
  "packages/config",
  "packages/domain",
  "packages/contracts",
  "packages/db",
  "packages/ai",
  "packages/ingestion",
  "packages/security"
];

const allowedDependencies = new Map([
  ["packages/config", new Set()],
  ["packages/domain", new Set()],
  ["packages/contracts", new Set(["packages/domain"])],
  ["packages/db", new Set(["packages/domain"])],
  ["packages/ai", new Set(["packages/contracts", "packages/domain"])],
  ["packages/ingestion", new Set(["packages/contracts", "packages/domain"])],
  ["packages/security", new Set(["packages/contracts", "packages/domain"])],
  ["apps/web", new Set(workspaceAreas.filter((area) => area.startsWith("packages/")))],
  ["apps/worker", new Set(workspaceAreas.filter((area) => area.startsWith("packages/")))]
]);

function normalize(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function areaFor(absolutePath) {
  const relativePath = normalize(path.relative(repositoryRoot, absolutePath));
  return workspaceAreas.find(
    (area) => relativePath === area || relativePath.startsWith(`${area}/`)
  );
}

function collectSourceFiles(directory) {
  const files = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if ([".next", "dist", "node_modules"].includes(entry.name)) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(absolutePath));
    } else if (/\.(?:cts|mts|ts|tsx)$/.test(entry.name)) {
      files.push(absolutePath);
    }
  }

  return files;
}

function importSpecifiers(filePath) {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true
  );
  const specifiers = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

const packageNameToArea = new Map();
const graph = new Map(workspaceAreas.map((area) => [area, new Set()]));
const violations = [];

for (const area of workspaceAreas) {
  const manifestPath = path.join(repositoryRoot, area, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  packageNameToArea.set(manifest.name, area);
}

function addEdge(sourceArea, targetArea, context) {
  if (sourceArea === targetArea) {
    return;
  }

  const allowed = allowedDependencies.get(sourceArea);
  if (allowed === undefined || !allowed.has(targetArea)) {
    violations.push(`${context}: ${sourceArea} must not depend on ${targetArea}`);
  }
  graph.get(sourceArea)?.add(targetArea);
}

for (const area of workspaceAreas) {
  const manifestPath = path.join(repositoryRoot, area, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies
  };

  for (const dependencyName of Object.keys(dependencies)) {
    const targetArea = packageNameToArea.get(dependencyName);
    if (targetArea !== undefined) {
      addEdge(area, targetArea, normalize(path.relative(repositoryRoot, manifestPath)));
    }
  }
}

for (const sourceRoot of ["apps", "packages"]) {
  const sourceFiles = collectSourceFiles(path.join(repositoryRoot, sourceRoot));

  for (const sourceFile of sourceFiles) {
    const sourceArea = areaFor(sourceFile);
    if (sourceArea === undefined) {
      continue;
    }

    for (const specifier of importSpecifiers(sourceFile)) {
      const context = `${normalize(path.relative(repositoryRoot, sourceFile))} imports ${specifier}`;
      const internalTarget = packageNameToArea.get(specifier);

      if (internalTarget !== undefined) {
        addEdge(sourceArea, internalTarget, context);
        const manifest = JSON.parse(
          fs.readFileSync(path.join(repositoryRoot, sourceArea, "package.json"), "utf8")
        );
        if (manifest.dependencies?.[specifier] === undefined) {
          violations.push(`${context}: internal dependency is not declared in package.json`);
        }
        continue;
      }

      if (specifier.startsWith(".")) {
        const resolvedTarget = path.resolve(path.dirname(sourceFile), specifier);
        const targetArea = areaFor(resolvedTarget);
        if (targetArea !== undefined && targetArea !== sourceArea) {
          violations.push(
            `${context}: cross-workspace relative imports are forbidden; use the public package name`
          );
        }

        const relativeTarget = normalize(path.relative(repositoryRoot, resolvedTarget));
        if (relativeTarget.startsWith("tests/") || relativeTarget.startsWith("evals/")) {
          violations.push(`${context}: production code must not import tests or evals`);
        }
        continue;
      }

      if (sourceArea === "packages/domain") {
        violations.push(`${context}: the domain must not import external packages or Node APIs`);
      }
    }
  }
}

const visited = new Set();
const active = new Set();

function visitArea(area, trail) {
  if (active.has(area)) {
    violations.push(`workspace dependency cycle: ${[...trail, area].join(" -> ")}`);
    return;
  }
  if (visited.has(area)) {
    return;
  }

  active.add(area);
  for (const target of graph.get(area) ?? []) {
    visitArea(target, [...trail, area]);
  }
  active.delete(area);
  visited.add(area);
}

for (const area of workspaceAreas) {
  visitArea(area, []);
}

if (violations.length > 0) {
  console.error("Architecture boundary violations:");
  for (const violation of [...new Set(violations)]) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(`Architecture boundaries passed for ${workspaceAreas.length} workspaces.`);
