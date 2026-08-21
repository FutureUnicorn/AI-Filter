# Evaluations

Evaluations are separate from deterministic unit and integration tests because model-quality checks may use datasets, incur provider cost, and produce non-deterministic results.

- Use synthetic or explicitly approved data; never copy production candidate data here.
- Keep deterministic citation and contract validation in normal tests.
- Standard AF-10 validation must not require model/provider credentials.
- Real evidence-quality and prompt-injection evaluation cases belong to later tickets.
