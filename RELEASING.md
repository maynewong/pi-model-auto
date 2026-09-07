# Releasing

This package ships from one source tree to two channels: npm (`npm:pi-model-auto`)
and git (`git:github.com/maynewong/pi-model-auto`). One version bump feeds both.

## Safe release flow

Always inspect the release state first:

```bash
npm run release:check
```

Then run the release:

```bash
npm run release
```

The release command is resumable. It checks the current `package.json` version
against the local tag, the tag on `origin`, and the exact npm version before it
decides whether to bump.

- If git and npm both contain the current version, it runs the quality gates,
  bumps the patch version, pushes the commit and tag, and publishes to npm.
- If the tag was pushed but npm publish failed, it republishes the current
  version without bumping.
- If npm publish succeeded but the git push did not, it pushes the current
  release without bumping.
- If a local `npm version` commit/tag exists but neither remote step completed,
  it pushes and publishes that current version without bumping.
- If the state is ambiguous or unsafe, it stops instead of guessing.

The command also requires a clean `main` branch. Registry/network failures are
not interpreted as “version missing”; only an npm 404 permits a publish path.
`release:check` fetches `origin/main` and tags so its report uses current remote
state, but it does not modify the working tree, create versions, push, or publish.

`prepublishOnly` still runs `typecheck`, tests, and the build immediately before
every npm publish. A normal new release runs the same gates before changing the
version as well, so predictable failures happen before a commit or tag is made.

If npm requires two-factor authentication, the publish step may stop with
`EOTP`. Run the release again with a fresh code; it will detect the already-pushed
tag and retry only `npm publish`, without creating another version:

```bash
npm run release -- --otp=123456
```

The script masks the OTP in its command log. You can also publish manually with
`npm publish --otp=<code>`.

## Minor or major releases

Create the desired version commit/tag locally, then use the resumable release
command:

```bash
npm run prepublishOnly
npm version minor      # or: major
npm run release:check
npm run release
```

Because the new local tag is not yet on git or npm, `npm run release` pushes and
publishes it without applying another patch bump.

## Inspecting the package

Check what npm will ship before the first publish:

```bash
npm publish --dry-run
```

The `files` allowlist in `package.json` limits the tarball to the runtime modules
plus `README.md` and `LICENSE`; tests and config stay out.

After release, users on either channel update with `pi update --extensions`. npm
installs move by semver; git installs pinned to a tag stay put until the user
installs a newer tag.
