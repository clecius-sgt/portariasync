# Recipient matching

Run the regression suite with `npm test` (Node.js 22 or later, no new dependencies).
It tests recipient extraction, name/address conflicts, OCR failures, stale responses,
and the complete set of residents bundled with the application.

## Decision rules

- Select automatically only when a complete name and its adjacent street/number
  match one unambiguous resident. Apartment/block details must also agree.
- Partial names, OCR spelling errors, missing addresses, similar residents, or
  multiple name/address blocks require explicit operator confirmation.
- An address alone or a previous sender never establishes the recipient's identity.
- A new photo clears the previous selection; late responses are ignored.
- The confirmation dialog displays the extracted name/address, candidate reasons,
  original photo, and OCR text. Its text is rendered without interpreting HTML.

## Example label

The supplied photo was tested against the application's OCR.space provider.
It reads Carlos Augusto, Rua Londres 160. In the repository's bundled residents,
that address belongs to a different person and Carlos Augusto is absent. The
correct result is a conflict requiring confirmation, not an automatic assignment.
This does not establish what is currently stored in the production database.
No resident or household relationship was added by this change.

## Optional browser test

With Playwright and Chromium available, run `node tests/browser-ocr.cjs`.
The test uses isolated browser data and intercepted API calls; it never writes
to the production server or sends notifications. Set `LABEL_IMAGE` to a local
photo and `OCRSPACE_API_KEY` to use the real OCR service instead of mocked text.
This sends that photo to OCR.space. Set `SCREENSHOT_DIR` for desktop/mobile images.
Do not commit real photos, API keys, or production data.

Browser execution was not completed in the Codex environment because downloading
Chromium timed out. Unit/workflow tests and the live photo-to-matcher test passed.

## Deploy

Deploy `index.html` and `recipient-matching.js` together. On the existing VPS,
`git pull --ff-only origin main` updates both. If Git reports local changes or
diverged branches, stop and inspect them; do not reset or discard server files.
No database migration or resident-data update is needed. Reload the page with
Ctrl+F5 and photograph the label again. These are static frontend changes, so
an already-running `node server.js` does not need restarting.
