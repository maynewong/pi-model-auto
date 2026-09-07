import { describe, expect, it } from "vitest";

// The release state module is plain ESM so the runtime script has no build step.
// @ts-expect-error No declaration file is needed for this internal script module.
import { decideReleaseState, ReleaseState } from "./release-state.mjs";

const base = {
  head: "head",
  originMain: "head",
  localTagCommit: "head",
  remoteTagCommit: "head",
  npmPublished: true,
  remoteTagIsAncestorOfHead: true,
  originMainIsAncestorOfHead: true,
};

describe("decideReleaseState", () => {
  it("starts a new release only when git and npm already contain the current version", () => {
    expect(decideReleaseState(base)).toBe(ReleaseState.COMPLETE);
  });

  it("accepts a completed version tag that is an ancestor of HEAD", () => {
    expect(
      decideReleaseState({
        ...base,
        localTagCommit: "previous",
        remoteTagCommit: "previous",
      }),
    ).toBe(ReleaseState.COMPLETE);
  });

  it("resumes npm publish without bumping when the tag is already pushed", () => {
    expect(decideReleaseState({ ...base, npmPublished: false })).toBe(
      ReleaseState.TAG_PUSHED_NOT_PUBLISHED,
    );
  });

  it("resumes the git push without bumping when npm is already published", () => {
    expect(decideReleaseState({ ...base, remoteTagCommit: null })).toBe(
      ReleaseState.PUBLISHED_NOT_PUSHED,
    );
  });

  it("pushes and publishes an existing local version commit without bumping", () => {
    expect(
      decideReleaseState({
        ...base,
        remoteTagCommit: null,
        npmPublished: false,
      }),
    ).toBe(ReleaseState.LOCAL_RELEASE_NOT_PUSHED);
  });

  it("refuses an ambiguous untagged and unpublished version", () => {
    expect(() =>
      decideReleaseState({
        ...base,
        localTagCommit: null,
        remoteTagCommit: null,
        npmPublished: false,
      }),
    ).toThrow(/Refusing to guess/);
  });

  it("refuses to publish when an unpublished remote tag is not HEAD", () => {
    expect(() =>
      decideReleaseState({
        ...base,
        localTagCommit: "previous",
        remoteTagCommit: "previous",
        npmPublished: false,
      }),
    ).toThrow(/does not point to HEAD/);
  });

  it("refuses conflicting local and remote tags", () => {
    expect(() =>
      decideReleaseState({
        ...base,
        localTagCommit: "local",
        remoteTagCommit: "remote",
      }),
    ).toThrow(/different commits/);
  });

  it("refuses to bump when the completed tag is not an ancestor of HEAD", () => {
    expect(() =>
      decideReleaseState({ ...base, remoteTagIsAncestorOfHead: false }),
    ).toThrow(/not an ancestor/);
  });

  it("refuses to bump when main differs from origin/main", () => {
    expect(() =>
      decideReleaseState({ ...base, originMain: "remote" }),
    ).toThrow(/must match origin\/main/);
  });

  it("refuses an npm-only release without a matching local tag at HEAD", () => {
    expect(() =>
      decideReleaseState({
        ...base,
        localTagCommit: null,
        remoteTagCommit: null,
      }),
    ).toThrow(/no matching local tag/);
  });

  it("refuses a local release when origin/main is not its ancestor", () => {
    expect(() =>
      decideReleaseState({
        ...base,
        originMain: "other",
        remoteTagCommit: null,
        npmPublished: false,
        originMainIsAncestorOfHead: false,
      }),
    ).toThrow(/not an ancestor/);
  });
});
