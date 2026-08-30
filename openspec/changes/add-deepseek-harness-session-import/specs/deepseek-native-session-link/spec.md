## ADDED Requirements

### Requirement: DeepSeek Native Session candidates come only from the active profile

The DeepSeek Harness Adapter SHALL discover candidate Native Sessions only through the connected profile's validated `sessions.list` API. It SHALL expose only ordinary non-subagent Sessions whose absolute native cwd exactly matches the requested current workspace cwd. It MUST NOT scan files, parse DSH JSONL, load history to synthesize a preview, or expose Harness SDK types.

#### Scenario: Matching unmapped Sessions exist

- **WHEN** Host requests candidates for one absolute workspace cwd
- **THEN** Adapter SHALL return only list rows whose native cwd is platform-equivalent to that cwd and whose origin is not `subagent`
- **AND** Host SHALL remove every Session already referenced by a non-subagent Mapping Store record

#### Scenario: Native metadata is incomplete

- **WHEN** a list row has a missing, empty, relative, or invalid cwd or invalid Session identity
- **THEN** it SHALL not become a candidate
- **AND** a later direct link attempt SHALL fail closed

#### Scenario: Native display metadata is absent

- **WHEN** `projections.values.title` is null or absent and the protocol supplies no preview
- **THEN** the candidate SHALL report no title or preview
- **AND** Renderer SHALL use an explicit localized untitled fallback without persisting Prompt content as title

#### Scenario: Empty Native Session is listed

- **WHEN** DSH reports `blank=true` for an otherwise valid matching Session
- **THEN** it SHALL remain a legal candidate
- **AND** linking it SHALL be allowed to commit zero Turn mappings

### Requirement: Linking revalidates untrusted identity and cwd

Host SHALL treat Renderer Session ID, cwd, and metadata as untrusted. Immediately before provisional mapping creation it SHALL obtain a fresh candidate list from the current DeepSeek profile, require the exact Session identity to remain present, require its native cwd to remain exactly equal to the current workspace cwd, reject subagent or running Sessions, and require Mapping Store to report it unmapped.

#### Scenario: Session changes after discovery

- **WHEN** the selected Session disappears, changes cwd, becomes a subagent candidate, or is already mapped before link submission
- **THEN** Host SHALL reject the link without creating or changing a ready Thread
- **AND** it SHALL not call a DSH mutation API

#### Scenario: Session is running

- **WHEN** the fresh list reports the Session's native running state
- **THEN** Host SHALL reject it as retryable busy before resume
- **AND** a later native busy rejection in the check-to-resume race SHALL remain authoritative

### Requirement: Linking commits one mapping without copying Native data

Host SHALL allocate one provisional external Host Thread, resume the exact existing Native Session without create-time Model, Thinking, or Permission inputs, read its complete Snapshot, derive stable Host Turn mappings, and commit the Native Session identity plus complete mapping set before returning success. It MUST NOT copy Transcript content into Mapping Store or call DSH create, fork, delete, prompt, cancel, Model selection, Thinking selection, or Permission selection as part of linking.

#### Scenario: Existing Session links successfully

- **WHEN** resume and full Snapshot read return one valid matching Native Session
- **THEN** Host SHALL commit exactly one ready Host Thread ↔ DSH Native Session mapping
- **AND** each existing Native Turn SHALL receive one stable Host Turn ID in native order
- **AND** the result SHALL identify that Host Thread for immediate opening

#### Scenario: Existing Session has no Turns

- **WHEN** the valid resumed Snapshot contains zero Turns
- **THEN** Host SHALL commit one ready record with zero Turn mappings
- **AND** the loaded Thread SHALL accept a later Turn in the same Native Session

### Requirement: Native configuration remains authoritative

Linking SHALL preserve the existing Native Session's current Model, Thinking, Permission Mode, and history. Host and Renderer MUST NOT apply new-task defaults to the resumed Session; display and transport metadata SHALL come only from Adapter-confirmed Native state.

#### Scenario: Draft defaults differ from Native state

- **WHEN** the DeepSeek new-task draft currently shows different Model, Thinking, or Permission selections
- **THEN** link SHALL omit those values from `open(resume)`
- **AND** the opened Thread SHALL display the Session's native current values

### Requirement: Link failure rolls back Host state

Any failure during provisional creation, resume, Snapshot read, state validation, history alignment, Mapping Store commit, or runtime registration SHALL return one explicit error and SHALL leave no provisional or unusable ready Host Thread. An opened local HarnessSession SHALL be closed. The input DSH Session SHALL remain owned by DSH and codexhost SHALL invoke no Native deletion or configuration mutation.

#### Scenario: A pre-commit stage fails

- **WHEN** resume, Snapshot, alignment, carrier update, or ready commit fails
- **THEN** Host SHALL close the local Session handle and remove the provisional mapping
- **AND** it SHALL emit no `thread/started`

#### Scenario: Registration fails after durable commit

- **WHEN** runtime registration fails after the ready record was committed
- **THEN** Host SHALL close the local Session, remove the ready record, and return failure
- **AND** it SHALL not delete or rewrite DSH Native history

### Requirement: Linked Threads use standard recovery and history reconciliation

A linked ready record SHALL participate in the standard external `thread/list`, `thread/read`, `thread/resume`, continuation, delete, and cold-recovery paths. Reopening SHALL reuse persisted Host Turn IDs for unchanged Native Turn identities and SHALL allocate new Host Turn IDs for Native Turns added outside codexhost.

#### Scenario: codexhost restarts after linking

- **WHEN** Mapping Store reloads a linked ready record
- **THEN** standard `thread/list` SHALL show its metadata without opening DSH
- **AND** opening it SHALL resume the exact Native Session and restore complete history

#### Scenario: DSH adds Turns after linking

- **WHEN** a later Native Snapshot contains additional Turn identities
- **THEN** existing Turn mappings SHALL remain stable
- **AND** the cold-recovery alignment SHALL append mappings for the new Native Turns in authoritative order

#### Scenario: Linked Thread is deleted

- **WHEN** Desktop deletes the Host Thread
- **THEN** Host SHALL remove its Mapping Store record and close the local Session handle
- **AND** it SHALL not delete the DSH Native Session or Transcript

### Requirement: Locked DSH protocol limitations remain explicit

The implementation SHALL treat `sessions.list.running` as a momentary native status rather than an attachment lease and SHALL use later native resume results as authoritative. Because rc.2 has no close/delete/detach or byte-preserving attach API, codexhost SHALL claim only that it issues no Native mutation command during linking; it MUST NOT claim that DSH's own cold-resume bookkeeping writes can never occur.

#### Scenario: Running state changes after final list

- **WHEN** the Session becomes busy after the fresh list but before native resume
- **THEN** the native failure SHALL abort and roll back Host linking
- **AND** Host SHALL not infer or persist an attached state

#### Scenario: DSH resumes a cold Session

- **WHEN** DSH internally persists its own `session/end-seed` bookkeeping while serving resume
- **THEN** codexhost SHALL neither interpret that marker as copied Transcript nor claim byte-for-byte Native immutability
- **AND** it SHALL still issue no create/delete/configuration mutation for the input Session
