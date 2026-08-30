## ADDED Requirements

### Requirement: DeepSeek new-task drafts can open existing Native Sessions

Renderer SHALL show a localized “打开已有会话” entry only for an unlocked new-task Composer whose selected Agent is DeepSeek Harness. The entry SHALL be hidden for Codex and every other Harness, for an existing conversation, and after submission. It SHALL be disabled when the fixed request client, DeepSeek availability, current host, or current draft cwd is unavailable.

#### Scenario: User selects DeepSeek Harness in a new task

- **WHEN** the Composer remains an unlocked default draft and DeepSeek inspection is ready
- **THEN** Renderer SHALL show the existing-Session entry without changing draft Model, Thinking, or Permission state

#### Scenario: User selects another Agent or opens a Thread

- **WHEN** the current Agent is not DeepSeek Harness or the target is a conversation
- **THEN** Renderer SHALL remove or hide the entry and invalidate its pending requests
- **AND** no other Harness behavior SHALL change

### Requirement: Existing Session Dialog is complete and accessible

Renderer SHALL use one lightweight Dialog or Popover with loading, empty, error, retry, list, selection, disabled, linking, and opening states. It SHALL support keyboard selection, Escape cancellation when safe, Tab navigation, focus restoration, status/alert semantics, and a disabled confirm action until one eligible candidate is selected. All user-visible copy SHALL come from the existing localization mechanism.

#### Scenario: Candidate request is loading, empty, or failed

- **WHEN** the Dialog opens and discovery is pending, returns no candidate, or fails
- **THEN** it SHALL expose the corresponding accessible state
- **AND** Retry SHALL issue a new generation without applying the older response

#### Scenario: Candidate list is ready

- **WHEN** Host returns eligible and momentarily running rows
- **THEN** the Dialog SHALL display real title fallback, update time, cwd, and Session ID
- **AND** running rows SHALL be disabled while an eligible selected row enables confirmation

#### Scenario: User cancels

- **WHEN** no link commit is in flight and the user presses Escape or closes the Dialog
- **THEN** pending discovery responses SHALL be invalidated and pending sidebar navigation SHALL be aborted
- **AND** focus SHALL return to the entry that opened it

### Requirement: Link results are generation-scoped and open the exact Thread

Renderer SHALL bind each list/link/navigation operation to the mounted Composer identity, default target, selected DeepSeek Agent, active Host ID, captured cwd, selected Native Session ID, and monotonically increasing generation. A result that no longer matches all values MUST be ignored. A current successful result SHALL wait for the matching Host-qualified standard sidebar row and open exactly the returned Host Thread ID.

#### Scenario: Link succeeds for the current draft

- **WHEN** Host returns a valid Thread ID and the Composer context remains unchanged
- **THEN** Renderer SHALL open that exact Thread after its standard sidebar row appears
- **AND** existing ownership inspection SHALL restore the Host-confirmed Native configuration

#### Scenario: Link response becomes stale

- **WHEN** Agent, Composer, target, Host, cwd, selection, generation, or extension lifetime changes before response or navigation
- **THEN** Renderer SHALL not open any Thread from that response
- **AND** a durably linked Thread MAY remain available in the standard list

#### Scenario: Duplicate confirmation occurs

- **WHEN** the user activates confirmation repeatedly while one link is pending
- **THEN** Renderer SHALL send at most one link Request for that generation
- **AND** the action and close/cancel controls SHALL remain disabled until it settles
