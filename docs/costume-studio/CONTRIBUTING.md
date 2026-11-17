# Contributing

Thanks for taking a look at Costume Studio. This is a small wrapper project around
the Scratch paint editor, so changes should stay focused and easy to review.

## Before you start

- Use Node.js 20 or newer (`nvm use` picks up `.nvmrc`).
- Run `npm install` once.
- Run `npm start` for the development server, `npm run build` before sending a
  change, and check the app manually in a browser.
- Do not commit `node_modules/`, `dist/`, or `.scratch/`; they are ignored.

## Guidelines

- Keep the UI consistent with the existing style in `src/styles/theme.global.css`.
- User-facing strings belong in `src/locales.js`. Add both Japanese and English
  entries. The Scratch paint editor's own messages come from `scratch-l10n`.
- Do not add Scratch logos, the Scratch Cat, or other Scratch character artwork.
  The project is unofficial and the Scratch marks are covered by `TRADEMARK`.
- New dependencies must be compatible with AGPL-3.0-only. Update
  `THIRD_PARTY_NOTICES.md` when you add a runtime dependency.
- Avoid adding trackers, analytics, remote uploads, or accounts. The app is meant
  to work entirely in the browser.
- Keep exports and imports working for SVG, PNG, and JPG. If you touch
  `src/lib/image.js` or `src/lib/files.js`, test a round trip in both vector and
  bitmap modes.

## Reporting issues

Please include:

- What you did, what you expected, and what happened.
- Browser and OS versions.
- The file type you were working with (SVG, PNG, or JPG) and whether the problem
  happens with the built-in sample.
- Console errors, if any.

Do not attach private artwork unless you are comfortable sharing it.

## License of contributions

By contributing, you agree that your contribution is licensed under
AGPL-3.0-only, the same license as the rest of the project.
