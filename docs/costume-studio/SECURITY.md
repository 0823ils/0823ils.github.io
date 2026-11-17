# Security policy

Costume Studio is a static, client-side application. It has no backend, no
accounts, and does not upload artwork anywhere. The main security surface is the
browser code that parses imported SVG, PNG, and JPG files, plus the bundled
Scratch paint editor.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Instead, use GitHub's
private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include reproduction steps, affected browser versions, and a sample file if
   it is safe to share.

If private reporting is not available, contact the maintainers through the
repository's issue tracker and ask for a private channel without including the
details publicly.

## Scope

In scope:

- Crashes or arbitrary code execution caused by a crafted SVG, PNG, or JPG file.
- Cross-site scripting through imported file names, SVG content, or editor text.
- Unexpected network requests or data leakage.

Out of scope:

- Denial of service caused by intentionally huge files beyond the documented
  15 MB import limit.
- Issues in browsers or in upstream Scratch packages that also affect the
  upstream project. Please report those upstream as well.
- Social engineering or physical access.

## Supported versions

The latest commit on `main` is the supported version. This is a small project, so
fixes are applied to the current code rather than backported to older tags.
