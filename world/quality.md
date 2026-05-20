# Quality

Atlas evaluates its own outputs so future runs can notice drift, weak synthesis,
and operational failures.

## Artifact Score

Use a 1 to 5 score:

- 5: clear, grounded, attributed, and reusable
- 4: useful with minor gaps
- 3: acceptable but thin
- 2: weak, vague, or poorly attributed
- 1: empty, broken, unsupported, or misleading

## Required Checks

- Does the artifact trace to a campaign, reward set, rationale, compaction, or
  explicit system run?
- Does it preserve the Looti context boundary?
- Does it distinguish evidence from inference?
- Does it avoid claims broader than Atlas's current world supports?
- Does it create a useful next state for future Atlas runs?

## Flags

- `empty`
- `stale_data`
- `unsupported_claim`
- `low_signal`
- `format_error`

