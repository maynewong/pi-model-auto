export const ReleaseState = Object.freeze({
  COMPLETE: "complete",
  TAG_PUSHED_NOT_PUBLISHED: "tag-pushed-not-published",
  PUBLISHED_NOT_PUSHED: "published-not-pushed",
  LOCAL_RELEASE_NOT_PUSHED: "local-release-not-pushed",
});

/**
 * Classify the current package version without performing any side effects.
 *
 * A completed older version tag may be an ancestor of HEAD because normal
 * development continues without changing package.json until the next release.
 * Partial releases are stricter: their tag must point exactly at HEAD.
 */
export function decideReleaseState({
  head,
  originMain,
  localTagCommit,
  remoteTagCommit,
  npmPublished,
  remoteTagIsAncestorOfHead,
  originMainIsAncestorOfHead,
}) {
  if (localTagCommit && remoteTagCommit && localTagCommit !== remoteTagCommit) {
    throw new Error("The local and remote tags point to different commits.");
  }

  if (remoteTagCommit && npmPublished) {
    if (!remoteTagIsAncestorOfHead) {
      throw new Error("The published version tag is not an ancestor of HEAD.");
    }
    if (originMain !== head) {
      throw new Error("main must match origin/main before creating a new release.");
    }
    return ReleaseState.COMPLETE;
  }

  if (remoteTagCommit && !npmPublished) {
    if (remoteTagCommit !== head) {
      throw new Error(
        "The unpublished remote tag does not point to HEAD; refusing to publish different code.",
      );
    }
    if (originMain !== head) {
      throw new Error("The tagged release commit must be present on origin/main.");
    }
    return ReleaseState.TAG_PUSHED_NOT_PUBLISHED;
  }

  if (!remoteTagCommit && npmPublished) {
    if (localTagCommit !== head) {
      throw new Error(
        "npm has this version, but no matching local tag points to HEAD.",
      );
    }
    if (originMain !== head && !originMainIsAncestorOfHead) {
      throw new Error("origin/main is not an ancestor of the release commit.");
    }
    return ReleaseState.PUBLISHED_NOT_PUSHED;
  }

  if (localTagCommit !== head) {
    throw new Error(
      "The current version exists neither on npm nor as a release tag at HEAD. " +
        "Refusing to guess whether it should be published or bumped.",
    );
  }
  if (originMain !== head && !originMainIsAncestorOfHead) {
    throw new Error("origin/main is not an ancestor of the local release commit.");
  }
  return ReleaseState.LOCAL_RELEASE_NOT_PUSHED;
}
