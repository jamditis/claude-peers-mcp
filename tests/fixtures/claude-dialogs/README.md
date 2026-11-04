# Captured dialog text

These screens were captured from an isolated Claude Code 2.1.318 session with tmux on Linux. The questions, answers and command text are synthetic. The permission recordings stop before approval.

`question-select.txt` and `question-text.txt` use `tmux capture-pane -p` at 110 columns by 38 rows. `question-80.txt` uses `tmux capture-pane -p -J` at 80 columns by 38 rows. The two-question and edit-permission fixtures also use `tmux capture-pane -p -J` at 80 columns by 38 rows. The remaining open dialogs use `tmux capture-pane -p -J` at 110 columns by 38 rows. Each open fixture contains the dialog region through the bottom of the visible pane. The multi-select review screen has no keyboard footer, so its final confirmation controls are a separate signature.

The closed fixtures contain the transcript result and ordinary input prompt after cancelling the question or permission dialog. Machine-specific status bars are cropped out. They confirm that text about a completed dialog does not defer later delivery.

`delivery.test.ts` passes these recordings through the real delivery path and substitutes only the tmux process boundary. The queue test uses real SQLite and the production lease, queue and failed-push functions.

The installed 2.1.318 footer renderer also supplies the optional non-NORMAL Vim mode prefix and cancel hint. One test applies those independently observed variants to a captured two-question screen.

`question-two-text-80.txt` records an application-written line break in the keyboard hint while the free-text option has focus. `permission-fetch.txt` records a WebFetch permission screen with no keyboard footer. Both use `tmux capture-pane -p -J` at 80 columns by 38 rows.

Auto-mode hidden-index variants are derived from these recorded permission controls and the installed renderer's `inPlaceOfClassifier`, `hideIndexes` and default-to-No branches. They are labelled source-derived tests, not additional live recordings.
