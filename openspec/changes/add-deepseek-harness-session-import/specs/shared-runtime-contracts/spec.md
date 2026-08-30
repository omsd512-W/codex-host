## ADDED Requirements

### Requirement: DeepSeek Native Session link contracts are fixed and browser-safe

Shared Contracts SHALL export strict browser-safe Runtime Schemas for the fixed DeepSeek candidate-list and Native Session link methods. Params and results SHALL contain only bounded Session identity, cwd, real display metadata, native status bits, and the resulting Host Thread ID. They MUST NOT contain a generic Harness method, DSH SDK type, Native event, Transcript, Prompt, Tool output, credential, arbitrary metadata, or undeclared field.

#### Scenario: Renderer validates candidate discovery

- **WHEN** Host returns bounded candidates with Native Session ID, absolute cwd, title or null, finite update time, blank, and running
- **THEN** Shared Contracts SHALL accept the result in a browser bundle
- **AND** it SHALL expose no DSH wire object

#### Scenario: Renderer injects candidate metadata into link

- **WHEN** link params add title, updatedAt, running, blank, Model, Thinking, Permission, preview, or another undeclared field
- **THEN** the strict link params Schema SHALL reject the request
- **AND** Host SHALL not begin provisional creation

#### Scenario: Link succeeds

- **WHEN** Host commits one linked Thread
- **THEN** the link result SHALL contain only its validated Host Thread ID
