# Pheebs docs

| Doc | What it is |
| --- | --- |
| [architecture.md](./architecture.md) | How an agent event becomes a stored row: the pipeline, the event envelope, where the contract and a Layer 2 consumer fit. Start here. |
| [backend-contract.md](./backend-contract.md) | What a compliant backend must do. Failure semantics and reasoning behind [`openapi.yaml`](../openapi.yaml). |
| [ai-proficiency-model.md](./ai-proficiency-model.md) | The consumer lens: what the captured facts are read as. A model built on Pheebs, never a driver of its schema. |
| [ai-proficiency-model-practice-and-signal-registry.md](./ai-proficiency-model-practice-and-signal-registry.md) | Practice-by-practice registry of what is measurable today, against a stated released version. |
| [spike-findings-ledger.md](./spike-findings-ledger.md) | Living record of verified findings about agent hook payloads and vendor behavior. Check it before re-investigating one. |
| [documentation-rules.md](./documentation-rules.md) | Where every doc lives and what each one owns. |

Project-level docs live at the repo root: [README](../README.md),
[CONTRIBUTING](../CONTRIBUTING.md), [SECURITY](../SECURITY.md),
[PRIVACY](../PRIVACY.md), [AGENTS](../AGENTS.md).
