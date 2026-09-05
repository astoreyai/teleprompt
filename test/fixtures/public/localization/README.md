# Actual localized application messages

The Arabic and Hebrew inputs are the existing newt library translations of its Cancel button, extracted verbatim from the installed production gettext catalogs. They were not authored for this test. `provenance.json` identifies the package version, source catalog hashes and timestamps, exact message selection, output hashes, and LGPL-2.0 attribution. The license is in `COPYING`.

French and Russian word-count tests read the installed TypeScript production diagnostic catalogs directly; package-lock.json pins that dependency. The selected messages contain French apostrophes and Cyrillic text. Tests specify manually counted word totals rather than deriving expected values with the application's word-matching expression.
