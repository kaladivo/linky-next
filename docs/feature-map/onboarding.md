# Onboarding

Scope: First-run account creation, restore, profile setup, language, and backup prompt.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `onboarding.choose-language` | Language | Lets user choose Czech or English before account setup. | First run | Preference carries into the app. |
| `onboarding.create-account` | New account | Starts identity creation. | First run | Leads to profile setup. |
| `onboarding.restore-account` | Returning user | Accepts backup words and restores the account. | First run | Shows word count, invalid words, and suggestions while typing. |
| `onboarding.setup-profile` | Profile setup | Sets name and avatar before app entry. | New account | Publishes initial profile metadata. |
| `onboarding.customize-avatar` | Generated avatar | Allows deterministic avatar customization. | Profile setup | Uploading a custom photo is available during first run but optional. |
| `onboarding.backup-prompt` | Backup prompt | Encourages saving backup words. | Profile setup | Strongly prompts but never blocks app entry. Saving into a password manager is supported in the PoC. |

## Flows

- `onboarding.create-account`: new account, derive identity, set up profile, save/prompt backup, enter app.
- `onboarding.restore-account`: enter or paste words, validate, derive identity, enter app.

## Contracts

- Restore must be forgiving about separators and pasted input.
- Account creation must not create an identity the user cannot recover.
- Saving the backup is strongly prompted but never a blocking gate.

## Open Questions

- None.
