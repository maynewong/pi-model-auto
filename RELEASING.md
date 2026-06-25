# Releasing

This package ships from one source tree to two channels: npm (`npm:pi-model-auto`)
and git (`git:github.com/maynewong/pi-model-auto`). One version bump feeds both.

One-shot from a clean `main`:

```bash
npm run release        # version patch -> push commit + tag -> npm publish
```

`release` runs `npm version patch`, which bumps `version`, commits, and creates a
`vX.Y.Z` git tag; `git push --follow-tags` publishes the tag for git installers;
`npm publish` ships to npm. `prepublishOnly` runs `typecheck` and the test suite
first, so a failing build blocks the publish.

For a minor or major release, bump by hand and reuse the rest:

```bash
npm version minor      # or: major
git push --follow-tags
npm publish
```

Check what npm will ship before the first publish:

```bash
npm publish --dry-run  # lists the files in the tarball
```

The `files` allowlist in `package.json` limits the tarball to the four runtime
modules plus `README.md` and `LICENSE`; tests and config stay out.

After release, users on either channel update with `pi update --extensions`. npm
installs move by semver; git installs pinned to a tag stay put until the user
installs a newer tag.
