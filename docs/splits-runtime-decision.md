# Splits Runtime Decision

Atlas uses two different Splits concepts:

1. **Looti campaign payout Split**
   - The Split-backed contract that holds a campaign budget.
   - Looti later updates recipients and distributes rewards.
   - Existing Looti code uses `@0xsplits/splits-sdk` / `SplitV2Client` for this.

2. **Atlas treasury**
   - The account that pays for campaign budgets.
   - This can be a plain EOA hot wallet for V0, or a Splits Personal/Treasury
     smart account for safer automation.

## What `splits.org/llms.txt` Says

Splits recommends `@splits/splits-cli` and its MCP server as the primary agent
interface for Splits Personal/Treasury accounts:

```bash
npx @splits/splits-cli@latest --llms-full
```

The CLI/MCP model is designed so agents do not hold seed phrases, private keys,
or env-var secrets. Instead, the human grants the agent scoped signer authority
on a Splits account.

## Current CLI Surface

The CLI supports:

- listing and managing Splits accounts
- registering EOA signers
- adding/removing signers
- creating transfer proposals
- creating custom raw EVM transaction proposals
- locally signing pending multisig transactions with an imported/local EOA key

The CLI is best for operating a Splits Personal/Treasury smart account.

## Decision

Atlas should support two treasury modes.

### Preferred Production Mode: Splits Treasury/Personal

Use when Atlas treasury is a Splits smart account.

Flow:

1. Human creates or configures a Splits Personal/Treasury account.
2. Human grants Atlas scoped signing authority.
3. Atlas uses `@splits/splits-cli` or MCP to propose/sign bounded transfers.
4. Treasury transfer funds the Looti campaign payout Split.

Benefits:

- Atlas does not need a raw treasury private key.
- Authority is revocable and scoped.
- Activity is auditable in Splits.

Required env:

```bash
SPLITS_API_KEY=
ATLAS_TREASURY_ACCOUNT_ADDRESS=
```

### V0 Hot Wallet Mode

Use only for early small-budget testing.

Flow:

1. Atlas uses a dedicated low-balance EOA hot wallet.
2. Atlas creates the Looti-compatible Pull Split with the open-source Splits SDK.
3. Atlas transfers the campaign token to the created Split.
4. Atlas calls Looti activate with the funded Split metadata.

Benefits:

- Simple to test.
- Matches Looti's existing frontend contract flow.

Risks:

- Atlas runtime holds a private key.
- Must keep balances low and require explicit live mode.

Required env:

```bash
ATLAS_TREASURY_WALLET_ADDRESS=
ATLAS_TREASURY_PRIVATE_KEY=
```

## Near-Term Path

For the first tiny campaign, hot wallet mode is acceptable if the wallet holds
only the test budget and gas.

For anything beyond early testing, move Atlas treasury to Splits Personal or
Treasury and use the CLI/MCP path so Atlas acts under scoped authority instead
of holding a raw key.
