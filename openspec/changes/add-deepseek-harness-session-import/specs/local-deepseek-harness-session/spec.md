## MODIFIED Requirements

### Requirement: Session visibility is explicit and mapping-driven

codexhost SHALL list and restore DeepSeek Native Sessions as standard Threads only when they are referenced by persisted external Thread records. A Session created by codexhost MAY enter Mapping Store through the normal create flow; a pre-existing ordinary DSH Session MAY enter Mapping Store only after the user invokes the explicit “打开已有会话” flow and Host successfully validates and commits a one-to-one Native Session link. Unlinked DSH Sessions MUST NOT appear in standard `thread/list` or be claimed as codexhost ownership.

#### Scenario: DSH contains older official Sessions

- **WHEN** the local DSH store contains Sessions created outside codexhost
- **THEN** matching unmapped ordinary Sessions MAY appear only in the explicit DeepSeek candidate Dialog
- **AND** they SHALL NOT appear in standard codexhost Thread lists until one is explicitly linked

#### Scenario: User links one existing DSH Session

- **WHEN** Host commits a validated ready mapping for the selected Native Session
- **THEN** that Session SHALL appear as one ordinary external Codex Thread
- **AND** all other unmapped DSH Sessions SHALL remain outside standard ownership

#### Scenario: codexhost restarts

- **WHEN** Mapping Store contains created and explicitly linked DeepSeek Native Session references while DSH contains additional Sessions
- **THEN** codexhost SHALL restore only the mapped Sessions through their exact Native IDs
- **AND** shall not enumerate additional DSH Sessions into standard Thread ownership
