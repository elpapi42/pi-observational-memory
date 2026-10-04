import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const fail = (message) => {
  throw new Error(message);
};

const required = (name) => {
  const value = process.env[name];
  if (!value) fail(`${name} is required.`);
  return value;
};

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const expectedRepository = required("EXPECTED_REPOSITORY");
const tag = required("RELEASE_TAG");
const releaseSha = required("RELEASE_SHA");
const eventPath = required("GITHUB_EVENT_PATH");
const event = JSON.parse(readFileSync(eventPath, "utf8"));
const release = event.release;

if (event.action !== "published") fail(`Expected a published release event, got ${event.action}.`);
if (!release || release.draft || release.prerelease) fail("Only stable, published releases can publish this package.");
if (release.tag_name !== tag) fail("Release tag does not match the workflow input.");
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
  fail(`Release tag ${tag} is not a stable numeric version.`);
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));
const lockRoot = lockfile.packages?.[""];
const repository = typeof packageJson.repository === "string" ? packageJson.repository : packageJson.repository?.url;
const expectedRepositoryUrl = `git+https://github.com/${expectedRepository}.git`;
if (packageJson.name !== "pi-observational-memory") fail(`Unexpected package name: ${packageJson.name}.`);
if (packageJson.version !== tag) fail(`package.json version ${packageJson.version} does not match tag ${tag}.`);
if (lockRoot?.name !== packageJson.name || lockRoot?.version !== tag) {
  fail("package-lock.json root name or version does not match package.json.");
}
if (repository !== expectedRepositoryUrl) fail(`Unexpected repository URL: ${repository}.`);

const tagCommit = git("rev-parse", `${tag}^{commit}`);
const headCommit = git("rev-parse", "HEAD");
if (tagCommit !== headCommit || tagCommit !== releaseSha) {
  fail("The checked-out commit does not match the release tag and event SHA.");
}
execFileSync("git", ["merge-base", "--is-ancestor", tagCommit, "origin/master"], { stdio: "inherit" });
