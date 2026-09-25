import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGES_DIR = path.join(repositoryRoot, "packages");
const CONSUMER_DIRS = ["apps", "packages"] as const;

/**
 * A typed error exists so a caller can respond to it differently from an
 * unexpected fault. If nothing catches it, it is an ordinary crash wearing a
 * specific name, and the response the author had in mind never happens.
 *
 * This is here because that failure shipped twice in one round on PR #83.
 * `ObjectTooLargeError` and `ObjectChangedError` were both introduced so the
 * routes could quarantine an intake and answer 413 or 409, and no route was
 * changed, so both fell into a generic catch and answered 500. Unit tests
 * proved each error was thrown correctly. Nothing observed that no caller
 * cared. A reviewer caught it; a reviewer should not have had to.
 *
 * What this checks is narrow on purpose: that SOMETHING somewhere narrows on
 * the class. It cannot tell a thoughtful handler from a careless one. It is a
 * guard against the error being introduced and then simply forgotten, which is
 * the specific thing that happened.
 */

/**
 * Errors with no handler yet, each with the reason it is legitimately
 * unhandled today.
 *
 * `consumerPackage` is the load-bearing field: the exemption survives only
 * while nothing imports that package. The moment a consumer lands, the
 * exemption is invalid and this suite fails, which is exactly when someone is
 * in a position to decide what the handler should do. An exemption that
 * expires on its own is the only kind worth writing, because nobody comes back
 * to re-read a list of permanent excuses.
 */
interface UnhandledErrorExemption {
  readonly className: string;
  readonly consumerPackage: string;
  readonly reason: string;
}

const UNHANDLED_ERROR_EXEMPTIONS: readonly UnhandledErrorExemption[] = [];

interface ExportedError {
  readonly className: string;
  readonly packageName: string;
  readonly file: string;
}

function packageDirectories(): readonly string[] {
  return fs
    .readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function sourceFiles(directory: string): readonly string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    // dist is generated from src, so scanning it would double-count every
    // class and let a stale build satisfy the check on its own.
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") {
        continue;
      }
      found.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      found.push(full);
    }
  }
  return found;
}

function exportedErrorClasses(): readonly ExportedError[] {
  const found: ExportedError[] = [];
  for (const packageName of packageDirectories()) {
    for (const file of sourceFiles(path.join(PACKAGES_DIR, packageName, "src"))) {
      const contents = fs.readFileSync(file, "utf8");
      for (const match of contents.matchAll(/^export class (\w+) extends \w*Error \{/gmu)) {
        const className = match[1];
        assert.ok(className !== undefined, `could not read a class name in ${file}`);
        found.push({ className, packageName: `@signal-audit/${packageName}`, file });
      }
    }
  }
  return found;
}

/** Any `instanceof X` outside the file that declares X. A class narrowed only
 * inside its own module is not a caller responding to it. */
function classesNarrowedByCallers(): ReadonlySet<string> {
  const narrowed = new Set<string>();
  for (const directory of CONSUMER_DIRS) {
    for (const file of sourceFiles(path.join(repositoryRoot, directory))) {
      const contents = fs.readFileSync(file, "utf8");
      const declaredHere = new Set(
        [...contents.matchAll(/^export class (\w+) extends \w*Error \{/gmu)].map((match) => match[1])
      );
      for (const match of contents.matchAll(/instanceof (\w+Error)\b/gu)) {
        const className = match[1];
        if (className !== undefined && !declaredHere.has(className)) {
          narrowed.add(className);
        }
      }
    }
  }
  return narrowed;
}

test("every exported error class is narrowed by some caller", () => {
  const narrowed = classesNarrowedByCallers();
  const exempted = new Set(UNHANDLED_ERROR_EXEMPTIONS.map((exemption) => exemption.className));

  const unhandled = exportedErrorClasses()
    .filter((error) => !narrowed.has(error.className) && !exempted.has(error.className))
    .map((error) => `${error.className} (${path.relative(repositoryRoot, error.file)})`);

  assert.deepEqual(
    unhandled,
    [],
    "these error classes are exported but no caller narrows on them, so they behave exactly like an untyped " +
      `throw:\n${unhandled.join("\n")}\n` +
      "Either handle them where they are thrown from, or add an entry to UNHANDLED_ERROR_EXEMPTIONS saying " +
      "which package has no consumer yet."
  );
});

test("every exemption still names a real, still-unhandled error class", () => {
  const declared = new Map(exportedErrorClasses().map((error) => [error.className, error.packageName]));
  const narrowed = classesNarrowedByCallers();

  for (const exemption of UNHANDLED_ERROR_EXEMPTIONS) {
    assert.ok(
      declared.has(exemption.className),
      `${exemption.className} is exempted but no longer exists; remove the exemption`
    );
    assert.equal(
      declared.get(exemption.className),
      exemption.consumerPackage,
      `${exemption.className} moved out of ${exemption.consumerPackage}; the exemption's reasoning no longer applies`
    );
    assert.ok(
      !narrowed.has(exemption.className),
      `${exemption.className} is now handled by a caller; remove it from UNHANDLED_ERROR_EXEMPTIONS`
    );
  }
});

test("an exemption expires as soon as its package gains a consumer", () => {
  // The whole justification for each current exemption is "nothing calls this
  // package yet". Checking the dependency graph rather than trusting the
  // sentence means the exemption cannot outlive its own reason.
  const exemptedPackages = new Set(UNHANDLED_ERROR_EXEMPTIONS.map((exemption) => exemption.consumerPackage));

  for (const packageName of exemptedPackages) {
    const dependents: string[] = [];
    for (const directory of CONSUMER_DIRS) {
      const root = path.join(repositoryRoot, directory);
      if (!fs.existsSync(root)) {
        continue;
      }
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const manifest = path.join(root, entry.name, "package.json");
        if (!fs.existsSync(manifest)) {
          continue;
        }
        const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
          name?: string;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        if (parsed.name === packageName) {
          continue;
        }
        if (
          parsed.dependencies?.[packageName] !== undefined ||
          parsed.devDependencies?.[packageName] !== undefined
        ) {
          dependents.push(`${directory}/${entry.name}`);
        }
      }
    }

    assert.deepEqual(
      dependents,
      [],
      `${packageName} now has consumers (${dependents.join(", ")}), so its errors can and must be handled. ` +
        "Add the handlers and remove the matching entries from UNHANDLED_ERROR_EXEMPTIONS."
    );
  }
});
