# Repository scripts

Cross-platform development and maintenance scripts. Run supported entry points
from the repository root:

| Command                              | Responsibility                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `npm run setup`                      | Create a missing `.env` with generated local database passwords; preserve any existing file.                                  |
| `npm run doctor`                     | Report Node/npm/Git and local configuration prerequisites; report Docker availability without requiring it for API-only work. |
| `npm run doctor -- --require-docker` | Require the Docker prerequisite for upcoming database work.                                                                   |

Setup never prints generated passwords, overwrites existing configuration or
rotates database users. Doctor does not install tools, start services or certify
academic/database readiness. Use `npm run infra:up` and `npm run infra:check` for
container health and authenticated service access respectively.

Keep scripts scoped to the repository, avoid embedded credentials and keep
diagnostics free of secret values. Scripts must not stage, commit or push changes.
Any future destructive operation needs a separate, explicit command and clear
documentation. See [Local development](../docs/development/local-development.md)
for the complete setup sequence.
