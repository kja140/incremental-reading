# Releasing Incremental Reading Toolkit

## Before tagging

1. Confirm `manifest.json`, `package.json`, and `versions.json` contain the same release version.
2. Update `CHANGELOG.md` and verify `minAppVersion` is accurate.
3. Run `npm ci` and `npm run check`.
4. Test the release files in a dedicated Obsidian development vault using the folder `.obsidian/plugins/incremental-reading-toolkit/`.
5. Confirm Spaced Repetition card creation, review delegation, legacy migration, and topic scheduling manually.

## Create the release

Create and push an annotated tag that exactly matches the version in `manifest.json`:

```bash
git tag -a 1.0.2 -m "1.0.2"
git push origin 1.0.2
```

The release workflow verifies the repository and creates a draft GitHub release containing `main.js`, `manifest.json`, and `styles.css`. Review its generated notes, then publish it.

## Submit the first release

1. Make sure the default branch and the published GitHub release both contain the same manifest version.
2. Sign in at [community.obsidian.md](https://community.obsidian.md/), link the GitHub account that owns the repository, and choose **Plugins → New plugin**.
3. Submit `https://github.com/kja140/incremental-reading` and address all automated review feedback.

Only the initial release needs directory review. Later releases are discovered from the repository manifest and matching GitHub release tag.
