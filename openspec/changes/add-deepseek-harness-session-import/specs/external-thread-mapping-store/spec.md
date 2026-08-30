## ADDED Requirements

### Requirement: Native Session uniqueness is atomic across Host Threads

Mapping Store SHALL serialize record mutations that consult or change global Host Thread, Native Session, Native Turn, or create-request indexes. Two different provisional Host Threads MUST NOT both durably commit the same non-subagent Native Session even when their writes begin concurrently.

#### Scenario: Concurrent links target one Native Session

- **WHEN** two different provisional Host Threads concurrently call ready commit with the same Harness and Native Session identity
- **THEN** exactly one commit SHALL become ready
- **AND** the other SHALL fail with the existing duplicate Native Session error before a conflicting durable/index state becomes authoritative

#### Scenario: Duplicate commit loses a race

- **WHEN** one concurrent commit has already installed the Native Session index
- **THEN** the losing provisional record SHALL remain removable
- **AND** enumeration, restart recovery, and every rebuilt index SHALL expose at most one ready owner
