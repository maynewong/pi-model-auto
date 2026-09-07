#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { decideReleaseState, ReleaseState } from "./release-state.mjs";

const cliArgs = process.argv.slice(2);
const dryRun = cliArgs.includes("--dry-run");
const publishArgs = [];

for (let index = 0; index < cliArgs.length; index += 1) {
  const arg = cliArgs[index];
  if (arg === "--dry-run") continue;
  if (/^--otp=\d{6}$/.test(arg)) {
    publishArgs.push(arg);
    continue;
  }
  if (arg === "--otp" && /^\d{6}$/.test(cliArgs[index + 1] ?? "")) {
    publishArgs.push(arg, cliArgs[index + 1]);
    index += 1;
    continue;
  }
  fail(`Unknown argument: ${arg}`);
}

if (dryRun && publishArgs.length > 0) {
  fail("--otp cannot be used together with --dry-run.");
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const name = pkg.name;
const version = pkg.version;
const tag = `v${version}`;

function fail(message) {
  console.error(`\n[release] ERROR: ${message}`);
  process.exit(1);
}

function capture(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    fail(`${command} could not be started: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : "."}`);
  }
  return result;
}

function run(command, args, { displayArgs = args } = {}) {
  console.log(`\n[release] $ ${command} ${displayArgs.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    fail(`${command} could not be started: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited with status ${result.status}.`);
  }
}

function git(...args) {
  return capture("git", args).stdout.trim();
}

function optionalGitCommit(ref) {
  const result = capture("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function remoteTagCommit(remote, tagName) {
  const result = capture("git", [
    "ls-remote",
    "--tags",
    remote,
    `refs/tags/${tagName}`,
    `refs/tags/${tagName}^{}`,
  ]);
  const refs = new Map(
    result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/\s+/, 2).reverse()),
  );
  return refs.get(`refs/tags/${tagName}^{}`) ?? refs.get(`refs/tags/${tagName}`) ?? null;
}

function isAncestor(ancestor, descendant) {
  if (!ancestor) return false;
  const result = capture("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    allowFailure: true,
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  fail(`Could not compare commits ${ancestor} and ${descendant}.`);
}

function npmVersionExists(packageName, packageVersion) {
  const result = capture(
    "npm",
    ["view", `${packageName}@${packageVersion}`, "version", "--json"],
    { allowFailure: true },
  );
  if (result.status === 0) {
    try {
      const returnedVersion = JSON.parse(result.stdout);
      if (returnedVersion === packageVersion) return true;
      fail(
        `npm returned an unexpected version while checking ${packageName}@${packageVersion}: ` +
          JSON.stringify(returnedVersion),
      );
    } catch (error) {
      if (error instanceof SyntaxError) {
        fail(`npm returned an invalid response while checking ${packageName}@${packageVersion}.`);
      }
      throw error;
    }
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (/\bE404\b|404 Not Found|is not in this registry/i.test(output)) {
    return false;
  }
  fail(
    `Could not determine whether ${packageName}@${packageVersion} exists on npm. ` +
      "Fix the registry/network/authentication error and retry; it will not be treated as unpublished.",
  );
}

function ensureCleanMain() {
  const branch = git("branch", "--show-current");
  if (branch !== "main") {
    fail(`Releases must run from main, not ${branch || "a detached HEAD"}.`);
  }
  if (git("status", "--porcelain")) {
    if (!dryRun) {
      fail("The working tree is not clean. Commit or stash changes before releasing.");
    }
    console.warn(
      "[release] WARNING: the working tree is not clean. A real release would stop here.",
    );
  }
}

function describeState(state) {
  switch (state) {
    case ReleaseState.COMPLETE:
      return {
        label: "current version is complete on git and npm",
        actions: [
          "run typecheck, tests, and build",
          "bump the patch version and create its commit/tag",
          "push main and tags",
          "publish the new version to npm",
        ],
      };
    case ReleaseState.TAG_PUSHED_NOT_PUBLISHED:
      return {
        label: "git tag is pushed, but npm publish is incomplete",
        actions: ["publish the current version to npm (no version bump)"],
      };
    case ReleaseState.PUBLISHED_NOT_PUSHED:
      return {
        label: "npm publish succeeded, but the git release was not pushed",
        actions: ["push the current release commit and tags (no version bump)"],
      };
    case ReleaseState.LOCAL_RELEASE_NOT_PUSHED:
      return {
        label: "a local version commit/tag exists, but neither remote step completed",
        actions: [
          "push the current release commit and tag (no version bump)",
          "publish the current version to npm",
        ],
      };
    default:
      throw new Error(`Unexpected release state: ${state}`);
  }
}

function pushRelease(releaseTag) {
  run("git", ["push", "--atomic", "origin", "main", `refs/tags/${releaseTag}`]);
}

function publish() {
  const displayArgs = publishArgs.length > 0 ? ["publish", "--otp=******"] : ["publish"];
  run("npm", ["publish", ...publishArgs], { displayArgs });
}

try {
  ensureCleanMain();

  console.log("[release] Refreshing origin/main and tags...");
  run("git", ["fetch", "origin", "main", "--tags", "--prune"]);

  const head = git("rev-parse", "HEAD");
  const originMain = optionalGitCommit("refs/remotes/origin/main");
  if (!originMain) {
    fail("origin/main does not exist.");
  }

  const localTagCommit = optionalGitCommit(`refs/tags/${tag}`);
  const remoteTag = remoteTagCommit("origin", tag);
  const npmPublished = npmVersionExists(name, version);

  const state = decideReleaseState({
    head,
    originMain,
    localTagCommit,
    remoteTagCommit: remoteTag,
    npmPublished,
    remoteTagIsAncestorOfHead: isAncestor(remoteTag, head),
    originMainIsAncestorOfHead: isAncestor(originMain, head),
  });
  const description = describeState(state);

  console.log(`\n[release] Package: ${name}`);
  console.log(`[release] Current version: ${version}`);
  console.log(`[release] Local tag ${tag}: ${localTagCommit ? "present" : "missing"}`);
  console.log(`[release] Remote tag ${tag}: ${remoteTag ? "present" : "missing"}`);
  console.log(`[release] npm ${name}@${version}: ${npmPublished ? "published" : "missing"}`);
  console.log(`[release] State: ${description.label}`);
  console.log("[release] Planned actions:");
  for (const action of description.actions) console.log(`  - ${action}`);

  if (dryRun) {
    console.log("\n[release] Dry run complete; no release action was performed.");
    process.exit(0);
  }

  switch (state) {
    case ReleaseState.COMPLETE: {
      run("npm", ["run", "prepublishOnly"]);
      run("npm", ["version", "patch"]);
      const nextVersion = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ).version;
      pushRelease(`v${nextVersion}`);
      publish();
      break;
    }
    case ReleaseState.TAG_PUSHED_NOT_PUBLISHED:
      publish();
      break;
    case ReleaseState.PUBLISHED_NOT_PUSHED:
      pushRelease(tag);
      break;
    case ReleaseState.LOCAL_RELEASE_NOT_PUSHED:
      pushRelease(tag);
      publish();
      break;
    default:
      fail(`Unexpected release state: ${state}`);
  }

  console.log("\n[release] Release completed successfully.");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
