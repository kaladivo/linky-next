# Onboarding

Scope: First-run account creation, restore, profile setup, language, and backup prompt.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `onboarding.choose-language` | Language | Lets user choose Czech or English before account setup. | First run | Preference carries into app. |
| `onboarding.create-account` | New account | Starts identity creation. | First run | Leads to profile setup. |
| `onboarding.restore-account` | Returning user | Accepts backup words and restores identity. | First run | Shows word count, invalid words, and suggestions. |
| `onboarding.setup-profile` | Profile setup | Sets name and avatar before app entry. | New account | Publishes initial profile metadata. |
| `onboarding.customize-avatar` | Generated avatar | Allows deterministic avatar customization. | Profile setup | Also supports uploaded photo. |
| `onboarding.backup-prompt` | Backup prompt | Encourages saving backup words. | Profile setup | Password manager save is supported in PoC. |

## Flows

- `onboarding.create-account`: new account, derive identity, choose profile, save/prompt backup, enter app.
- `onboarding.restore-account`: enter or paste words, validate, derive identity, enter app.

## Contracts

- Restore must be forgiving about separators and pasted input.
- Account creation should not create an identity the user cannot recover.

## Open Questions

- Should onboarding block until backup is saved or only strongly prompt?
- Should uploaded profile photos be part of first-run setup or profile edit only?
