/**
 * Pre-deploy guard for local `npm run deploy`.
 *
 * Direct `wrangler deploy` and the GitHub Action both write the same Worker, so
 * whoever deploys last wins — regardless of what's on main. On 2026-08-17 two
 * direct deploys from a tree without the latest commit silently reverted a fix
 * that was already merged and live, and it took a version-history dig to spot.
 *
 * So: refuse to deploy from a working copy that isn't exactly origin/main.
 * CI is exempt — it deploys a fresh checkout, which is the case we trust.
 * Emergencies can still get through with ALLOW_UNSAFE_DEPLOY=1.
 */
import { execFileSync } from "node:child_process";

const BRANCH = "main";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function fail(problem, fixes) {
  console.error(`\n  ✗ Deploy blocked: ${problem}\n`);
  console.error("    This would overwrite whatever is currently live with your local build.\n");
  for (const f of fixes) console.error(`      • ${f}`);
  console.error(
    "\n    Prefer deploying through git so production always matches the repo:\n" +
      "      git push origin main            # the Deploy action picks it up\n" +
      "      gh workflow run Deploy --ref main\n" +
      "\n    Really need to push this exact working copy? ALLOW_UNSAFE_DEPLOY=1 npm run deploy\n",
  );
  process.exit(1);
}

// A CI run is a clean checkout of a known ref — nothing to protect against.
if (process.env.GITHUB_ACTIONS || process.env.CI) process.exit(0);

if (process.env.ALLOW_UNSAFE_DEPLOY === "1") {
  console.warn("\n  ! ALLOW_UNSAFE_DEPLOY=1 — deploying this working copy, whatever state it's in.\n");
  process.exit(0);
}

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== BRANCH) {
  fail(`you're on '${branch}', not '${BRANCH}'.`, [
    `Switch with: git checkout ${BRANCH}`,
    "Or open a PR and let the Deploy action ship it once merged.",
  ]);
}

if (git("status", "--porcelain")) {
  fail("you have uncommitted changes.", [
    "Commit and push them, so what's live is reproducible from the repo.",
    "See what's pending with: git status",
  ]);
}

// Compare against the real remote, not a stale tracking ref.
try {
  execFileSync("git", ["fetch", "origin", BRANCH, "--quiet"], { stdio: "ignore" });
} catch {
  console.warn(`  ! Couldn't reach origin — comparing against the last known origin/${BRANCH}.`);
}

const local = git("rev-parse", "HEAD");
const remote = git("rev-parse", `origin/${BRANCH}`);
if (local !== remote) {
  const ahead = git("rev-list", "--count", `origin/${BRANCH}..HEAD`);
  const behind = git("rev-list", "--count", `HEAD..origin/${BRANCH}`);
  fail(
    `your ${BRANCH} doesn't match origin/${BRANCH} (${ahead} ahead, ${behind} behind).` +
      (Number(behind) > 0
        ? "\n    Deploying now would drop what's already on main — this is exactly how the PO-picker fix got reverted."
        : ""),
    [
      Number(behind) > 0 ? "Get current with: git pull --ff-only origin main" : null,
      Number(ahead) > 0 ? "Publish your work with: git push origin main" : null,
    ].filter(Boolean),
  );
}

console.log(`  ✓ ${BRANCH} matches origin/${BRANCH} and the tree is clean — deploying.`);
