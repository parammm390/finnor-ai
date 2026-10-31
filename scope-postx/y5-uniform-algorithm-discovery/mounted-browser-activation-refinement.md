# U1 activation refinement, before revised orchestration

The third installed episode's first browser orchestration failed its 25-second
login predicate. Native inputs contained the expected disposable values, but
plain-button activation did not promptly advance the page. The failure is
retained. A rendered form-button DOM click subsequently reached the real
Supabase SDK and the authenticated Centropy screen.

The revised orchestrator may activate the uniquely identified rendered button
with its native DOM `click()` method after a successful visible-pane keyboard
guard. This is an explicitly classified DOM interaction, not keyboard-only
or visual qualification. It must not call application controllers, the SDK,
React state, backend handlers, or replace a response. Inputs still use normal
browser controls. Fresh accessibility snapshots identify every button.

An explicitly requested authenticated continuation may use that already
observed real SDK session. The actual private Work route and canonical owner
binding must still pass. No token or session is injected. Each orchestration
attempt has a separate retained report and ten-minute command bound; the
original owner episode, phase deadlines, counters, grants and effects remain
unchanged. All failed attempts remain failures and charge preparation.
